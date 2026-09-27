import * as vscode from 'vscode';
import { basename, relative, isAbsolute, sep } from 'node:path';
import { CliError, RepositoryMismatchError, StackCli } from './cli';
import { NavState, navigation, normalizePrUrl, parseCurrentPr, parseStack, prLabel, prSummary, branchStatus, StackBranch, StackView } from './core';
import { LocalStacks } from './localStacks';
import { PrDetailsCache } from './prDetails';
import { ReviewOverview } from './reviewOverview';

interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    HEAD: { name?: string; commit?: string } | undefined;
    onDidChange: vscode.Event<void>;
  };
}

interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
  enabled?: boolean;
  onDidChangeEnablement?: vscode.Event<boolean>;
  getAPI(version: 1): GitApi;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Stack Navigator');
  const cli = new StackCli();
  const localStacks = new LocalStacks();
  const titles = new PrDetailsCache(async (root, url, includeBody, signal) => {
    try { return await cli.prDetails(root, url, includeBody, signal); }
    catch (error) {
      if (!signal?.aborted) { output.appendLine(`PR details lookup: ${String(error)}`); }
      throw error;
    }
  });
  const down = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
  const center = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
  const up = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  down.command = 'stacknav.down';
  center.command = 'stacknav.select';
  up.command = 'stacknav.up';
  context.subscriptions.push(output, down, center, up);

  let git: GitExtension | undefined;
  let api: GitApi | undefined;
  try {
    git = await vscode.extensions.getExtension<GitExtension>('vscode.git')?.activate();
    api = git?.getAPI(1);
  } catch (error) { output.appendLine(`Git extension: ${String(error)}`); }
  if (!api || git?.enabled === false) {
    void vscode.window.showWarningMessage('Stack Navigator requires the built-in Git extension. Enable Git and reload the window.');
  }
  const repositoryListeners = new Map<GitRepository, vscode.Disposable>();
  const observedHeads = new Map<GitRepository, string>();
  let state: NavState = { type: 'empty' };
  let stateRoot: string | undefined;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let dirty = false;
  let reads: AbortController | undefined;
  let selectedRepository: GitRepository | undefined;
  let updatePicker: (() => void) | undefined;
  let disposed = false;
  const overview = new ReviewOverview(async (root, action) => {
    if (busy) { throw new Error('Another navigation is in progress. Try again when it finishes.'); }
    if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before checking out a PR.'); }
    const repo = api?.repositories.find(repo => repo.rootUri.fsPath === root);
    if (!repo) { throw new Error('The repository is no longer open.'); }
    selectedRepository = repo;
    await perform('Open review thread', async () => { await action(); return ''; }, true, root);
  }, url => titles.peek(url)?.title, context.workspaceState);
  context.subscriptions.push(overview);

  function repositoryForActiveEditor(): GitRepository | undefined {
    if (!api) { return undefined; }
    const editor = vscode.window.activeTextEditor;
    if (editor && ['file', 'vscode-remote', 'git'].includes(editor.document.uri.scheme)) {
      const path = editor.document.uri.fsPath;
      const candidates = api.repositories.filter(repo => {
        const child = relative(repo.rootUri.fsPath, path);
        return child === '' || (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child));
      });
      if (candidates.length) {
        return candidates.sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
      }
    }
    return undefined;
  }

  function activeRepository(): GitRepository | undefined {
    if (!api) { return undefined; }
    const active = repositoryForActiveEditor();
    if (active) {
      selectedRepository = active;
      return active;
    }
    if (selectedRepository && api.repositories.includes(selectedRepository)) { return selectedRepository; }
    return api.repositories.length === 1 ? api.repositories[0] : undefined;
  }

  function hide(): void {
    down.hide();
    center.hide();
    up.hide();
  }

  function renderRepositorySelection(): void {
    overview.update(undefined, { type: 'empty' });
    hide();
    center.text = '$(repo) Select repository…';
    center.tooltip = 'Choose which Git repository Stack Navigator should use.';
    center.command = 'stacknav.selectRepository';
    center.show();
  }

  function details(branch: StackBranch | undefined): string {
    if (!branch) { return '—'; }
    const title = branch.pr && titles.peek(branch.pr.url)?.title;
    return `${prSummary(branch, title)}${title ? `\n${branch.name}` : ''}`;
  }

  async function loadTitles(stack: StackView, root: string, ticket: number, signal: AbortSignal): Promise<void> {
    const prs = stack.branches.filter(branch => branch.pr).sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
    for (let i = 0; i < prs.length && !disposed && !signal.aborted && ticket === generation; i += 4) {
      const batch = prs.slice(i, i + 4);
      const before = batch.map(branch => titles.peek(branch.pr!.url));
      await Promise.all(batch.map(branch => titles.get(root, branch.pr!.url, branch.isCurrent, signal)));
      const changed = batch.some((branch, index) => {
        const after = titles.peek(branch.pr!.url);
        return after?.title !== before[index]?.title || after?.body !== before[index]?.body;
      });
      if (changed && !disposed && !signal.aborted && ticket === generation && stateRoot === root) {
        render();
        updatePicker?.();
      }
    }
  }

  function render(): void {
    overview.update(stateRoot, state);
    hide();
    if (state.type === 'empty') { return; }
    if (state.type === 'error') {
      center.text = '$(warning) Stack Navigator';
      center.tooltip = state.message;
      center.command = 'stacknav.refresh';
      center.show();
      return;
    }
    if (state.type === 'unloaded') {
      center.text = `$(layers) Load stack for #${state.pr.number}`;
      center.tooltip = 'Fetch this PR’s stack locally for review. No remote branches or PRs are changed.';
      center.command = 'stacknav.load';
      center.show();
      return;
    }
    if (state.type === 'stacks') {
      center.text = '$(layers) Select stack…';
      center.tooltip = `${state.choices.length} stacks on ${state.choices[0].trunk}`;
      center.command = 'stacknav.selectStack';
      center.show();
      return;
    }
    if (state.type === 'trunk') {
      const first = state.stack.branches.find(branch => !branch.isMerged);
      center.text = '$(layers) Trunk';
      center.tooltip = `${state.stack.trunk} · ${state.stack.branches.length} layers`;
      center.command = first ? 'stacknav.first' : undefined;
      center.show();
      if (first) {
        up.command = 'stacknav.first';
        up.text = '$(arrow-up)';
        up.tooltip = `First active layer: ${details(first)}`;
        up.show();
      }
      return;
    }
    up.command = 'stacknav.up';
    const { stack, index } = state;
    const current = stack.branches[index];
    const targets = navigation(stack, index);
    center.text = `$(layers) ${index + 1}/${stack.branches.length} · ${prLabel(current)}${branchStatus(current)}`;
    const metadata = current.pr && titles.peek(current.pr.url);
    const preview = metadata?.body ?? '';
    center.tooltip = `${index + 1}/${stack.branches.length}\n${prSummary(current, metadata?.title)}${branchStatus(current)}${preview ? `\n\n${preview}` : ''}`;
    center.command = 'stacknav.select';
    center.show();
    if (targets.below !== undefined) {
      down.text = '$(arrow-down)';
      down.tooltip = `Previous: ${details(stack.branches[targets.below])}`;
      down.show();
    }
    if (targets.above !== undefined) {
      up.text = '$(arrow-up)';
      up.tooltip = `Next: ${details(stack.branches[targets.above])}`;
      up.show();
    }
  }

  async function refresh(): Promise<void> {
    if (disposed) { return; }
    if (busy) { dirty = true; return; }
    const ticket = ++generation;
    reads?.abort();
    reads = new AbortController();
    const { signal } = reads;
    if (!api || git?.enabled === false) {
      state = { type: 'error', message: 'Enable the built-in Git extension and reload the window.' };
      stateRoot = undefined; render(); return;
    }
    const repo = activeRepository();
    const root = repo?.rootUri.fsPath;
    if (!root) {
      state = { type: 'empty' };
      stateRoot = undefined;
      if (api.repositories.length > 1) { renderRepositorySelection(); }
      else { render(); }
      return;
    }
    try {
      const json = await cli.view(root, signal);
      const next = parseStack(json);
      if (signal.aborted || ticket !== generation) { return; }
      state = next;
      stateRoot = root;
      render();
      if (next.type === 'loaded' || next.type === 'trunk') { void loadTitles(next.stack, root, ticket, signal); }
    } catch (error) {
      if (signal.aborted || ticket !== generation) { return; }
      if (error instanceof CliError && error.exitCode === 6) {
        try {
          const choices = await localStacks.list(root, signal);
          if (signal.aborted || ticket !== generation) { return; }
          state = choices.length ? { type: 'stacks', choices }
            : { type: 'error', message: 'This branch belongs to multiple stacks. Check out a branch unique to a stack.' };
        } catch (listError) {
          if (signal.aborted || ticket !== generation) { return; }
          output.appendLine(`List stacks: ${String(listError)}`);
          state = { type: 'error', message: 'Could not list local stacks. Check Output → Stack Navigator, or check out a PR branch manually.' };
        }
      } else if (error instanceof CliError && error.exitCode === 2) {
        try {
          const pr = parseCurrentPr(await cli.currentPr(root, signal));
          if (signal.aborted || ticket !== generation) { return; }
          state = { type: 'unloaded', pr };
        } catch (prError) {
          output.appendLine(`PR lookup: ${String(prError)}`);
          if (signal.aborted || ticket !== generation) { return; }
          state = { type: 'empty' };
        }
      } else {
        output.appendLine(`Stack view: ${String(error)}`);
        state = { type: 'error', message: error instanceof CliError && error.missingExecutable
          ? 'GitHub CLI (gh) was not found. Install it and click to retry.'
          : error instanceof CliError && error.exitCode === 6
            ? 'This branch belongs to several stacks. Check out a PR branch unique to the stack, then refresh.'
            : 'Could not read the stack. Check Output → Stack Navigator; click to retry.' };
      }
      stateRoot = root;
      render();
    }
  }

  function scheduleRefresh(): void {
    if (disposed) { return; }
    reads?.abort();
    if (busy) { dirty = true; return; }
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(() => { timer = undefined; void refresh(); }, 250);
  }

  function observe(repo: GitRepository): void {
    repositoryListeners.get(repo)?.dispose();
    const headKey = () => `${repo.state.HEAD?.name ?? ''}\0${repo.state.HEAD?.commit ?? ''}`;
    observedHeads.set(repo, headKey());
    repositoryListeners.set(repo, repo.state.onDidChange(() => {
      const next = headKey();
      if (next === observedHeads.get(repo)) { return; }
      observedHeads.set(repo, next);
      scheduleRefresh();
    }));
  }

  if (git?.onDidChangeEnablement) {
    context.subscriptions.push(git.onDidChangeEnablement(() => scheduleRefresh()));
  }
  if (api) {
    for (const repo of api.repositories) { observe(repo); }
    context.subscriptions.push(api.onDidOpenRepository(repo => { observe(repo); scheduleRefresh(); }));
    context.subscriptions.push(api.onDidCloseRepository(repo => {
      repositoryListeners.get(repo)?.dispose();
      repositoryListeners.delete(repo);
      observedHeads.delete(repo);
      if (selectedRepository === repo) { selectedRepository = undefined; }
      scheduleRefresh();
    }));
  }
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    const active = repositoryForActiveEditor();
    if (active) { selectedRepository = active; }
    if (activeRepository()?.rootUri.fsPath !== stateRoot) { scheduleRefresh(); }
  }));
  context.subscriptions.push({ dispose: () => {
    disposed = true;
    ++generation;
    reads?.abort();
    if (timer) { clearTimeout(timer); }
    for (const listener of repositoryListeners.values()) { listener.dispose(); }
  } });

  function currentRoot(): string | undefined {
    const root = activeRepository()?.rootUri.fsPath;
    return root && root === stateRoot ? root : undefined;
  }

  async function perform(label: string, action: (root: string) => Promise<string>, showProgress = false, explicitRoot?: string): Promise<void> {
    if (busy) { return; }
    const root = explicitRoot ?? currentRoot();
    if (!root) { await refresh(); return; }
    busy = true;
    stateRoot = undefined;
    reads?.abort();
    let failure: unknown;
    try {
      output.appendLine(`${label} in ${root}`);
      if (showProgress) {
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'Stack Navigator: Loading stack for review…',
          cancellable: false
        }, () => action(root));
      } else {
        await action(root);
      }
    } catch (error) {
      output.appendLine(`${label}: ${String(error)}`);
      failure = error;
    } finally {
      busy = false;
      if (dirty) { dirty = false; scheduleRefresh(); }
      else { await refresh(); }
    }
    if (failure) {
      const detail = failure instanceof RepositoryMismatchError ? failure.message
        : failure instanceof CliError && /different composition|already tracked/i.test(failure.message)
        ? 'The local stack has a different composition. Resolve that conflict manually before loading.'
        : failure instanceof CliError && /remote\.pushDefault|multiple remotes|choose.*remote/i.test(failure.message)
          ? 'Set Git remote.pushDefault for this repository, then try again.'
          : 'See Output for details.';
      const choice = await vscode.window.showErrorMessage(`Stack Navigator: ${label} failed. ${detail}`, 'Show Output');
      if (choice) { output.show(true); }
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('stacknav.refresh', () => { titles.clear(); return refresh(); }),
    vscode.commands.registerCommand('stacknav.selectRepository', async () => {
      if (!api?.repositories.length) {
        void vscode.window.showInformationMessage('Stack Navigator: Open a local Git repository first.');
        return;
      }
      const chosen = await vscode.window.showQuickPick(api.repositories.map(repository => ({
        label: basename(repository.rootUri.fsPath),
        description: repository.rootUri.fsPath,
        repository
      })), { placeHolder: 'Choose the repository Stack Navigator should use', matchOnDescription: true });
      if (!chosen) { return; }
      selectedRepository = chosen.repository;
      await refresh();
    }),
    vscode.commands.registerCommand('stacknav.loadUrl', async () => {
      if (busy) { return; }
      let repo = activeRepository();
      if (!repo && api?.repositories.length) {
        const chosen = await vscode.window.showQuickPick(api.repositories.map(repository => ({
          label: repository.rootUri.fsPath, repository
        })), { placeHolder: 'Choose the local repository for this PR stack' });
        if (!chosen) { return; }
        repo = chosen.repository;
        selectedRepository = repo;
      }
      if (!repo) { vscode.window.showInformationMessage('Stack Navigator: Open a local Git repository first.'); return; }
      const root = repo.rootUri.fsPath;
      const input = await vscode.window.showInputBox({
        title: 'Load Stack from PR URL',
        prompt: `Fetch and check out the PR stack in ${root}`,
        placeHolder: 'https://github.com/owner/repo/pull/184',
        validateInput: value => {
          try { normalizePrUrl(value); return undefined; }
          catch (error) { return (error as Error).message; }
        }
      });
      if (input === undefined) { return; }
      await perform('Load stack', cwd => cli.load(cwd, normalizePrUrl(input)), true, root);
    }),
    vscode.commands.registerCommand('stacknav.load', async () => {
      if (state.type !== 'unloaded') { return; }
      const url = state.pr.url;
      await perform('Load stack', root => cli.load(root, url), true);
    }),
    vscode.commands.registerCommand('stacknav.selectStack', async () => {
      if (busy || state.type !== 'stacks') { return; }
      const root = currentRoot();
      if (!root) { await refresh(); return; }
      const items = state.choices.flatMap(stack => {
        const first = stack.branches.find(branch => !branch.merged);
        return first ? [{
          label: stack.number ? `Stack #${stack.number}` : first.name,
          description: `${stack.branches.filter(branch => !branch.merged).length} active layers`,
          detail: `${first.prNumber ? `#${first.prNumber} · ` : ''}${first.name}`, stack
        }] : [];
      });
      if (!items.length) {
        void vscode.window.showInformationMessage('Stack Navigator: All layers in these stacks are merged.'); return;
      }
      const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select a stack to enter its first active layer', matchOnDetail: true });
      if (!selected) { return; }
      if (activeRepository()?.rootUri.fsPath !== root) {
        void vscode.window.showInformationMessage('Stack Navigator: The active repository changed. Select the stack again.'); return;
      }
      await perform('Enter stack', cwd => localStacks.enter(cwd, selected.stack), false, root);
    }),
    vscode.commands.registerCommand('stacknav.first', async () => {
      if (state.type === 'trunk' && state.stack.branches.some(branch => !branch.isMerged)) {
        await perform('Go to first layer', root => cli.firstLayer(root));
      }
    }),
    vscode.commands.registerCommand('stacknav.up', async () => {
      if (state.type === 'loaded' && navigation(state.stack, state.index).above !== undefined) {
        await perform('Move up', root => cli.move(root, 'up'));
      }
    }),
    vscode.commands.registerCommand('stacknav.down', async () => {
      if (state.type === 'loaded' && navigation(state.stack, state.index).below !== undefined) {
        await perform('Move down', root => cli.move(root, 'down'));
      }
    }),
    vscode.commands.registerCommand('stacknav.select', async () => {
      if (state.type !== 'loaded') { return; }
      const stack = state.stack;
      const targets = navigation(stack, state.index);
      if (busy || updatePicker) { return; }
      const pickerRoot = currentRoot();
      const items = () => [...targets.selectable].reverse().map(index => {
          const branch = stack.branches[index];
          return {
            index,
            branch,
            label: `${branch.isCurrent ? '$(check)' : '$(circle-outline)'} ${prSummary(branch, branch.pr && titles.peek(branch.pr.url)?.title)}`,
            description: `${index + 1}/${stack.branches.length}${branch.isCurrent ? ' · Current' : ''}${branchStatus(branch)}`,
            detail: branch.name
          };
        });
      const picker = vscode.window.createQuickPick<ReturnType<typeof items>[number]>();
      picker.placeholder = `Select a PR layer · trunk: ${stack.trunk}`;
      picker.matchOnDetail = true;
      picker.items = items();
      updatePicker = () => {
        const focused = picker.activeItems[0]?.index;
        picker.items = items();
        const active = picker.items.find(item => item.index === focused);
        if (active) { picker.activeItems = [active]; }
      };
      const selected = await new Promise<ReturnType<typeof items>[number] | undefined>(resolve => {
        const accepted = picker.onDidAccept(() => { resolve(picker.selectedItems[0]); picker.hide(); });
        const hidden = picker.onDidHide(() => {
          resolve(undefined); accepted.dispose(); hidden.dispose(); picker.dispose(); updatePicker = undefined;
        });
        picker.show();
      });
      if (selected && !selected.branch.isCurrent) {
        await refresh();
        if (currentRoot() !== pickerRoot || state.type !== 'loaded' || state.stack.currentBranch !== stack.currentBranch ||
            state.stack.branches.length !== stack.branches.length ||
            state.stack.branches.some((branch, index) =>
              branch.name !== stack.branches[index].name || branch.isMerged !== stack.branches[index].isMerged)) {
          vscode.window.showInformationMessage('Stack Navigator: The stack changed. Select the PR again.');
          return;
        }
        const move = navigation(state.stack, state.index).moveTo(selected.index);
        if (move) {
          await perform('Switch PR', root => cli.move(root, move.direction, move.steps));
        }
      }
    })
  );

  void refresh();
}

export function deactivate(): void { /* Disposables are owned by the extension context. */ }
