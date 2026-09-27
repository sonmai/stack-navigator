import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { NavState, StackBranch } from './core';
import { ReviewPr, Reviews, ReviewThread, safeReviewPath, snapshotAnchor } from './reviews';

interface PrNode { kind: 'pr'; root: string; branch: StackBranch; data?: ReviewPr; error?: string; loading?: boolean }
interface ThreadNode { kind: 'thread'; pr: PrNode; thread: ReviewThread }
interface ThreadTarget { root: string; prUrl: string; threadId: string }
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
  private pending = new Map<PrNode, { promise: Promise<Node[]>; resolve: (nodes: Node[]) => void; signal: AbortSignal }>();
  private queue: PrNode[] = [];
  private activeLoads = 0;
  private thread?: vscode.CommentThread;
  private opening = false;
  private disposed = false;
  private serial = 0;
  private autoOpenAttempted = false;

  constructor(private readonly navigate: Navigate, private readonly titleFor: (url: string) => string | undefined = () => undefined,
    private readonly workspaceState?: vscode.Memento, refreshStack?: () => Promise<void>) {
    this.view = vscode.window.createTreeView('stacknav.overview', { treeDataProvider: this });
    this.disposables.push(this.view, this.controller, this.changed,
      vscode.workspace.registerTextDocumentContentProvider('stacknav-review', {
        provideTextDocumentContent: uri => this.documents.get(uri.toString()) ?? ''
      }),
      vscode.commands.registerCommand('stacknav.refreshOverview', async () => {
        const previousKey = this.key;
        await refreshStack?.();
        // A different stack already starts its own prefetch in update().
        if (this.key === previousKey) { this.refresh(); }
      }),
      vscode.commands.registerCommand('stacknav.openReviewThread', (target: ThreadTarget) => this.open(target)),
      vscode.workspace.onDidCloseTextDocument(doc => {
        if (doc.uri.scheme === 'stacknav-review') { this.documents.delete(doc.uri.toString()); }
      }));
    this.view.message = 'Open a local stack to see its PRs and review threads.';
  }

  update(root: string | undefined, state: NavState): void {
    const branches = state.type === 'loaded' || state.type === 'trunk' ? state.stack.branches : [];
    const current = branches.find(branch => branch.isCurrent)?.name ?? '';
    if (this.currentBranch !== current && !this.opening) { this.thread?.dispose(); this.thread = undefined; }
    this.currentBranch = current;
    const key = JSON.stringify([root, branches.map(b => [b.name, b.pr?.url])]);
    if (key === this.key) {
      this.nodes.forEach(node => { node.branch = branches.find(b => b.name === node.branch.name)!; });
      this.queue.sort((a, b) => Number(b.branch.isCurrent) - Number(a.branch.isCurrent));
      this.changed.fire(undefined);
      this.updateMessage(state);
      return;
    }
    this.key = key;
    this.cancelLoads();
    this.thread?.dispose(); this.thread = undefined;
    this.nodes = root ? branches.filter(b => b.pr).reverse().map(branch => ({ kind: 'pr', root, branch })) : [];
    this.updateMessage(state);
    this.changed.fire(undefined);
    this.prefetch();
    void this.openInitially();
  }

  private updateMessage(state: NavState): void {
    this.view.message = this.nodes.length
      ? 'Click a review thread to check out its branch and open code.'
      : state.type === 'error' ? state.message
      : state.type === 'stacks' ? 'Multiple stacks found. Run Stack Navigator: Select Stack… to choose one.'
      : state.type === 'unloaded' ? `Run Stack Navigator: Load Stack for Current PR to load #${state.pr.number}.`
      : 'No local stack found in this repository. Run Stack Navigator: Refresh to retry.';
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
    this.cancelLoads();
    this.nodes.forEach(node => { node.error = undefined; });
    this.prefetch();
    this.changed.fire(undefined);
  }

  private cancelLoads(): void {
    this.reads.abort(); this.reads = new AbortController();
    for (const [node, job] of this.pending) { node.loading = false; job.resolve(this.children(node)); }
    this.pending.clear(); this.queue = [];
  }

  private children(node: PrNode): Node[] {
    return node.data?.threads.map(thread => ({ kind: 'thread', pr: node, thread })) ?? [];
  }

  private prefetch(): void {
    for (const node of [...this.nodes].sort((a, b) => Number(b.branch.isCurrent) - Number(a.branch.isCurrent))) {
      this.enqueue(node);
    }
    this.pump();
  }

  private enqueue(node: PrNode): Promise<Node[]> {
    const existing = this.pending.get(node);
    if (existing) { return existing.promise; }
    let complete!: (nodes: Node[]) => void;
    const promise = new Promise<Node[]>(resolve => { complete = resolve; });
    this.pending.set(node, { promise, resolve: complete, signal: this.reads.signal });
    node.loading = true;
    this.queue.push(node);
    return promise;
  }

  private pump(): void {
    while (!this.disposed && this.activeLoads < 2 && this.queue.length) {
      const node = this.queue.shift()!;
      const job = this.pending.get(node)!;
      this.activeLoads++;
      void (async () => {
        try {
          const data = await this.reviews.read(node.root, node.branch.pr!.url, job.signal, true);
          if (!job.signal.aborted) { node.data = data; node.error = undefined; }
        } catch (error) {
          if (!job.signal.aborted) { node.error = String(error); }
        } finally {
          this.activeLoads--;
          if (this.pending.get(node) === job) {
            this.pending.delete(node); node.loading = false;
            job.resolve(this.children(node)); this.changed.fire(node);
          }
          this.pump();
        }
      })();
    }
  }

  getParent(node: Node): Node | undefined {
    return node.kind === 'thread' ? node.pr : undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'pr') {
      const item = new vscode.TreeItem(`#${node.branch.pr!.number} ${node.data?.title ?? this.titleFor(node.branch.pr!.url) ?? node.branch.name}`, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `${node.root}:${node.branch.pr!.url}`;
      const state = node.data?.state ?? node.branch.pr!.state;
      item.iconPath = new vscode.ThemeIcon(state === 'MERGED' ? 'git-merge'
        : state === 'CLOSED' ? 'git-pull-request-closed'
        : node.data?.reviewDecision === 'APPROVED' ? 'check'
        : node.data?.isDraft ? 'git-pull-request-draft' : 'git-pull-request');
      item.description = node.data
        ? `${node.data.isDraft ? 'DRAFT' : node.data.state} · ${node.data.reviewDecision ?? 'No review decision'} · CI: ${node.data.checks ?? 'None'} · ${node.data.threads.filter(t => !t.isResolved).length} unresolved`
        : node.branch.pr!.state;
      if (node.branch.isCurrent) { item.description = `Current · ${item.description}`; }
      item.description += node.error ? ' · Load failed: click Refresh' : node.loading ? (node.data ? ' · Updating…' : ' · Loading reviews…') : '';
      item.tooltip = node.error ?? `${node.root}\n${node.branch.name}`;
      return item;
    }
    const first = node.thread.comments[0];
    const item = new vscode.TreeItem(`${first?.author?.login ?? 'Deleted user'}: ${first?.body.replace(/\s+/g, ' ').slice(0, 110) ?? 'Review thread'}`);
    item.id = `${node.pr.root}:${node.thread.id}`;
    item.description = `${node.thread.path}${node.thread.line ? `:${node.thread.line}` : ''}${node.thread.isOutdated ? ' · outdated' : ''}`;
    item.iconPath = new vscode.ThemeIcon(node.thread.isResolved ? 'pass' : 'comment-discussion');
    item.tooltip = `${node.thread.isResolved ? 'Resolved' : 'Unresolved'} · ${node.thread.commentCount ?? node.thread.comments.length} comments\nClick to check out ${node.pr.branch.name} and open this thread.`;
    item.command = { command: 'stacknav.openReviewThread', title: 'Open Review Thread', arguments: [{
      root: node.pr.root, prUrl: node.pr.branch.pr!.url, threadId: node.thread.id
    } satisfies ThreadTarget] };
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) { return this.nodes; }
    if (node.kind === 'thread') { return []; }
    if (!this.nodes.includes(node)) { return []; }
    const index = this.queue.indexOf(node);
    if (index >= 0) { this.queue.splice(index, 1); this.queue.unshift(node); }
    if (node.data) { return this.children(node); }
    if (node.error) { return []; }
    const promise = this.enqueue(node);
    this.pump();
    return promise;
  }

  private async open(target: ThreadTarget): Promise<void> {
    if (this.opening) { return; }
    // Commands can outlive a tree refresh. Resolve stable IDs against the current tree,
    // instead of silently dropping clicks when their cached node object was replaced.
    const pr = this.nodes.find(node => node.root === target?.root && node.branch.pr?.url === target.prUrl);
    const selected = pr?.data?.threads.find(thread => thread.id === target.threadId);
    if (!pr || !selected) {
      void vscode.window.showWarningMessage('This review item is no longer available. Refresh the overview and select the comment again.');
      return;
    }
    const node: ThreadNode = { kind: 'thread', pr, thread: selected };
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
        const fresh = await this.reviews.readThread(node.pr.root, node.pr.branch.pr!.url, node.thread.id);
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
    let document: vscode.TextDocument | undefined;
    let line = 0;
    let reason = 'Workspace file · PR line; local edits may shift its position';
    if (checkout) {
      try {
        const root = await realpath(node.root);
        const path = await realpath(resolve(root, thread.path));
        const child = relative(root, path);
        if (child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)) {
          document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
          const targetLine = thread.isOutdated ? thread.originalLine : thread.line;
          line = targetLine && Number.isSafeInteger(targetLine) && targetLine > 0 ? targetLine - 1 : 0;
          if (thread.isOutdated) { reason = 'Workspace file · Outdated comment; original line may have moved'; }
          else if (thread.diffSide === 'LEFT') { reason = 'Workspace file · Old-side comment; line is approximate'; }
          if (!targetLine) { reason += ' · No line reference; showing file from start'; }
        }
      } catch { /* Missing or renamed local files use the pinned snapshot. */ }
    }
    if (!document) {
      const anchor = snapshotAnchor(pr, thread);
      let text: string | undefined;
      reason = 'Original diff excerpt (not a full file)';
      if (anchor) {
        try { text = await this.reviews.content(node.root, node.branch.pr!.url, anchor.sha, thread.path); }
        catch { reason = 'Revision unavailable; showing original diff excerpt'; }
      }
      line = text !== undefined && anchor ? anchor.line - 1 : 0;
      const excerpt = text === undefined;
      const content = text ?? `# ${reason}\n# ${thread.path} · ${thread.diffSide} side\n\n${thread.comments[0]?.diffHunk || '(No code excerpt available for this thread.)'}`;
      const uri = vscode.Uri.from({ scheme: 'stacknav-review', path: `/${++this.serial}/${thread.path}${excerpt ? '.diff' : ''}` });
      this.documents.set(uri.toString(), content);
      document = await vscode.workspace.openTextDocument(uri);
      reason = `${checkout ? 'Workspace file unavailable' : 'Checkout not completed'} · ${excerpt ? reason : 'Read-only PR revision'}`;
    }
    if (this.disposed) { return; }
    if (line >= document.lineCount) { line = 0; reason += ' · Line unavailable; showing file from start'; }
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
    this.disposed = true; this.cancelLoads(); this.reads.abort(); this.thread?.dispose(); this.documents.clear();
    this.disposables.forEach(d => d.dispose());
  }
}
