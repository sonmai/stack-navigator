import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { RepositoryMismatchError, StackCli, runGh, runGit } from '../src/cli';

test('switch and stack checkout use long timeouts while reads retain 30 seconds', async () => {
  const cp = require('node:child_process'), original = cp.execFile;
  const timeouts: number[] = [];
  cp.execFile = (_cmd: string, _args: string[], options: any, callback: any) => {
    timeouts.push(options.timeout); callback(null, '', ''); return { stdin: { end() {} } };
  };
  try {
    await runGit(['switch', '--no-guess', '--', 'feature'], '/repo');
    await runGh(['stack', 'checkout', 'https://github.com/o/r/pull/1'], '/repo');
    await runGit(['symbolic-ref', '--short', 'HEAD'], '/repo');
    await runGh(['stack', 'view', '--json'], '/repo');
    assert.deepEqual(timeouts, [120_000, 120_000, 30_000, 30_000]);
  } finally { cp.execFile = original; }
});

test('every command stays within the reviewer navigation allowlist', async () => {
  const calls: string[][] = [];
  const cli = new StackCli(async args => {
    calls.push([...args]);
    if (args[0] === 'repo') { return '{"url":"https://github.com/o/r"}'; }
    if (args.includes('title,body')) { return '{"title":"Add API","body":"Description"}'; }
    return '{}';
  });
  await cli.view('/repo');
  await cli.currentPr('/repo');
  await cli.prDetails('/repo', 'https://github.com/o/r/pull/184');
  await cli.load('/repo', 'https://github.com/o/r/pull/184');
  await cli.move('/repo', 'up');
  await cli.move('/repo', 'down');
  await cli.move('/repo', 'up', 2);
  await cli.firstLayer('/repo');
  assert.deepEqual(calls, [
    ['stack', 'view', '--json'],
    ['pr', 'view', '--json', 'number,url'],
    ['pr', 'view', 'https://github.com/o/r/pull/184', '--json', 'title,body'],
    ['repo', 'view', '--json', 'url'],
    ['stack', 'checkout', 'https://github.com/o/r/pull/184'],
    ['stack', 'up'],
    ['stack', 'down'],
    ['stack', 'up', '2'],
    ['stack', 'up']
  ]);
});

test('rejects unsafe or ambiguous checkout arguments', async () => {
  let calls = 0;
  const cli = new StackCli(async () => { calls++; return ''; });
  assert.throws(() => cli.load('/repo', '184'), /full HTTPS PR URL/);
  assert.throws(() => cli.move('/repo', 'up', 0), /Invalid step count/);
  assert.throws(() => cli.move('/repo', 'sync' as 'up', 1), /Invalid navigation direction/);
  assert.equal(calls, 0);
});

test('background CLI sends EOF to stdin instead of waiting for a prompt', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stacknav-gh-'));
  const fakeGh = join(dir, 'gh');
  const previousPath = process.env.PATH;
  writeFileSync(fakeGh, '#!/usr/bin/env node\nprocess.stdin.on("end", () => process.stdout.write("ok")); process.stdin.resume();\n');
  chmodSync(fakeGh, 0o755);
  process.env.PATH = `${dir}${delimiter}${previousPath ?? ''}`;
  try {
    assert.equal(await new StackCli().view(dir), 'ok');
  } finally {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('foreign owner, repository or host never reaches checkout', async () => {
  for (const url of [
    'https://github.com/other/r/pull/184',
    'https://github.com/o/other/pull/184',
    'https://enterprise.example.com/o/r/pull/184'
  ]) {
    const calls: string[][] = [];
    const cli = new StackCli(async (args, cwd) => {
      assert.equal(cwd, '/selected-repo');
      calls.push([...args]);
      return '{"url":"https://github.com/o/r"}';
    });
    await assert.rejects(cli.load('/selected-repo', url), RepositoryMismatchError);
    assert.deepEqual(calls, [['repo', 'view', '--json', 'url']]);
  }
});

test('repository lookup failure or malformed identity prevents checkout', async () => {
  for (const response of [undefined, '{}', '{"url":"bad"}', '{"url":"https://github.com/o/r/extra"}']) {
    const calls: string[][] = [];
    const cli = new StackCli(async args => {
      calls.push([...args]);
      if (response === undefined) { throw new Error('offline'); }
      return response;
    });
    await assert.rejects(cli.load('/repo', 'https://github.com/o/r/pull/184'));
    assert.deepEqual(calls, [['repo', 'view', '--json', 'url']]);
  }
});

test('matching enterprise repository accepts case differences and normalizes tab links', async () => {
  const calls: string[][] = [];
  const cli = new StackCli(async args => {
    calls.push([...args]);
    return args[0] === 'repo' ? '{"url":"https://git.example.com/Owner/Repo"}' : 'loaded';
  });
  assert.equal(await cli.load('/repo', 'https://git.example.com/owner/repo/pull/184/files#diff'), 'loaded');
  assert.deepEqual(calls, [
    ['repo', 'view', '--json', 'url'],
    ['stack', 'checkout', 'https://git.example.com/owner/repo/pull/184']
  ]);
});


test('cancelling a background read terminates the running gh process', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stacknav-abort-'));
  const previousPath = process.env.PATH;
  writeFileSync(join(dir, 'gh'), '#!/usr/bin/env node\nconst fs = require("node:fs"); process.on("SIGTERM", () => { fs.writeFileSync("stopped", "yes"); process.exit(0); }); fs.writeFileSync("ready", "yes"); setInterval(() => {}, 100);\n');
  chmodSync(join(dir, 'gh'), 0o755);
  process.env.PATH = `${dir}${delimiter}${previousPath ?? ''}`;
  const controller = new AbortController();
  const waitFor = async (name: string) => {
    for (let i = 0; i < 200 && !existsSync(join(dir, name)); i++) { await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.ok(existsSync(join(dir, name)), name);
  };
  const pending = new StackCli().view(dir, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  try {
    await waitFor('ready');
    controller.abort();
    await rejected;
    await waitFor('stopped');
  } finally {
    controller.abort();
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
