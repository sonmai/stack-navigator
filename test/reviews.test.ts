import assert from 'node:assert/strict';
import test from 'node:test';
import { Reviews, ReviewPr, ReviewThread, prIdentity, safeReviewPath, snapshotAnchor, workspaceReviewLine } from '../src/reviews';

const oid = 'a'.repeat(40), original = 'b'.repeat(40);
const comment = { body: 'Fix this', author: { login: 'reviewer' }, url: 'https://github.com/o/r/pull/1#discussion_r1', diffHunk: '@@ -1 +1 @@\n-old\n+new', originalCommit: { oid: original } };
const thread: ReviewThread = { id: 'T1', path: 'src/a.ts', line: 2, originalLine: 1, diffSide: 'RIGHT', isOutdated: false, isResolved: false, comments: [comment] };
const pr: ReviewPr = { title: 'Title', state: 'OPEN', isDraft: false, reviewDecision: null, headRefOid: oid, threads: [thread] };
const page = (nodes: unknown[], more = false, cursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: more, endCursor: cursor } });
const payload = (threads: unknown[], more = false) => JSON.stringify({ data: { repository: { pullRequest: { ...pr, reviewThreads: page(threads, more, more ? 'next' : null) } } } });

test('LEFT-side local navigation falls back to originalLine without inventing a RIGHT-side coordinate', () => {
  assert.equal(workspaceReviewLine({ ...thread, diffSide: 'LEFT', line: null }), 1);
  assert.equal(workspaceReviewLine({ ...thread, diffSide: 'LEFT' }), 2);
  assert.equal(workspaceReviewLine({ ...thread, line: null }), null);
  assert.equal(workspaceReviewLine({ ...thread, isOutdated: true }), 1);
});

test('nullable connection nodes are skipped and raw GraphQL fields do not leak into models', async () => {
  const service = new Reviews(async () => payload([null, { ...thread, extra: 'ignored', comments: page([null, comment]) }]));
  const result = await service.read('/repo', 'https://github.com/o/r/pull/1');
  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0].comments.length, 1);
  assert.equal('extra' in result.threads[0], false);
});

test('malformed comments fail explicitly before reaching the tree', async () => {
  const service = new Reviews(async () => payload([{ ...thread, comments: page([{ body: 42 }]) }]));
  await assert.rejects(service.read('/repo', 'https://github.com/o/r/pull/1'), /Invalid review comment/);
});

for (const selected of [false, true]) {
  for (const mode of ['cycle', 'limit', 'failure', 'missing cursor'] as const) {
    test(`${selected ? 'selected thread' : 'thread list'} rejects pagination ${mode}`, async () => {
      let calls = 0;
      const service = new Reviews(async () => {
        calls++;
        if (mode === 'failure' && calls === 2) { throw new Error('page failed'); }
        const cursor = mode === 'missing cursor' ? null : mode === 'cycle' ? (calls % 2 ? 'A' : 'B') : `p${calls}`;
        return JSON.stringify({ data: selected
          ? { node: { ...thread, pullRequest: { ...pr, url: 'https://github.com/o/r/pull/1' }, comments: page([comment], true, cursor) } }
          : { repository: { pullRequest: { ...pr, reviewThreads: page([], true, cursor) } } } });
      });
      await assert.rejects(selected ? service.readThread('/repo', 'https://github.com/o/r/pull/1', 'T1')
        : service.read('/repo', 'https://github.com/o/r/pull/1'), mode === 'failure' ? /page failed/ : mode === 'limit' ? /limit exceeded/ : /pagination cursor/);
      assert.equal(calls, mode === 'cycle' ? 3 : mode === 'limit' ? 100 : mode === 'failure' ? 2 : 1);
    });
  }
}

test('nested reply pagination also rejects cursor cycles', async () => {
  let calls = 0;
  const service = new Reviews(async () => {
    calls++;
    return calls === 1 ? payload([{ ...thread, comments: page([comment], true, 'A') }])
      : JSON.stringify({ data: { node: { comments: page([comment], true, calls === 2 ? 'B' : 'A') } } });
  });
  await assert.rejects(service.read('/repo', 'https://github.com/o/r/pull/1'), /pagination cursor/);
  assert.equal(calls, 3);
});

test('total request budget bounds nested replies across multiple threads', async () => {
  let calls = 0;
  const service = new Reviews(async args => {
    calls++;
    if (calls === 1) { return payload([1, 2, 3].map(id => ({ ...thread, id: `T${id}`, comments: page([comment], true, '1') }))); }
    const cursor = Number(args.find(arg => arg.startsWith('cursor='))!.slice(7));
    return JSON.stringify({ data: { node: { comments: page([comment], cursor < 99, String(cursor + 1)) } } });
  });
  await assert.rejects(service.read('/repo', 'https://github.com/o/r/pull/1'), /request limit exceeded/);
  assert.equal(calls, 200);
});

test('review anchors never map LEFT or outdated comments to current code', () => {
  assert.deepEqual(snapshotAnchor(pr, thread), { sha: oid, line: 2 });
  assert.deepEqual(snapshotAnchor(pr, { ...thread, isOutdated: true }), { sha: original, line: 1 });
  assert.equal(snapshotAnchor(pr, { ...thread, diffSide: 'LEFT' }), undefined);
  assert.equal(snapshotAnchor(pr, { ...thread, line: null }), undefined);
  assert.equal(snapshotAnchor(pr, { ...thread, line: -1 }), undefined);
  assert.equal(snapshotAnchor(pr, { ...thread, isOutdated: true, comments: [] }), undefined);
});

test('review paths reject traversal and Windows paths and preserve enterprise identity', () => {
  for (const path of ['../a', '/a', 'C:/a', 'a\\b', 'a/../b', 'a\0b', 'a//b']) { assert.equal(safeReviewPath(path), false, path); }
  assert.equal(safeReviewPath('src/a b.ts'), true);
  assert.deepEqual(prIdentity('https://git.example.com/o/r/pull/4/files'), { host: 'git.example.com', owner: 'o', repo: 'r', number: 4 });
});

test('paginates both threads and replies, including resolved threads', async () => {
  const calls: readonly string[][] = [];
  const responses = [payload([{ ...thread, comments: page([comment], true, 'reply') }], true),
    JSON.stringify({ data: { node: { comments: page([{ ...comment, body: 'Reply' }]) } } }),
    payload([{ ...thread, id: 'T2', isResolved: true, comments: page([comment]) }])];
  const service = new Reviews(async args => { (calls as string[][]).push([...args]); return responses.shift()!; });
  const result = await service.read('/repo', 'https://github.com/o/r/pull/1');
  assert.equal(result.threads.length, 2);
  assert.equal(result.threads[0].comments.length, 2);
  assert.equal(result.threads[1].isResolved, true);
  assert.ok(calls[1].includes('cursor=reply'));
  assert.ok(calls[2].includes('cursor=next'));
});

test('GraphQL partial errors fail rather than show incomplete counts', async () => {
  const service = new Reviews(async () => JSON.stringify({ errors: [{ message: 'denied' }], data: {} }));
  await assert.rejects(service.read('/repo', 'https://github.com/o/r/pull/1'), /complete review data/);
});

test('summary fetch loads one comment and counts replies without following reply pages', async () => {
  let calls = 0;
  const service = new Reviews(async args => {
    calls++;
    assert.match(args.join(' '), /comments\(first:1\)/);
    assert.doesNotMatch(args.join(' '), /diffHunk/);
    return payload([{ ...thread, comments: { ...page([comment], true, 'replies'), totalCount: 73 } }]);
  });
  const result = await service.read('/repo', 'https://github.com/o/r/pull/1', undefined, true);
  assert.equal(calls, 1);
  assert.equal(result.threads[0].comments.length, 1);
  assert.equal(result.threads[0].commentCount, 73);
});

test('selected-thread loading paginates only that thread and checks PR identity', async () => {
  let calls = 0;
  const service = new Reviews(async args => {
    calls++;
    assert.ok(args.includes('id=T1'));
    assert.doesNotMatch(args.join(' '), /reviewThreads/);
    return JSON.stringify({ data: { node: { ...thread, pullRequest: { ...pr, url: 'https://github.com/o/r/pull/1' },
      comments: page([comment], calls === 1, 'next') } } });
  });
  const result = await service.readThread('/repo', 'https://github.com/o/r/pull/1', 'T1');
  assert.equal(calls, 2);
  assert.equal(result.threads[0].comments.length, 2);
  await assert.rejects(service.readThread('/repo', 'https://github.com/other/r/pull/1', 'T1'), /different PR/);
});

test('checkout validates current stack membership and uses non-forced local switch', async () => {
  const calls: string[][] = [];
  const stack = JSON.stringify({ trunk: 'main', currentBranch: 'main', branches: [
    { name: 'feature', isCurrent: false, pr: { number: 1, url: 'https://github.com/o/r/pull/1', state: 'OPEN' } }
  ] });
  const service = new Reviews(async () => stack, async (args, root) => {
    assert.equal(root, '/repo'); calls.push([...args]); return args[0] === 'symbolic-ref' ? 'feature\n' : '';
  });
  await assert.rejects(service.checkout('/repo', 'other', 'https://github.com/o/r/pull/1'), /stack changed/);
  await assert.rejects(service.checkout('/repo', 'feature', 'https://github.com/foreign/r/pull/1'), /stack changed/);
  assert.equal(calls.length, 0);
  await service.checkout('/repo', 'feature', 'https://github.com/o/r/pull/1');
  assert.deepEqual(calls[0], ['switch', '--no-guess', '--', 'feature']);
});

test('failed checkout does not continue to HEAD validation', async () => {
  let calls = 0;
  const service = new Reviews(async () => JSON.stringify({ trunk: 'main', currentBranch: 'main', branches: [
    { name: 'feature', isCurrent: false, pr: { number: 1, url: 'https://github.com/o/r/pull/1', state: 'OPEN' } }
  ] }), async () => { calls++; throw new Error('local changes'); });
  await assert.rejects(service.checkout('/repo', 'feature', 'https://github.com/o/r/pull/1'), /local changes/);
  assert.equal(calls, 1);
});

test('snapshot fetch pins the SHA, encodes paths and rejects invalid references', async () => {
  let calls = 0;
  const service = new Reviews(async args => {
    calls++;
    assert.ok(args.includes(`repos/o/r/contents/src/a%20b.ts?ref=${oid}`));
    return JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from('text').toString('base64') });
  });
  assert.equal(await service.content('/repo', 'https://github.com/o/r/pull/1', oid, 'src/a b.ts'), 'text');
  await assert.rejects(service.content('/repo', 'https://github.com/o/r/pull/1', oid, '../secret'));
  await assert.rejects(service.content('/repo', 'https://github.com/o/r/pull/1', 'main', 'src/a b.ts'));
  assert.equal(calls, 1);
});
