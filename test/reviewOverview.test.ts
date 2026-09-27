import assert from 'node:assert/strict';
import test from 'node:test';
import { Reviews, ReviewPr } from '../src/reviews';

test('overview expands without checkout, opens selected native thread, and disposes on branch change', async () => {
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
  }
  const vscode = {
    EventEmitter: Emitter,
    TreeItem: class { constructor(public label: string) {} }, ThemeIcon: class {},
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
        const content = provider.provideTextDocumentContent(uri);
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
  const originals = { read: Reviews.prototype.read, checkout: Reviews.prototype.checkout, content: Reviews.prototype.content };
  let checkouts = 0, reads = 0, navigationRoot = '';
  const pr: ReviewPr = { title: 'API', state: 'OPEN', isDraft: false, reviewDecision: 'CHANGES_REQUESTED', headRefOid: 'a'.repeat(40), threads: [{
    id: 'T', path: 'a.ts', line: 2, originalLine: 2, diffSide: 'RIGHT', isOutdated: true, isResolved: false,
    comments: [{ body: 'Fix this', author: { login: 'alice' }, url: '', diffHunk: '', originalCommit: { oid: 'b'.repeat(40) } }]
  }] };
  Reviews.prototype.read = async () => { reads++; return pr; };
  Reviews.prototype.checkout = async () => { checkouts++; };
  Reviews.prototype.content = async () => 'first\nsecond\n';
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
    const children = await overview.getChildren(roots[1]);
    assert.equal(checkouts, 0);
    await overview.getChildren(roots[1]); assert.equal(reads, 1, 'cached when expanded again');
    await commands.get('stacknav.openReviewThread')!(children[0]);
    assert.equal(checkouts, 1);
    assert.equal(navigationRoot, '/correct-repo');
    assert.equal(threads[0].canReply, false);
    assert.equal(threads[0].collapsibleState, 1);
    assert.equal(threads[0].range.startLine, 1);
    assert.equal(threads[0].comments[0].body.value, 'Fix this');
    assert.equal(opened[0].doc.uri.scheme, 'stacknav-review', 'outdated threads use immutable snapshot');
    state.stack.branches[0].isCurrent = false; state.stack.branches[1].isCurrent = true;
    overview.update('/correct-repo', state);
    assert.equal(threads[0].disposed, true);
    assert.equal((await overview.getChildren())[1], roots[1], 'checkout keeps tree identity');
    assert.equal(revealed.length, 1, 'checkout does not reopen the view');
    Reviews.prototype.checkout = async () => { throw new Error('Local changes'); };
    await commands.get('stacknav.openReviewThread')!(children[0]);
    assert.equal(opened.length, 2, 'blocked checkout can still open read-only');
    const reloaded = new ReviewOverview(async () => {}, undefined, workspaceState);
    reloaded.update('/correct-repo', state);
    assert.equal(revealed.length, 1, 'workspace state prevents auto-open after reload');
    reloaded.dispose();
  } finally {
    overview.dispose(); Object.assign(Reviews.prototype, originals);
  }
});
