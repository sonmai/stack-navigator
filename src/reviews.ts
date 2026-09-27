import { runGh, runGit, StackCli } from './cli';
import { normalizePrUrl, parseStack } from './core';

export interface ReviewComment {
  body: string;
  author: { login: string } | null;
  url: string;
  diffHunk: string;
  originalCommit: { oid: string } | null;
}
export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  diffSide: 'LEFT' | 'RIGHT';
  isOutdated: boolean;
  isResolved: boolean;
  comments: ReviewComment[];
  commentCount?: number;
}
export interface ReviewPr {
  title: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  headRefOid: string;
  checks?: string;
  threads: ReviewThread[];
}
type Runner = typeof runGh;
const commentFields = 'body author { login } url diffHunk originalCommit { oid }';

export function prIdentity(url: string) {
  const parsed = new URL(normalizePrUrl(url));
  const [, owner, repo, , number] = parsed.pathname.split('/');
  return { host: parsed.host, owner, repo, number: Number(number) };
}

export function safeReviewPath(path: string): boolean {
  return !!path && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') &&
    !path.includes(':') && path.split('/').every(part => part !== '..' && part !== '.' && part !== '');
}

export function snapshotAnchor(pr: ReviewPr, thread: ReviewThread): { sha: string; line: number } | undefined {
  // LEFT-side and unavailable historical coordinates use the actual diff hunk, never a guessed parent.
  if (thread.diffSide !== 'RIGHT') { return undefined; }
  const sha = thread.isOutdated ? thread.comments[0]?.originalCommit?.oid : pr.headRefOid;
  const line = thread.isOutdated ? thread.originalLine : thread.line;
  return sha && /^[a-f0-9]{40,64}$/i.test(sha) && line && Number.isSafeInteger(line) && line > 0
    ? { sha, line } : undefined;
}

export class Reviews {
  constructor(private readonly gh: Runner = runGh, private readonly git: Runner = runGit) {}

  async read(root: string, url: string, signal?: AbortSignal, summary = false): Promise<ReviewPr> {
    const identity = prIdentity(url);
    const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String) {
      repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
        title state isDraft reviewDecision headRefOid statusCheckRollup { state }
        reviewThreads(first:50,after:$cursor) { pageInfo { hasNextPage endCursor } nodes {
          id path line originalLine diffSide isOutdated isResolved
          comments(first:${summary ? 1 : 50}) { totalCount pageInfo { hasNextPage endCursor } nodes { ${summary ? 'body author { login }' : commentFields} } }
        } }
      } }
    }`;
    let cursor: string | undefined;
    let result: ReviewPr | undefined;
    do {
      const data = await this.graph(root, identity.host, query,
        { owner: identity.owner, repo: identity.repo, number: identity.number, ...(cursor ? { cursor } : {}) }, signal);
      const pr = data.repository?.pullRequest;
      if (!pr || !Array.isArray(pr.reviewThreads?.nodes)) { throw new Error('Could not read PR review threads.'); }
      if (result && result.headRefOid !== pr.headRefOid) { throw new Error('PR changed while loading. Refresh the overview.'); }
      result ??= { title: pr.title, state: pr.state, isDraft: pr.isDraft,
        reviewDecision: pr.reviewDecision, headRefOid: pr.headRefOid, checks: pr.statusCheckRollup?.state, threads: [] };
      for (const raw of pr.reviewThreads.nodes) {
        const comments = [...raw.comments.nodes] as ReviewComment[];
        let next = raw.comments.pageInfo;
        while (!summary && next.hasNextPage) {
          if (!next.endCursor) { throw new Error('Missing comment pagination cursor.'); }
          const previousCursor = next.endCursor;
          const more = await this.graph(root, identity.host,
            `query($id:ID!,$cursor:String!) { node(id:$id) { ... on PullRequestReviewThread {
              comments(first:50,after:$cursor) { nodes { ${commentFields} } pageInfo { hasNextPage endCursor } }
            } } }`, { id: raw.id, cursor: next.endCursor }, signal);
          comments.push(...more.node.comments.nodes);
          next = more.node.comments.pageInfo;
          if (next.hasNextPage && next.endCursor === previousCursor) { throw new Error('Invalid comment pagination cursor.'); }
        }
        result.threads.push({ ...raw, comments, commentCount: raw.comments.totalCount ?? comments.length });
      }
      const page = pr.reviewThreads.pageInfo;
      if (page.hasNextPage && (!page.endCursor || page.endCursor === cursor)) { throw new Error('Invalid thread pagination cursor.'); }
      cursor = page.hasNextPage ? page.endCursor : undefined;
    } while (cursor);
    return result!;
  }

  async readThread(root: string, url: string, id: string, signal?: AbortSignal): Promise<ReviewPr> {
    const identity = prIdentity(url);
    let cursor: string | undefined;
    let result: ReviewPr | undefined;
    do {
      const data = await this.graph(root, identity.host,
        `query($id:ID!,$cursor:String) { node(id:$id) { ... on PullRequestReviewThread {
          id path line originalLine diffSide isOutdated isResolved
          pullRequest { url title state isDraft reviewDecision headRefOid statusCheckRollup { state } }
          comments(first:50,after:$cursor) { totalCount nodes { ${commentFields} } pageInfo { hasNextPage endCursor } }
        } } }`, { id, ...(cursor ? { cursor } : {}) }, signal);
      const raw = data.node;
      if (!raw?.pullRequest || normalizePrUrl(raw.pullRequest.url) !== normalizePrUrl(url)) {
        throw new Error('This thread no longer exists or belongs to a different PR.');
      }
      if (result && (result.headRefOid !== raw.pullRequest.headRefOid ||
        result.threads[0].line !== raw.line || result.threads[0].isOutdated !== raw.isOutdated)) {
        throw new Error('PR changed while loading the thread. Select it again.');
      }
      if (!result) {
        result = { ...raw.pullRequest, checks: raw.pullRequest.statusCheckRollup?.state,
          threads: [{ ...raw, comments: [], commentCount: raw.comments.totalCount }] };
      }
      result!.threads[0].comments.push(...raw.comments.nodes);
      const page = raw.comments.pageInfo;
      if (page.hasNextPage && (!page.endCursor || page.endCursor === cursor)) { throw new Error('Invalid comment pagination cursor.'); }
      cursor = page.hasNextPage ? page.endCursor : undefined;
    } while (cursor);
    return result!;
  }

  private async graph(root: string, host: string, query: string, fields: Record<string, string | number>, signal?: AbortSignal) {
    const args = ['api', '--hostname', host, 'graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(fields)) { args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`); }
    const response = JSON.parse(await this.gh(args, root, signal));
    if (response.errors?.length || !response.data) { throw new Error('GitHub could not return complete review data.'); }
    return response.data;
  }

  async content(root: string, url: string, sha: string, path: string): Promise<string> {
    if (!safeReviewPath(path) || !/^[a-f0-9]{40,64}$/i.test(sha)) { throw new Error('Invalid review file reference.'); }
    const { host, owner, repo } = prIdentity(url);
    const endpoint = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`;
    const data = JSON.parse(await this.gh(['api', '--hostname', host, endpoint], root));
    if (data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string') {
      throw new Error('This review file cannot be displayed as text.');
    }
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    if (content.includes('\0')) { throw new Error('Binary review files cannot be displayed as text.'); }
    return content;
  }

  async checkout(root: string, branch: string, url: string): Promise<void> {
    const state = parseStack(await new StackCli((args, cwd, signal) => this.gh(args, cwd, signal)).view(root));
    if ((state.type !== 'loaded' && state.type !== 'trunk') ||
      !state.stack.branches.some(b => b.name === branch && b.pr && normalizePrUrl(b.pr.url) === normalizePrUrl(url))) {
      throw new Error('The stack changed. Refresh and select the comment again.');
    }
    await this.git(['switch', '--no-guess', '--', branch], root);
    if ((await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root)).trim() !== branch) {
      throw new Error('The checked-out branch changed unexpectedly.');
    }
  }
}
