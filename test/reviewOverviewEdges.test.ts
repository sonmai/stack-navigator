import assert from 'node:assert/strict';
import test from 'node:test';
import { ReviewPr } from '../src/reviews';

function fixture() {
  const commands = new Map<string, (...args: any[]) => any>();
  const warnings: string[] = [];
  const counters = { reveals: 0, checkouts: 0 };
  let rejectReveal = false;
  const workspace = { textDocuments: [] as { isDirty: boolean }[], notebookDocuments: [] as { isDirty: boolean }[],
    registerTextDocumentContentProvider: () => ({ dispose() {} }), onDidCloseTextDocument: () => ({ dispose() {} }) };
  const vscode = {
    workspace, EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    TreeItem: class { constructor(public label: string) {} }, ThemeIcon: class {}, TreeItemCollapsibleState: { Collapsed: 1 },
    comments: { createCommentController: () => ({ dispose() {} }) },
    commands: { registerCommand(name: string, action: any) { commands.set(name, action); return { dispose() {} }; } },
    window: {
      createTreeView: () => ({ dispose() {}, async reveal() { counters.reveals++; if (rejectReveal) { throw new Error('Not ready'); } } }),
      showWarningMessage: async (message: string) => { warnings.push(message); return undefined; },
      showErrorMessage: (message: string) => { throw new Error(message); }
    }
  };
  const Module = require('node:module'), original = Module._load;
  const modulePath = require.resolve('../src/reviewOverview');
  delete require.cache[modulePath];
  Module._load = function(id: string, ...args: any[]) { return id === 'vscode' ? vscode : original.call(this, id, ...args); };
  let ReviewOverview: any;
  try { ReviewOverview = require('../src/reviewOverview').ReviewOverview; } finally { Module._load = original; }
  const pr: ReviewPr = { title: 'PR', state: 'OPEN', isDraft: false, reviewDecision: null, headRefOid: 'a'.repeat(40), threads: [{
    id: 'T', path: 'a.ts', line: 1, originalLine: 1, diffSide: 'RIGHT', isOutdated: false, isResolved: false, comments: []
  }] };
  const reviews = { read: async () => structuredClone(pr), readThread: async () => structuredClone(pr),
    checkout: async () => { counters.checkouts++; }, content: async () => '' };
  const overview = new ReviewOverview(async (_root: string, action: () => Promise<void>) => action(), undefined, undefined, undefined, reviews);
  const update = () => overview.update('/repo', { type: 'loaded', index: 0, stack: { trunk: 'main', currentBranch: 'feature', branches: [{
    name: 'feature', isCurrent: true, pr: { number: 1, url: 'https://github.com/o/r/pull/1', state: 'OPEN' }
  }] } });
  return { overview, workspace, counters, warnings, update, failReveal: (value: boolean) => { rejectReveal = value; },
    async click() {
      const [root] = await overview.getChildren();
      const [child] = await overview.getChildren(root);
      const command = overview.getTreeItem(child).command;
      await commands.get(command.command)!(...command.arguments);
    } };
}

test('failed initial reveal retries on a later same-stack update and stops after success', async () => {
  const f = fixture();
  try {
    f.failReveal(true); f.update();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.counters.reveals, 1, 'no automatic retry loop');
    f.failReveal(false); f.update();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.counters.reveals, 2);
    f.update();
    assert.equal(f.counters.reveals, 2, 'successful reveal does not reopen');
  } finally { f.overview.dispose(); }
});

for (const kind of ['notebook', 'text'] as const) {
  test(`dirty ${kind} blocks checkout before any branch change`, async () => {
    const f = fixture();
    try {
      (kind === 'notebook' ? f.workspace.notebookDocuments : f.workspace.textDocuments).push({ isDirty: true });
      f.update(); await f.click();
      assert.equal(f.counters.checkouts, 0);
      assert.match(f.warnings[0], /Save or close unsaved files/);
    } finally { f.overview.dispose(); }
  });
}
