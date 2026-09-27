import assert from 'node:assert/strict';
import test from 'node:test';
import { StackCli, CliError } from '../src/cli';
import { Reviews, ReviewPr } from '../src/reviews';

test('comment click runs through the host, keeps the stack, and opens its native thread', async () => {
  const commands = new Map<string, (...args: any[]) => any>();
  const errors: string[] = [], checkoutRoots: string[] = [], opened: any[] = [], threads: any[] = [];
  const subscriptions: any[] = [];
  let tree: any, provider: any, contentProvider: any;
  let headChanged: () => void = () => {};
  let editorChanged: () => void = () => {};
  let current = 'api';
  let failRead = false;
  const disposable = () => ({ dispose() {} });
  const repos = ['/a', '/b'].map(root => ({ rootUri: { fsPath: root }, state: {
    HEAD: { name: 'api', commit: '1' },
    onDidChange: (fn: () => void) => { if (root === '/b') { headChanged = fn; } return disposable(); }
  } }));
  class Uri {
    scheme = 'stacknav-review';
    constructor(readonly path: string) {}
    toString() { return this.scheme + ':' + this.path; }
    static from(value: { path: string }) { return new Uri(value.path); }
  }
  const vscode: any = {
    Uri, EventEmitter: class { event = () => disposable(); fire() {} dispose() {} },
    TreeItem: class { constructor(public label: string) {} }, ThemeIcon: class { constructor(public id: string) {} },
    TreeItemCollapsibleState: { Collapsed: 1 }, StatusBarAlignment: { Left: 1 },
    ProgressLocation: { Notification: 1 }, CommentMode: { Preview: 0 },
    CommentThreadState: { Resolved: 1, Unresolved: 0 }, CommentThreadCollapsibleState: { Expanded: 1 },
    TextEditorRevealType: { InCenter: 1 }, Range: class {}, MarkdownString: class {},
    commands: { registerCommand: (name: string, fn: any) => { commands.set(name, fn); return disposable(); } },
    extensions: { getExtension: () => ({ activate: async () => ({ enabled: true, getAPI: () => ({
      repositories: repos, onDidOpenRepository: disposable, onDidCloseRepository: disposable
    }) }) }) },
    comments: { createCommentController: () => ({ ...disposable(), createCommentThread: (...args: any[]) => {
      const thread = { ...disposable(), args }; threads.push(thread); return thread;
    } }) },
    workspace: {
      isTrusted: true, textDocuments: [], onDidCloseTextDocument: disposable,
      registerTextDocumentContentProvider: (_scheme: string, p: any) => { contentProvider = p; return disposable(); },
      openTextDocument: async (uri: Uri) => ({ uri, lineCount: 3, getText: () => contentProvider.provideTextDocumentContent(uri) })
    },
    window: {
      activeTextEditor: { document: { uri: { scheme: 'file', fsPath: '/b/file.ts' } } },
      onDidChangeActiveTextEditor: (fn: () => void) => { editorChanged = fn; return disposable(); },
      createOutputChannel: () => ({ ...disposable(), appendLine() {} }),
      createStatusBarItem: () => ({ ...disposable(), show() {}, hide() {} }),
      createTreeView: (_id: string, options: any) => {
        provider = options.treeDataProvider;
        tree = { ...disposable(), reveal: async () => {} }; return tree;
      },
      withProgress: async (_options: any, fn: any) => fn(),
      showWarningMessage: async (message: string) => { errors.push(message); },
      showErrorMessage: async (message: string) => { errors.push(message); },
      showTextDocument: async (doc: any) => {
        opened.push(doc); vscode.window.activeTextEditor = { document: doc }; editorChanged();
        return { revealRange() {} };
      }
    }
  };
  const Module = require('node:module'), originalLoad = Module._load;
  Module._load = function(id: string, ...args: any[]) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); };
  const { activate } = require('../src/extension');
  Module._load = originalLoad;
  const originalView = StackCli.prototype.view, originalDetails = StackCli.prototype.prDetails;
  const originals = { read: Reviews.prototype.read, readThread: Reviews.prototype.readThread,
    checkout: Reviews.prototype.checkout, content: Reviews.prototype.content };
  const pr: ReviewPr = { title: 'UI', state: 'OPEN', isDraft: false, reviewDecision: null,
    headRefOid: 'a'.repeat(40), threads: [{ id: 'T', path: 'file.ts', line: 2, originalLine: 2,
      diffSide: 'RIGHT', isOutdated: true, isResolved: false,
      comments: [{ body: 'Fix this', author: { login: 'reviewer' }, url: '', diffHunk: '', originalCommit: { oid: 'b'.repeat(40) } }] }] };
  StackCli.prototype.view = async root => {
    assert.equal(root, '/b', 'all stack reads stay in the selected comment repository');
    if (failRead) { throw new CliError('network failure', 1); }
    return JSON.stringify({ trunk: 'main', currentBranch: current, branches: ['api', 'ui'].map((name, i) => ({
      name, isCurrent: name === current, pr: { number: i + 1, url: `https://github.com/o/r/pull/${i + 1}`, state: 'OPEN' }
    })) });
  };
  StackCli.prototype.prDetails = async () => ({ title: 'PR' });
  Reviews.prototype.read = async () => pr;
  Reviews.prototype.readThread = async () => pr;
  Reviews.prototype.content = async () => 'one\ntwo\n';
  Reviews.prototype.checkout = async (root, branch) => {
    checkoutRoots.push(root);
    current = branch;
    repos[1].state.HEAD.name = branch;
    headChanged();
    await commands.get('stacknav.refresh')!(); // Refreshes during checkout must not clear the view.
    assert.equal((await provider.getChildren()).length, 2);
    assert.match(tree.message, /Click a review thread/);
  };
  try {
    await activate({ subscriptions });
    const roots = await provider.getChildren();
    const children = await provider.getChildren(roots[0]);
    const item = provider.getTreeItem(children[0]);
    await commands.get(item.command.command)!(...JSON.parse(JSON.stringify(item.command.arguments)));
    assert.deepEqual(checkoutRoots, ['/b']);
    assert.equal(current, 'ui');
    assert.equal(opened.length, 1);
    assert.equal(threads.length, 1);
    assert.match(provider.getTreeItem(roots[0]).description, /^Current ·/);
    assert.equal(provider.getTreeItem(roots[0]).iconPath.id, 'git-pull-request');
    assert.equal((await provider.getChildren())[0], roots[0]);
    assert.deepEqual(errors, []);
    failRead = true;
    await commands.get('stacknav.refresh')!();
    assert.match(tree.message, /Could not read the stack/);
    assert.doesNotMatch(tree.message, /Open a local stack/);
    failRead = false;
    await commands.get('stacknav.refreshOverview')!();
    assert.equal((await provider.getChildren()).length, 2);
    Reviews.prototype.checkout = async () => { throw new Error('Local changes block checkout'); };
    const retry = provider.getTreeItem((await provider.getChildren((await provider.getChildren())[0]))[0]);
    await commands.get(retry.command.command)!(...retry.command.arguments);
    assert.match(errors.at(-1)!, /Local changes block checkout/);
    assert.equal((await provider.getChildren()).length, 2, 'blocked checkout retains stack');
  } finally {
    subscriptions.forEach(item => item.dispose());
    StackCli.prototype.view = originalView; StackCli.prototype.prDetails = originalDetails;
    Object.assign(Reviews.prototype, originals);
  }
});
