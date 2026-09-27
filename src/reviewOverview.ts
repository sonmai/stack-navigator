import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { NavState, StackBranch } from './core';
import { ReviewPr, Reviews, ReviewThread, safeReviewPath, snapshotAnchor } from './reviews';

interface PrNode { kind: 'pr'; root: string; branch: StackBranch; data?: ReviewPr; error?: string }
interface ThreadNode { kind: 'thread'; pr: PrNode; thread: ReviewThread }
type Node = PrNode | ThreadNode;
type Navigate = (root: string, action: () => Promise<void>) => Promise<void>;

export class ReviewOverview implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly reviews = new Reviews();
  private readonly controller = vscode.comments.createCommentController('stacknav.review', 'Stack Navigator Preview');
  private readonly documents = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly view: vscode.TreeView<Node>;
  private nodes: PrNode[] = [];
  private key = '';
  private currentBranch = '';
  private reads = new AbortController();
  private pending = new Map<PrNode, Promise<Node[]>>();
  private thread?: vscode.CommentThread;
  private opening = false;
  private disposed = false;
  private serial = 0;
  private autoOpenAttempted = false;

  constructor(private readonly navigate: Navigate, private readonly titleFor: (url: string) => string | undefined = () => undefined,
    private readonly workspaceState?: vscode.Memento) {
    this.view = vscode.window.createTreeView('stacknav.overview', { treeDataProvider: this });
    this.disposables.push(this.view, this.controller, this.changed,
      vscode.workspace.registerTextDocumentContentProvider('stacknav-review', {
        provideTextDocumentContent: uri => this.documents.get(uri.toString()) ?? ''
      }),
      vscode.commands.registerCommand('stacknav.refreshOverview', () => this.refresh()),
      vscode.commands.registerCommand('stacknav.openReviewThread', (node: ThreadNode) => this.open(node)),
      vscode.workspace.onDidCloseTextDocument(doc => {
        if (doc.uri.scheme === 'stacknav-review') { this.documents.delete(doc.uri.toString()); }
      }));
    this.view.message = 'Open a local stack to see its PRs. Expand a PR to load review threads.';
  }

  update(root: string | undefined, state: NavState): void {
    const branches = state.type === 'loaded' || state.type === 'trunk' ? state.stack.branches : [];
    const current = branches.find(branch => branch.isCurrent)?.name ?? '';
    if (this.currentBranch !== current && !this.opening) { this.thread?.dispose(); this.thread = undefined; }
    this.currentBranch = current;
    const key = JSON.stringify([root, branches.map(b => [b.name, b.pr?.url])]);
    if (key === this.key) {
      this.nodes.forEach(node => { node.branch = branches.find(b => b.name === node.branch.name)!; });
      this.changed.fire(undefined);
      return;
    }
    this.key = key;
    this.reads.abort(); this.reads = new AbortController(); this.pending.clear();
    this.thread?.dispose(); this.thread = undefined;
    this.nodes = root ? branches.filter(b => b.pr).map(branch => ({ kind: 'pr', root, branch })) : [];
    this.view.message = this.nodes.length
      ? 'Preview: expand a PR to load reviews. Click a thread to check out its branch and open code.'
      : 'Open a local stack to see its PRs. For multiple stacks on trunk, select a stack first.';
    this.changed.fire(undefined);
    void this.openInitially();
  }

  private async openInitially(): Promise<void> {
    if (this.disposed || !this.nodes.length || this.autoOpenAttempted ||
      this.workspaceState?.get<boolean>('stacknav.overviewShown', false)) { return; }
    this.autoOpenAttempted = true;
    try {
      // Revealing a root makes the container visible without expanding/loading its reviews or taking editor focus.
      await this.view.reveal(this.nodes[0], { focus: false, select: false, expand: false });
      await this.workspaceState?.update('stacknav.overviewShown', true);
    } catch { /* A disposed/hidden view must not break stack navigation; retry on the next activation. */ }
  }

  private refresh(): void {
    this.reads.abort(); this.reads = new AbortController(); this.pending.clear();
    this.nodes.forEach(node => { node.data = undefined; node.error = undefined; });
    this.changed.fire(undefined);
  }

  getParent(node: Node): Node | undefined {
    return node.kind === 'thread' ? node.pr : undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'pr') {
      const item = new vscode.TreeItem(`#${node.branch.pr!.number} ${node.data?.title ?? this.titleFor(node.branch.pr!.url) ?? node.branch.name}`, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `${node.root}:${node.branch.pr!.url}`;
      item.iconPath = new vscode.ThemeIcon(node.branch.isCurrent ? 'check' : 'git-pull-request');
      item.description = node.error ? 'Load failed: click Refresh' : node.data
        ? `${node.data.isDraft ? 'DRAFT' : node.data.state} · ${node.data.reviewDecision ?? 'No review decision'} · CI: ${node.data.checks ?? 'None'} · ${node.data.threads.filter(t => !t.isResolved).length} unresolved`
        : `${node.branch.pr!.state} · expand to load reviews`;
      item.tooltip = node.error ?? `${node.root}\n${node.branch.name}`;
      return item;
    }
    const first = node.thread.comments[0];
    const item = new vscode.TreeItem(`${first?.author?.login ?? 'Deleted user'}: ${first?.body.replace(/\s+/g, ' ').slice(0, 110) ?? 'Review thread'}`);
    item.id = `${node.pr.root}:${node.thread.id}`;
    item.description = `${node.thread.path}${node.thread.line ? `:${node.thread.line}` : ''}${node.thread.isOutdated ? ' · outdated' : ''}`;
    item.iconPath = new vscode.ThemeIcon(node.thread.isResolved ? 'pass' : 'comment-discussion');
    item.tooltip = `${node.thread.isResolved ? 'Resolved' : 'Unresolved'} · ${node.thread.comments.length} comments\nClick to check out ${node.pr.branch.name} and open this thread.`;
    item.command = { command: 'stacknav.openReviewThread', title: 'Open Review Thread', arguments: [node] };
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) { return this.nodes; }
    if (node.kind === 'thread') { return []; }
    if (node.error) { return []; }
    if (node.data) { return node.data.threads.map(thread => ({ kind: 'thread', pr: node, thread })); }
    if (this.pending.has(node)) { return this.pending.get(node)!; }
    const signal = this.reads.signal;
    const promise = (async (): Promise<Node[]> => {
      try {
        const data = await this.reviews.read(node.root, node.branch.pr!.url, signal);
        if (signal.aborted) { return []; }
        node.data = data; node.error = undefined;
        this.changed.fire(node);
        return data.threads.map(thread => ({ kind: 'thread', pr: node, thread }));
      } catch (error) {
        if (!signal.aborted) { node.error = String(error); this.changed.fire(node); }
        return [];
      } finally { if (!signal.aborted) { this.pending.delete(node); } }
    })();
    this.pending.set(node, promise);
    return promise;
  }

  private async open(node: ThreadNode): Promise<void> {
    if (this.opening || !this.nodes.includes(node.pr)) { return; }
    this.opening = true;
    try {
      await this.navigate(node.pr.root, async () => {
        let checkout = false;
        try {
          // Unsaved editors are not represented in Git's checkout safety checks.
          if (vscode.workspace.textDocuments.some(doc => doc.isDirty && doc.uri.scheme === 'file')) {
            throw new Error('Save or close unsaved files before switching branches.');
          }
          await this.reviews.checkout(node.pr.root, node.pr.branch.name, node.pr.branch.pr!.url);
          checkout = true;
        } catch (error) {
          const choice = await vscode.window.showWarningMessage(`Checkout stopped: ${String(error)}`, 'View read-only');
          if (choice !== 'View read-only') { return; }
        }
        const fresh = await this.reviews.read(node.pr.root, node.pr.branch.pr!.url);
        if (this.disposed || !this.nodes.includes(node.pr)) { return; }
        const thread = fresh.threads.find(t => t.id === node.thread.id);
        if (!thread) { throw new Error('This thread no longer exists. Refresh the overview.'); }
        await this.show(node.pr, fresh, thread, checkout);
      });
    } catch (error) {
      if (!this.disposed) { void vscode.window.showErrorMessage(`Stack Navigator: ${String(error)}`); }
    } finally { this.opening = false; }
  }

  private async show(node: PrNode, pr: ReviewPr, thread: ReviewThread, checkout: boolean): Promise<void> {
    if (!safeReviewPath(thread.path)) { throw new Error('Unsafe review file path.'); }
    const anchor = snapshotAnchor(pr, thread);
    let text: string | undefined;
    let reason = 'Original diff excerpt (not a full file)';
    if (anchor) {
      try { text = await this.reviews.content(node.root, node.branch.pr!.url, anchor.sha, thread.path); }
      catch { reason = 'Revision unavailable; showing original diff excerpt'; }
    }
    let document: vscode.TextDocument | undefined;
    let line = text !== undefined && anchor ? anchor.line - 1 : 0;
    if (text !== undefined && checkout && !thread.isOutdated && anchor) {
      try {
        const root = await realpath(node.root);
        const path = await realpath(resolve(root, thread.path));
        const child = relative(root, path);
        if (child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)) {
          const local = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
          if (!local.isDirty && local.getText() === text) { document = local; }
        }
      } catch { /* Missing or renamed local files use the pinned snapshot. */ }
    }
    if (!document) {
      const excerpt = text === undefined;
      const content = text ?? `# ${reason}\n# ${thread.path} · ${thread.diffSide} side\n\n${thread.comments[0]?.diffHunk || '(No code excerpt available for this thread.)'}`;
      const uri = vscode.Uri.from({ scheme: 'stacknav-review', path: `/${++this.serial}/${thread.path}${excerpt ? '.diff' : ''}` });
      this.documents.set(uri.toString(), content);
      document = await vscode.workspace.openTextDocument(uri);
      reason = excerpt ? reason : 'Read-only PR revision; local code may differ';
    } else { reason = 'Working file matches PR revision'; }
    if (this.disposed) { return; }
    if (line >= document.lineCount) { line = 0; reason = 'Line unavailable; showing revision from start'; }
    const range = new vscode.Range(line, 0, line, 0);
    this.thread?.dispose();
    this.thread = this.controller.createCommentThread(document.uri, range, thread.comments.map(comment => ({
      body: new vscode.MarkdownString(comment.body), mode: vscode.CommentMode.Preview,
      author: { name: comment.author?.login ?? 'Deleted user' }
    })));
    this.thread.canReply = false;
    this.thread.label = `#${node.branch.pr!.number} · ${reason}`;
    this.thread.state = thread.isResolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    this.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    const editor = await vscode.window.showTextDocument(document, { selection: range, preview: true });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  dispose(): void {
    this.disposed = true; this.reads.abort(); this.thread?.dispose(); this.documents.clear();
    this.disposables.forEach(d => d.dispose());
  }
}
