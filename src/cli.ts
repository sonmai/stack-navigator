import { execFile } from 'node:child_process';
import { PrDetails } from './prDetails';
import { normalizePrUrl, descriptionPreview } from './core';

const executable = process.platform === 'win32' ? 'gh.exe' : 'gh';

export class CliError extends Error {
  constructor(message: string, readonly exitCode?: number, readonly missingExecutable = false) {
    super(message);
  }
}

export class RepositoryMismatchError extends Error {}

type Runner = (args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<string>;

export class StackCli {
  constructor(private readonly runner: Runner = runGh) {}

  view(cwd: string, signal?: AbortSignal): Promise<string> {
    return this.runner(['stack', 'view', '--json'], cwd, signal);
  }

  currentPr(cwd: string, signal?: AbortSignal): Promise<string> {
    return this.runner(['pr', 'view', '--json', 'number,url'], cwd, signal);
  }

  load(cwd: string, prUrl: string): Promise<string> {
    return this.loadChecked(cwd, normalizePrUrl(prUrl));
  }

  private async loadChecked(cwd: string, prUrl: string): Promise<string> {
    const value: unknown = JSON.parse(await this.runner(['repo', 'view', '--json', 'url'], cwd));
    if (!value || typeof value !== 'object' || !('url' in value) || typeof value.url !== 'string') {
      throw new Error('Could not determine the local repository identity');
    }
    const repository = new URL(value.url);
    if (repository.protocol !== 'https:' || repository.username || repository.password ||
        repository.search || repository.hash || !/^\/[^/]+\/[^/]+\/?$/.test(repository.pathname)) {
      throw new Error('Unexpected repository URL');
    }
    const expected = `${repository.origin}${repository.pathname.replace(/\/$/, '')}`;
    const requested = prUrl.slice(0, prUrl.lastIndexOf('/pull/'));
    if (requested.toLowerCase() !== expected.toLowerCase()) {
      throw new RepositoryMismatchError(`This PR belongs to ${requested}, but the selected repository is ${expected}. Open the matching local repository and try again.`);
    }
    return this.runner(['stack', 'checkout', prUrl], cwd);
  }

  async prDetails(cwd: string, prUrl: string, includeBody = true, signal?: AbortSignal): Promise<PrDetails> {
    const value: unknown = JSON.parse(await this.runner(['pr', 'view', normalizePrUrl(prUrl), '--json', includeBody ? 'title,body' : 'title'], cwd, signal));
    if (!value || typeof value !== 'object' || !('title' in value) || typeof value.title !== 'string') {
      throw new Error('Unexpected PR details response');
    }
    if (!includeBody) { return { title: value.title.replace(/[\r\n]+/g, ' ').trim() }; }
    const body = ('body' in value ? value.body : undefined) ?? '';
    if (typeof body !== 'string') { throw new Error('Unexpected PR details response'); }
    return { title: value.title.replace(/[\r\n]+/g, ' ').trim(), body: descriptionPreview(body) };
  }

  firstLayer(cwd: string): Promise<string> {
    return this.runner(['stack', 'up'], cwd);
  }

  move(cwd: string, direction: 'up' | 'down', steps = 1): Promise<string> {
    if (direction !== 'up' && direction !== 'down') { throw new Error('Invalid navigation direction'); }
    if (!Number.isSafeInteger(steps) || steps < 1) { throw new Error('Invalid step count'); }
    return this.runner(steps === 1 ? ['stack', direction] : ['stack', direction, String(steps)], cwd);
  }
}

export function runGit(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return runCommand(process.platform === 'win32' ? 'git.exe' : 'git', args, cwd, signal, args[0] === 'switch' ? 120_000 : 30_000);
}

export function runGh(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return runCommand(executable, args, cwd, signal, args[0] === 'stack' && args[1] === 'checkout' ? 120_000 : 30_000);
}

function runCommand(command: string, args: readonly string[], cwd: string, signal: AbortSignal | undefined, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = execFile(command, [...args], {
      cwd,
      signal,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      if (!error) { resolve(stdout); return; }
      const failure = error as NodeJS.ErrnoException & { code?: string | number };
      const exitCode = typeof failure.code === 'number' ? failure.code : undefined;
      reject(new CliError((stderr || failure.message).trim(), exitCode, failure.code === 'ENOENT'));
    });
    // gh-stack cannot wait for input from this extension's background process.
    child.stdin?.end();
  });
}
