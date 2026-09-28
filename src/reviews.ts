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

function connection(value: any): { nodes: any[]; pageInfo: { hasNextPage: boolean; endCursor: string | null }; totalCount?: number } {
  if (!value || !Array.isArray(value.nodes) || typeof value.pageInfo?.hasNextPage !== 'boolean') {
    throw new Error('Invalid review connection. Refresh the overview.');
  }
  return { nodes: value.nodes.filter((node: unknown) => node != null), pageInfo: value.pageInfo,
    totalCount: Number.isSafeInteger(value.totalCount) && value.totalCount >= 0 ? value.totalCount : undefined };
}

class Pagination {
  private readonly seen = new Set<string>();
  private pages = 1;
  next(page: { hasNextPage: boolean; endCursor: string | null }): string | undefined {
    if (!page.hasNextPage) { return undefined; }
    const cursor = page.endCursor;
    if (typeof cursor !== 'string' || !cursor || this.seen.has(cursor)) { throw new Error('Invalid review pagination cursor.'); }
    if (++this.pages > 100) { throw new Error('Review pagination limit exceeded. Results are incomplete; try viewing this PR on GitHub.'); }
    this.seen.add(cursor);
    return cursor;
  }
}

function parseComment(raw: any, summary: boolean): ReviewComment {
  if (!raw || typeof raw.body !== 'string' || (raw.author != null && typeof raw.author.login !== 'string') ||
    (!summary && (typeof raw.url !== 'string' || typeof raw.diffHunk !== 'string' ||
      (raw.originalCommit != null && typeof raw.originalCommit.oid !== 'string')))) {
    throw new Error('Invalid review comment. Refresh the overview.');
  }
  return { body: raw.body, author: raw.author ? { login: raw.author.login } : null,
    url: summary ? '' : raw.url, diffHunk: summary ? '' : raw.diffHunk,
    originalCommit: !summary && raw.originalCommit ? { oid: raw.originalCommit.oid } : null };
}

function parseThread(raw: any, comments: ReviewComment[], commentCount?: number): ReviewThread {
  const validLine = (line: unknown) => line === null || (Number.isSafeInteger(line) && (line as number) > 0);
  if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.path !== 'string' || !safeReviewPath(raw.path) ||
    !validLine(raw.line) || !validLine(raw.originalLine) || !['LEFT', 'RIGHT'].includes(raw.diffSide) ||
    typeof raw.isOutdated !== 'boolean' || typeof raw.isResolved !== 'boolean') {
    throw new Error('Invalid review thread. Refresh the overview.');
  }
  return { id: raw.id, path: raw.path, line: raw.line, originalLine: raw.originalLine,
    diffSide: raw.diffSide, isOutdated: raw.isOutdated, isResolved: raw.isResolved, comments,
    commentCount: commentCount ?? comments.length };
}

function parsePr(raw: any): ReviewPr {
  if (!raw || typeof raw.title !== 'string' || !['OPEN', 'CLOSED', 'MERGED'].includes(raw.state) ||
    typeof raw.isDraft !== 'boolean' || typeof raw.headRefOid !== 'string' ||
    (raw.reviewDecision != null && typeof raw.reviewDecision !== 'string')) { throw new Error('Invalid review PR metadata.'); }
  return { title: raw.title, state: raw.state, isDraft: raw.isDraft, headRefOid: raw.headRefOid,
    reviewDecision: raw.reviewDecision ?? null,
    checks: typeof raw.statusCheckRollup?.state === 'string' ? raw.statusCheckRollup.state : undefined, threads: [] };
}

export function workspaceReviewLine(thread: ReviewThread): number | null {
  return thread.isOutdated ? thread.originalLine
    : thread.line ?? (thread.diffSide === 'LEFT' ? thread.originalLine : null);
}

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
    const pages = new Pagination(), budget = { remaining: 200 };
    do {
      const data = await this.graph(root, identity.host, query,
        { owner: identity.owner, repo: identity.repo, number: identity.number, ...(cursor ? { cursor } : {}) }, signal, budget);
      const pr = data.repository?.pullRequest;
      if (!pr || !Array.isArray(pr.reviewThreads?.nodes)) { throw new Error('Could not read PR review threads.'); }
      if (result && result.headRefOid !== pr.headRefOid) { throw new Error('PR changed while loading. Refresh the overview.'); }
      result ??= parsePr(pr);
      const threads = connection(pr.reviewThreads);
      for (const raw of threads.nodes) {
        const first = connection(raw.comments);
        const comments = first.nodes.map(node => parseComment(node, summary));
        const parsed = parseThread(raw, comments, first.totalCount);
        const replies = new Pagination();
        let replyCursor = summary ? undefined : replies.next(first.pageInfo);
        while (replyCursor) {
          const more = await this.graph(root, identity.host,
            `query($id:ID!,$cursor:String!) { node(id:$id) { ... on PullRequestReviewThread {
              comments(first:50,after:$cursor) { nodes { ${commentFields} } pageInfo { hasNextPage endCursor } }
            } } }`, { id: parsed.id, cursor: replyCursor }, signal, budget);
          const next = connection(more.node?.comments);
          comments.push(...next.nodes.map(node => parseComment(node, false)));
          replyCursor = replies.next(next.pageInfo);
        }
        parsed.commentCount = first.totalCount ?? comments.length;
        result.threads.push(parsed);
      }
      cursor = pages.next(threads.pageInfo);
    } while (cursor);
    return result!;
  }

  async readThread(root: string, url: string, id: string, signal?: AbortSignal): Promise<ReviewPr> {
    const identity = prIdentity(url);
    let cursor: string | undefined;
    let result: ReviewPr | undefined;
    const pages = new Pagination(), budget = { remaining: 200 };
    do {
      const data = await this.graph(root, identity.host,
        `query($id:ID!,$cursor:String) { node(id:$id) { ... on PullRequestReviewThread {
          id path line originalLine diffSide isOutdated isResolved
          pullRequest { url title state isDraft reviewDecision headRefOid statusCheckRollup { state } }
          comments(first:50,after:$cursor) { totalCount nodes { ${commentFields} } pageInfo { hasNextPage endCursor } }
        } } }`, { id, ...(cursor ? { cursor } : {}) }, signal, budget);
      const raw = data.node;
      if (!raw?.pullRequest || normalizePrUrl(raw.pullRequest.url) !== normalizePrUrl(url)) {
        throw new Error('This thread no longer exists or belongs to a different PR.');
      }
      if (result && (result.headRefOid !== raw.pullRequest.headRefOid ||
        result.threads[0].line !== raw.line || result.threads[0].isOutdated !== raw.isOutdated)) {
        throw new Error('PR changed while loading the thread. Select it again.');
      }
      if (!result) {
        result = parsePr(raw.pullRequest);
        result.threads = [parseThread(raw, [], connection(raw.comments).totalCount)];
      }
      const comments = connection(raw.comments);
      result!.threads[0].comments.push(...comments.nodes.map(node => parseComment(node, false)));
      result!.threads[0].commentCount = comments.totalCount ?? result!.threads[0].comments.length;
      cursor = pages.next(comments.pageInfo);
    } while (cursor);
    return result!;
  }

  private async graph(root: string, host: string, query: string, fields: Record<string, string | number>, signal: AbortSignal | undefined, budget: { remaining: number }) {
    if (--budget.remaining < 0) { throw new Error('Review request limit exceeded. Results are incomplete; try viewing this PR on GitHub.'); }
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
