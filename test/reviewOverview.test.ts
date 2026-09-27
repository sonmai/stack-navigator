import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Reviews, ReviewPr } from '../src/reviews';

test('overview expands without checkout, opens selected native thread, and disposes on branch change', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'stacknav-workspace-'));
  const localRoot = join(temp, 'repo');
  await mkdir(localRoot);
  const commands = new Map<string, (...args: any[]) => any>();
  const snapshots = new Map<string, string>();
  const threads: any[] = [];
  const opened: any[] = [];
  const revealed: any[] = [];
  const persisted = new Map<string, unknown>();
  const workspaceState = { get: (key: string, fallback: unknown) => persisted.get(key) ?? fallback,
    update: async (key: string, value: unknown) => { persisted.set(key, value); } };
  let provider: any;
  class Emitter { event = () => ({ dispose() {} }); fire() {} dispose() {} }
  class Uri {
    scheme = 'stacknav-review';
    constructor(readonly path: string) {}
    toString() { return this.scheme + ':' + this.path; }
    static from(value: { path: string }) { return new Uri(value.path); }
    static file(path: string) { const uri = new Uri(path); uri.scheme = 'file'; return uri; }
  }
  const vscode = {
    EventEmitter: Emitter,
    TreeItem: class { constructor(public label: string) {} }, ThemeIcon: class { constructor(public id: string) {} },
    TreeItemCollapsibleState: { Collapsed: 1 },
    CommentMode: { Preview: 0 }, CommentThreadState: { Resolved: 1, Unresolved: 0 },
    CommentThreadCollapsibleState: { Expanded: 1 }, TextEditorRevealType: { InCenter: 1 },
    Range: class { constructor(public startLine: number) {} }, MarkdownString: class { constructor(public value: string) {} }, Uri,
    comments: { createCommentController: () => ({
      createCommentThread(uri: Uri, range: any, comments: any[]) {
        const thread = { uri, range, comments, disposed: false, dispose() { this.disposed = true; } };
        threads.push(thread); return thread;
      }, dispose() {}
    }) },
    commands: { registerCommand(name: string, action: any) { commands.set(name, action); return { dispose() {} }; } },
    workspace: {
      textDocuments: [], onDidCloseTextDocument: () => ({ dispose() {} }),
      registerTextDocumentContentProvider(_scheme: string, value: any) { provider = value; return { dispose() {} }; },
      async openTextDocument(uri: Uri) {
        const content = uri.scheme === 'file' ? await readFile(uri.path, 'utf8') : provider.provideTextDocumentContent(uri);
        snapshots.set(uri.toString(), content);
        return { uri, lineCount: content.split('\n').length, getText: () => content };
      }
    },
    window: {
      createTreeView: () => ({ reveal: async (node: any, options: any) => { revealed.push({ node, options }); }, dispose() {} }),
      showTextDocument: async (doc: any, options: any) => { opened.push({ doc, options }); return { revealRange() {} }; },
      showErrorMessage: (error: string) => { throw new Error(error); },
      showWarningMessage: async () => 'View read-only'
    }
  };
  const Module = require('node:module'), originalLoad = Module._load;
  Module._load = function(id: string, ...args: any[]) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); };
  const { ReviewOverview } = require('../src/reviewOverview');
  Module._load = originalLoad;
  const originals = { read: Reviews.prototype.read, readThread: Reviews.prototype.readThread, checkout: Reviews.prototype.checkout, content: Reviews.prototype.content };
  let checkouts = 0, reads = 0, contentReads = 0, navigationRoot = '';
  const pr: ReviewPr = { title: 'API', state: 'OPEN', isDraft: false, reviewDecision: 'CHANGES_REQUESTED', headRefOid: 'a'.repeat(40), threads: [{
    id: 'T', path: 'a.ts', line: 2, originalLine: 2, diffSide: 'RIGHT', isOutdated: true, isResolved: false,
    comments: [{ body: 'Fix this', author: { login: 'alice' }, url: '', diffHunk: '', originalCommit: { oid: 'b'.repeat(40) } }]
  }] };
  Reviews.prototype.read = async () => { reads++; return pr; };
  Reviews.prototype.readThread = async () => pr;
  Reviews.prototype.checkout = async () => { checkouts++; };
  Reviews.prototype.content = async () => { contentReads++; return 'first\nsecond\n'; };
  const overview = new ReviewOverview(async (root: string, action: () => Promise<void>) => { navigationRoot = root; await action(); }, undefined, workspaceState);
  const state: any = { type: 'loaded', index: 0, stack: { trunk: 'main', currentBranch: 'api', branches: [
    { name: 'api', isCurrent: true, pr: { number: 1, url: 'https://github.com/o/r/pull/1', state: 'OPEN' } },
    { name: 'ui', isCurrent: false, pr: { number: 2, url: 'https://github.com/o/r/pull/2', state: 'OPEN' } }
  ] } };
  try {
    overview.update(undefined, { type: 'empty' });
    assert.equal(revealed.length, 0, 'no auto-open before a stack is detected');
    overview.update('/correct-repo', state);
    const roots = await overview.getChildren();
    assert.equal(revealed.length, 1);
    assert.deepEqual(revealed[0].options, { focus: false, select: false, expand: false });
    assert.equal(overview.getParent(roots[0]), undefined);
    assert.equal(persisted.get('stacknav.overviewShown'), true);
    overview.update('/correct-repo', state);
    assert.equal(revealed.length, 1, 'refresh does not reopen the view');
    assert.equal(roots.length, 2);
    assert.deepEqual(roots.map((node: any) => node.branch.name), ['ui', 'api'], 'top layer first');
    assert.deepEqual(state.stack.branches.map((branch: any) => branch.name), ['api', 'ui'], 'navigation order is unchanged');
    const children = await overview.getChildren(roots[1]);
    assert.equal(checkouts, 0);
    await overview.getChildren(roots[1]); assert.equal(reads, 2, 'both PRs prefetched and cached when expanded again');
    const currentItem = overview.getTreeItem(roots[1]);
    assert.equal(currentItem.iconPath.id, 'git-pull-request', 'checkout does not imply approval');
    assert.match(currentItem.description, /^Current ·/);
    roots[0].data = { ...pr, reviewDecision: 'APPROVED' };
    assert.equal(overview.getTreeItem(roots[0]).iconPath.id, 'check');
    assert.doesNotMatch(overview.getTreeItem(roots[0]).description, /Current/);
    roots[1].data = { ...pr, reviewDecision: 'APPROVED' };
    assert.equal(overview.getTreeItem(roots[1]).iconPath.id, 'check');
    assert.match(overview.getTreeItem(roots[1]).description, /^Current ·/);
    roots[0].data = { ...pr, state: 'MERGED', reviewDecision: 'APPROVED' };
    assert.equal(overview.getTreeItem(roots[0]).iconPath.id, 'git-merge');
    roots[0].data = { ...pr, state: 'CLOSED' };
    assert.equal(overview.getTreeItem(roots[0]).iconPath.id, 'git-pull-request-closed');
    const target = JSON.parse(JSON.stringify(overview.getTreeItem(children[0]).command.arguments[0]));
    await commands.get('stacknav.openReviewThread')!(target);
    assert.equal(checkouts, 1);
    assert.equal(navigationRoot, '/correct-repo');
    assert.equal(threads[0].canReply, false);
    assert.equal(threads[0].collapsibleState, 1);
    assert.equal(threads[0].range.startLine, 1);
    assert.equal(threads[0].comments[0].body.value, 'Fix this');
    assert.equal(opened[0].doc.uri.scheme, 'stacknav-review', 'missing workspace file uses immutable snapshot');
    state.stack.branches[0].isCurrent = false; state.stack.branches[1].isCurrent = true;
    overview.update('/correct-repo', state);
    assert.equal(threads[0].disposed, true);
    assert.equal((await overview.getChildren())[1], roots[1], 'checkout keeps tree identity');
    assert.equal(revealed.length, 1, 'checkout does not reopen the view');
    Reviews.prototype.checkout = async () => { throw new Error('Local changes'); };
    // A command created before the tree is rebuilt must still resolve the same PR/thread.
    overview.update('/other-repo', state);
    overview.update('/correct-repo', state);
    await overview.getChildren((await overview.getChildren())[1]);
    await commands.get('stacknav.openReviewThread')!(target);
    assert.equal(opened.length, 2, 'blocked checkout can still open read-only');
    await writeFile(join(localRoot, 'a.ts'), 'local edits\nlocal second line\n');
    Reviews.prototype.checkout = async () => { checkouts++; };
    overview.update(localRoot, state);
    const localChildren = await overview.getChildren((await overview.getChildren())[1]);
    const localTarget = overview.getTreeItem(localChildren[0]).command.arguments[0];
    const openLocal = () => commands.get('stacknav.openReviewThread')!(localTarget);
    const beforeContent = contentReads;
    await openLocal();
    assert.equal(opened.at(-1).doc.uri.scheme, 'file', 'outdated comments open the workspace file');
    assert.equal(opened.at(-1).doc.uri.path, join(localRoot, 'a.ts'), 'uses the selected PR repository');
    assert.match(threads.at(-1).label, /Outdated comment/);
    assert.equal(threads.at(-1).range.startLine, 1);
    pr.threads[0].isOutdated = false;
    await openLocal();
    assert.equal(opened.at(-1).doc.getText(), 'local edits\nlocal second line\n', 'different local content is preserved');
    pr.threads[0].diffSide = 'LEFT';
    await openLocal();
    assert.match(threads.at(-1).label, /Old-side comment; line is approximate/);
    assert.equal(opened.at(-1).doc.uri.scheme, 'file');
    pr.threads[0].line = 999;
    await openLocal();
    assert.equal(threads.at(-1).range.startLine, 0);
    assert.match(threads.at(-1).label, /Line unavailable/);
    pr.threads[0].line = null;
    await openLocal();
    assert.equal(threads.at(-1).range.startLine, 0);
    assert.match(threads.at(-1).label, /No line reference/);
    assert.equal(contentReads, beforeContent, 'local navigation never fetches the GitHub file');
    pr.threads[0].line = 2; pr.threads[0].diffSide = 'RIGHT';
    await rm(join(localRoot, 'a.ts'));
    await openLocal();
    assert.equal(opened.at(-1).doc.uri.scheme, 'stacknav-review', 'deleted file falls back to revision');
    assert.match(threads.at(-1).label, /Workspace file unavailable/);
    await writeFile(join(temp, 'outside.ts'), 'outside repo');
    await symlink(join(temp, 'outside.ts'), join(localRoot, 'a.ts'));
    await openLocal();
    assert.equal(opened.at(-1).doc.uri.scheme, 'stacknav-review', 'symlink escape cannot open another repo file');
    const reloaded = new ReviewOverview(async () => {}, undefined, workspaceState);
    reloaded.update('/correct-repo', state);
    assert.equal(revealed.length, 1, 'workspace state prevents auto-open after reload');
    reloaded.dispose();
    // Exercise the real queue with controlled network completion.
    const requests: { url: string; finish: (value: ReviewPr) => void; signal?: AbortSignal }[] = [];
    Reviews.prototype.read = async (_root, url, signal, summary) => {
      assert.equal(summary, true, 'background loads only thread summaries');
      return new Promise(resolve => { requests.push({ url, finish: resolve, signal }); });
    };
    const queued = new ReviewOverview(async () => {}, undefined, workspaceState);
    const many = { ...state, stack: { ...state.stack, branches: [1, 2, 3, 4].map(number => ({
      name: `b${number}`, isCurrent: number === 3,
      pr: { number, url: `https://github.com/o/r/pull/${number}`, state: 'OPEN' }
    })) } };
    const flush = () => new Promise(resolve => setImmediate(resolve));
    queued.update('/repo', many);
    const prs = await queued.getChildren();
    assert.deepEqual(prs.map((node: any) => node.branch.pr.number), [4, 3, 2, 1]);
    assert.deepEqual(requests.map(r => r.url.slice(-1)), ['3', '4'], 'current PR first, at most two concurrent');
    const expanding = queued.getChildren(prs[3]);
    requests[0].finish(pr); await flush();
    assert.equal(requests[2].url.slice(-1), '1', 'expanded PR jumps ahead of queued background work');
    requests[1].finish(pr); requests[2].finish(pr); await flush();
    assert.equal(requests[3].url.slice(-1), '2');
    requests[3].finish(pr); await expanding; await flush();
    queued.update('/repo', many);
    assert.equal(requests.length, 4, 'same stack retains cache');
    await commands.get('stacknav.refreshOverview')!();
    assert.equal((await queued.getChildren(prs[0])).length, 1, 'old threads remain visible while refreshing');
    assert.match(queued.getTreeItem(prs[0]).description, /Updating/);
    queued.update('/other', many);
    assert.ok(requests[4].signal?.aborted);
    assert.ok(requests[5].signal?.aborted);
    requests[4].finish({ ...pr, title: 'stale' }); requests[5].finish(pr); await flush();
    const other = await queued.getChildren();
    assert.equal(other[0].data, undefined, 'late old-repo response cannot populate new stack');
    queued.dispose();
    requests.slice(6).forEach(request => request.finish(pr)); await flush();
  } finally {
    overview.dispose(); Object.assign(Reviews.prototype, originals);
    await rm(temp, { recursive: true, force: true });
  }
});
