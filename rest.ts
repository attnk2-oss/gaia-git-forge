// REST v3 API under /api/v3. A small, exact slice of GitHub's API: repositories,
// issues, pull requests, contents, refs, branches, labels, comments, and the
// API root. Everything is served from the Forge store; nothing leaves the process.
//
// Response rules the suite relies on:
// - every reply is JSON with a non-empty X-GitHub-Request-Id header;
// - unknown routes are 404 JSON; malformed JSON bodies are 400 JSON;
// - a repo under another owner is 404, never 403;
// - issues and pull requests share one numbering counter per repo;
// - ids are stable across reads (sequential numeric ids), and timestamps come
//   from a counter seeded at a fixed epoch, so a replay is byte-identical.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Forge,
  VIEWER_ID,
  VIEWER_LOGIN,
  ZERO_OID,
  commentGlobalId,
  isoOf,
  issueGlobalId,
  hashObject,
  parseCommit,
  parseTree,
  pullGlobalId,
  repoGlobalId,
  type Issue,
  type IssueComment,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';
import {
  newRequestId,
  originOf,
  pageLinks,
  parseJsonBody,
  pathSegments,
  queryInt,
  queryOf,
  readBody,
  sendJson,
} from './util.ts';

export interface RestContext {
  forge: Forge;
  token: string;
}

type Handler = (ctx: RestContext, req: IncomingMessage, res: ServerResponse) => Promise<void>;

const USER_JSON = { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' };

// ---------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(VIEWER_LOGIN, repo.name),
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    owner: { ...USER_JSON },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoOf(repo.createdSeq),
    updated_at: isoOf(repo.updatedSeq),
    pushed_at: isoOf(repo.pushedSeq),
    html_url: `https://github.invalid/${VIEWER_LOGIN}/${repo.name}`,
    clone_url: `https://github.invalid/${VIEWER_LOGIN}/${repo.name}.git`,
    git_url: `git://github.invalid/${VIEWER_LOGIN}/${repo.name}.git`,
    ssh_url: `git@github.invalid:${VIEWER_LOGIN}/${repo.name}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    fork: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
    language: null,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    size: 0,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Buffer.from(`L:${label.id}`, 'utf8').toString('base64url'),
    name: label.name,
    color: label.color,
    description: '',
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(VIEWER_LOGIN, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    comments: issue.comments.length,
    created_at: isoOf(issue.createdSeq),
    updated_at: isoOf(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? isoOf(issue.updatedSeq) : null,
    user: { ...USER_JSON },
    html_url: `https://github.invalid/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    locked: false,
    draft: false,
    pull_request: null,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(VIEWER_LOGIN, repo.name, issue.number, comment.id),
    body: comment.body,
    created_at: isoOf(comment.createdSeq),
    updated_at: isoOf(comment.createdSeq),
    user: { ...USER_JSON },
    html_url: `https://github.invalid/${VIEWER_LOGIN}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  const headTip = forge.resolveToCommit(repo, pull.headRef);
  const baseTip = forge.resolveToCommit(repo, pull.baseRef);
  const mergeable = headTip !== null && baseTip !== null ? forge.mergePlan(repo, pull).ok : false;
  return {
    id: pull.id,
    node_id: pullGlobalId(VIEWER_LOGIN, repo.name, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${VIEWER_LOGIN}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${VIEWER_LOGIN}:${pull.baseRef}` },
    created_at: isoOf(pull.createdSeq),
    updated_at: isoOf(pull.updatedSeq),
    closed_at: pull.state === 'closed' ? isoOf(pull.updatedSeq) : null,
    user: { ...USER_JSON },
    html_url: `https://github.invalid/${VIEWER_LOGIN}/${repo.name}/pull/${pull.number}`,
    locked: false,
    draft: false,
  };
}

function branchJson(repo: Repo, name: string): Record<string, unknown> {
  return {
    name,
    commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? ZERO_OID },
    protected: false,
  };
}

function refJson(ref: string, oid: string, type: string): Record<string, unknown> {
  return { ref, object: { sha: oid, type, url: '' } };
}

/** Parse a git ident line `Name <email> 1700000001 +0000` into its parts. */
function parseIdent(raw: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(raw);
  if (!match) return { name: raw, email: '', date: isoOf(0) };
  return {
    name: match[1]!,
    email: match[2]!,
    date: new Date(Number.parseInt(match[3]!, 10) * 1000).toISOString(),
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') throw new Error(`commit ${sha} not found`);
  const commit = parseCommit(obj.data);
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  return {
    sha,
    node_id: Buffer.from(`C:${repo.id}:${sha}`, 'utf8').toString('base64url'),
    commit: {
      message: commit.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((p) => ({ sha: p })),
    author: { ...USER_JSON },
    committer: { ...USER_JSON },
  };
}

// ---------------------------------------------------------------------------
// request helpers
// ---------------------------------------------------------------------------

interface ApiError {
  status: number;
  message: string;
}

function fail(status: number, message: string): ApiError {
  return { status, message };
}

function isApiError(value: unknown): value is ApiError {
  return typeof value === 'object' && value !== null && 'status' in value && 'message' in value;
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = parseJsonBody(body);
  } catch {
    throw fail(400, 'Problems parsing JSON');
  }
  if (parsed === null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw fail(400, 'Problems parsing JSON');
  return parsed as Record<string, unknown>;
}

function requireAuth(ctx: RestContext, req: IncomingMessage): void {
  const header = req.headers.authorization ?? '';
  const expected = ctx.token ? `Bearer ${ctx.token}` : '';
  const ok = ctx.token === '' ? header.startsWith('Bearer ') && header.length > 7 : header === expected;
  if (!ok) throw fail(401, 'Bad credentials');
}

function requireRepo(ctx: RestContext, owner: string, name: string): Repo {
  if (owner.toLowerCase() !== VIEWER_LOGIN.toLowerCase()) throw fail(404, 'Not Found');
  const repo = ctx.forge.getRepo(name);
  if (!repo) throw fail(404, 'Not Found');
  return repo;
}

function paginate<T>(items: readonly T[], req: IncomingMessage): { pageItems: T[]; link: string | null } {
  const query = queryOf(req);
  const page = queryInt(query, 'page', 1);
  const perPage = Math.min(100, queryInt(query, 'per_page', 30));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const path = new URL(req.url ?? '/', 'http://entry').pathname;
  const link = pageLinks(originOf(req), path, query, page, perPage, items.length);
  return { pageItems, link };
}

function sendPage<T>(res: ServerResponse, req: IncomingMessage, items: readonly T[], json: (item: T) => unknown): void {
  const { pageItems, link } = paginate(items, req);
  sendJson(res, 200, pageItems.map(json), link ? { Link: link } : {});
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

/** Walk a tree to a nested path; returns the subtree oid, or null. */
function subtreeAt(repo: Repo, treeOid: string, path: string): string | null {
  const parts = path.split('/').filter((p) => p !== '');
  let current = treeOid;
  for (const part of parts) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

/** Blob oid at a path in a tree, or null when the path is not a file. */
function blobAt(repo: Repo, treeOid: string, path: string): string | null {
  const parts = path.split('/').filter((p) => p !== '');
  const name = parts.pop();
  if (!name) return null;
  const parent = parts.length === 0 ? treeOid : subtreeAt(repo, treeOid, parts.join('/'));
  if (!parent) return null;
  const obj = repo.objects.get(parent);
  if (!obj || obj.type !== 'tree') return null;
  const entry = parseTree(obj.data).find((e) => e.name === name && e.mode !== '40000' && e.mode !== '160000');
  return entry ? entry.oid : null;
}

function fileJson(repo: Repo, path: string, name: string, blobOid: string): Record<string, unknown> {
  const obj = repo.objects.get(blobOid);
  const size = obj ? obj.data.length : 0;
  const content = obj ? obj.data.toString('base64') : '';
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name,
    path,
    content,
    sha: blobOid,
    url: '',
    html_url: '',
    git_url: '',
    download_url: '',
  };
}

function dirJson(repo: Repo, treeOid: string, path: string): Array<Record<string, unknown>> {
  const dirOid = path === '' ? treeOid : subtreeAt(repo, treeOid, path);
  if (!dirOid) throw fail(404, 'Not Found');
  const obj = repo.objects.get(dirOid);
  if (!obj || obj.type !== 'tree') throw fail(404, 'Not Found');
  return parseTree(obj.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    url: '',
    html_url: '',
    git_url: '',
    download_url: '',
  }));
}

interface ContentsCommitResult {
  commitSha: string;
  blobSha: string;
  created: boolean;
}

function contentsCommit(
  forge: Forge,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  expectedSha: string | null,
  deleteFile: boolean,
): ContentsCommitResult {
  const branchRef = `refs/heads/${branch}`;
  const tip = repo.refs.get(branchRef);
  let treeOid: string | null = null;
  const parents: string[] = [];
  if (tip) {
    const commitObj = repo.objects.get(tip);
    if (commitObj && commitObj.type === 'commit') {
      treeOid = parseCommit(commitObj.data).tree;
      parents.push(tip);
    }
  } else {
    // Fork the branch from the default tip; an unborn repo starts from nothing.
    const base = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (base) {
      const commitObj = repo.objects.get(base);
      if (commitObj && commitObj.type === 'commit') {
        treeOid = parseCommit(commitObj.data).tree;
        parents.push(base);
      }
    }
  }
  const existing = treeOid ? blobAt(repo, treeOid, path) : null;
  if (deleteFile) {
    if (!existing) throw fail(404, 'Not Found');
    if (expectedSha && expectedSha.toLowerCase() !== existing.toLowerCase()) throw fail(409, 'sha does not match');
  } else if (expectedSha && existing && expectedSha.toLowerCase() !== existing.toLowerCase()) {
    throw fail(409, 'sha does not match');
  }
  const blobSha = deleteFile ? existing! : hashObject('blob', content);
  const newTree = deleteFile
    ? forge.updateTree(repo, treeOid, new Map([[path, null]]))
    : forge.updateTree(repo, treeOid, new Map([[path, content]]));
  if (!deleteFile && !repo.objects.has(blobSha)) repo.objects.set(blobSha, { type: 'blob', data: content });
  const commit = forge.makeCommit(repo, { tree: newTree, parents, message });
  forge.setRef(repo, branchRef, commit);
  return { commitSha: commit, blobSha, created: existing === null };
}

// ---------------------------------------------------------------------------
// diff helpers
// ---------------------------------------------------------------------------

/** Line-level additions/deletions between two blobs, by multiset difference. */
export function countLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

export function blobText(repo: Repo, oid: string | null): string {
  if (!oid) return '';
  const obj = repo.objects.get(oid);
  return obj && obj.type === 'blob' ? obj.data.toString('utf8') : '';
}

// ---------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------

const handlers: Array<{ method: string; pattern: RegExp; fn: Handler }> = [];

function route(method: string, pattern: RegExp, fn: Handler): void {
  handlers.push({ method, pattern, fn });
}

function routePath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return req.url ?? '/';
  }
}

route('GET', /^\/api\/v3\/?$/, async (_ctx, _req, res) => {
  sendJson(res, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo, read:org' });
});

route('GET', /^\/api\/v3\/meta$/, async (_ctx, _req, res) => {
  sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0' });
});

route('GET', /^\/api\/v3\/user$/, async (_ctx, _req, res) => {
  sendJson(res, 200, {
    ...USER_JSON,
    name: VIEWER_LOGIN,
    email: `${VIEWER_LOGIN}@example.invalid`,
    avatar_url: '',
    html_url: `https://github.invalid/${VIEWER_LOGIN}`,
  });
});

// -- repositories ----------------------------------------------------------

route('POST', /^\/api\/v3\/user\/repos$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const body = await jsonBody(req);
  const name = asString(body.name);
  if (!name || name.includes('/') || name === '.' || name === '..') throw fail(422, 'Repository name is invalid');
  if (ctx.forge.getRepo(name)) throw fail(422, 'name already exists on this account');
  const repo = ctx.forge.createRepo(name, asString(body.description) ?? '', asBool(body.private, false));
  if (!repo) throw fail(422, 'name already exists on this account');
  sendJson(res, 201, repoJson(repo));
});

route('GET', /^\/api\/v3\/user\/repos$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  sendPage(res, req, ctx.forge.listRepos(), (repo) => repoJson(repo));
});

route('GET', /^\/api\/v3\/users\/([^/]+)\/repos$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const owner = pathSegments(req)[3]!;
  if (owner.toLowerCase() !== VIEWER_LOGIN.toLowerCase()) throw fail(404, 'Not Found');
  sendPage(res, req, ctx.forge.listRepos(), (repo) => repoJson(repo));
});

route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const [, , , owner, name] = pathSegments(req);
  sendJson(res, 200, repoJson(requireRepo(ctx, owner!, name!)));
});

route('PATCH', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const [, , , owner, name] = pathSegments(req);
  const repo = requireRepo(ctx, owner!, name!);
  const body = await jsonBody(req);
  const description = asString(body.description);
  if (description !== null) repo.description = description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  const name2 = asString(body.name);
  if (name2 !== null && name2 !== repo.name) {
    if (ctx.forge.getRepo(name2)) throw fail(422, 'name already exists on this account');
    ctx.forge.repos.delete(repo.name);
    repo.name = name2;
    ctx.forge.repos.set(name2, repo);
  }
  repo.updatedSeq = ctx.forge.bumpSeq();
  sendJson(res, 200, repoJson(repo));
});

route('DELETE', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const [, , , owner, name] = pathSegments(req);
  requireRepo(ctx, owner!, name!);
  ctx.forge.deleteRepo(name!);
  res.writeHead(204, { 'x-github-request-id': newRequestId() });
  res.end();
});

// -- refs -------------------------------------------------------------------

route('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const [, , , owner, name] = pathSegments(req);
  const repo = requireRepo(ctx, owner!, name!);
  const body = await jsonBody(req);
  const ref = asString(body.ref);
  const sha = asString(body.sha);
  if (!ref || !ref.startsWith('refs/') || !sha) throw fail(422, 'Invalid request');
  if (repo.refs.has(ref)) throw fail(422, 'Reference already exists');
  const obj = repo.objects.get(sha);
  if (!obj) throw fail(422, 'Object does not exist');
  ctx.forge.setRef(repo, ref, sha);
  sendJson(res, 201, refJson(ref, sha, obj.type));
});

route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/([^/]+)$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const segments = pathSegments(req);
  const owner = segments[3]!;
  const name = segments[4]!;
  const branch = segments[8]!;
  const repo = requireRepo(ctx, owner!, name!);
  const ref = `refs/heads/${branch}`;
  const oid = repo.refs.get(ref);
  if (!oid) throw fail(404, 'Not Found');
  const obj = repo.objects.get(oid);
  sendJson(res, 200, refJson(ref, oid, obj?.type ?? 'commit'));
});

// -- branches ---------------------------------------------------------------

route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const [, , , owner, name] = pathSegments(req);
  const repo = requireRepo(ctx, owner!, name!);
  const branches = ctx.forge
    .sortedRefs(repo)
    .filter((r) => r.name.startsWith('refs/heads/'))
    .map((r) => r.name.slice('refs/heads/'.length));
  sendPage(res, req, branches, (branch) => branchJson(repo, branch));
});

route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const segments = pathSegments(req);
  const owner = segments[3]!;
  const name = segments[4]!;
  const branch = segments[6]!;
  const repo = requireRepo(ctx, owner!, name!);
  if (!repo.refs.has(`refs/heads/${branch}`)) throw fail(404, 'Not Found');
  sendJson(res, 200, branchJson(repo, branch!));
});

// -- commits ----------------------------------------------------------------

route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/commits$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const [, , , owner, name] = pathSegments(req);
  const repo = requireRepo(ctx, owner!, name!);
  const query = queryOf(req);
  const ref = query.get('sha') ?? repo.defaultBranch;
  const tip = ctx.forge.resolveToCommit(repo, ref);
  if (!tip) throw fail(404, 'Not Found');
  sendPage(res, req, ctx.forge.commitsFrom(repo, tip), (sha) => commitJson(repo, sha));
});

// -- contents ---------------------------------------------------------------

route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.*)$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const [, , , owner, name] = pathSegments(req);
  const repo = requireRepo(ctx, owner!, name!);
  const path = routePath(req).replace(/^\/api\/v3\/repos\/[^/]+\/[^/]+\/contents\/?/, '');
  const query = queryOf(req);
  const ref = query.get('ref') ?? repo.defaultBranch;
  const tip = ctx.forge.resolveToCommit(repo, ref);
  if (!tip) throw fail(404, 'Not Found');
  const treeOid = ctx.forge.treeOfCommit(repo, tip);
  if (!treeOid) throw fail(404, 'Not Found');
  const decoded = decodeURIComponent(path);
  if (decoded === '') {
    sendJson(res, 200, dirJson(repo, treeOid, ''));
    return;
  }
  const blob = blobAt(repo, treeOid, decoded);
  if (blob) {
    const name2 = decoded.split('/').pop()!;
    sendJson(res, 200, fileJson(repo, decoded, name2, blob));
    return;
  }
  if (subtreeAt(repo, treeOid, decoded)) {
    sendJson(res, 200, dirJson(repo, treeOid, decoded));
    return;
  }
  throw fail(404, 'Not Found');
});

route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const [, , , owner, name] = pathSegments(req);
  const repo = requireRepo(ctx, owner!, name!);
  const query = queryOf(req);
  const ref = query.get('ref') ?? repo.defaultBranch;
  const tip = ctx.forge.resolveToCommit(repo, ref);
  if (!tip) throw fail(404, 'Not Found');
  const treeOid = ctx.forge.treeOfCommit(repo, tip);
  if (!treeOid) throw fail(404, 'Not Found');
  sendJson(res, 200, dirJson(repo, treeOid, ''));
});

route('PUT', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.*)$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const [, , , owner, name] = pathSegments(req);
  const repo = requireRepo(ctx, owner!, name!);
  const path = decodeURIComponent(routePath(req).replace(/^\/api\/v3\/repos\/[^/]+\/[^/]+\/contents\/?/, ''));
  const body = await jsonBody(req);
  const message = asString(body.message) ?? `Update ${path}`;
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const expectedSha = asString(body.sha);
  const encoded = asString(body.content);
  if (encoded === null) throw fail(422, 'content is required');
  const content = Buffer.from(encoded, 'base64');
  const result = contentsCommit(ctx.forge, repo, branch, path, content, message, expectedSha, false);
  const name2 = path.split('/').pop()!;
  const treeOid = ctx.forge.treeOfCommit(repo, result.commitSha)!;
  const blob = blobAt(repo, treeOid, path)!;
  sendJson(res, result.created ? 201 : 200, {
    content: fileJson(repo, path, name2, blob),
    commit: { sha: result.commitSha, message },
  });
});

route('DELETE', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.*)$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const [, , , owner, name] = pathSegments(req);
  const repo = requireRepo(ctx, owner!, name!);
  const path = decodeURIComponent(routePath(req).replace(/^\/api\/v3\/repos\/[^/]+\/[^/]+\/contents\/?/, ''));
  const body = await jsonBody(req);
  const message = asString(body.message) ?? `Delete ${path}`;
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const expectedSha = asString(body.sha);
  const result = contentsCommit(ctx.forge, repo, branch, path, Buffer.alloc(0), message, expectedSha, true);
  sendJson(res, 200, { commit: { sha: result.commitSha, message } });
});

// -- labels -----------------------------------------------------------------

route('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const [, , , owner, name] = pathSegments(req);
  const repo = requireRepo(ctx, owner!, name!);
  const body = await jsonBody(req);
  const labelName = asString(body.name);
  if (!labelName) throw fail(422, 'name is required');
  const color = (asString(body.color) ?? 'ededed').replace(/^#/, '').toLowerCase();
  const existing = repo.labels.get(labelName);
  if (existing) {
    existing.color = color;
    sendJson(res, 200, labelJson(existing));
    return;
  }
  const label = ctx.forge.createLabel(repo, labelName, color);
  sendJson(res, 201, labelJson(label));
});

route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const [, , , owner, name] = pathSegments(req);
  const repo = requireRepo(ctx, owner!, name!);
  sendPage(res, req, [...repo.labels.values()], (label) => labelJson(label));
});

// -- issues -----------------------------------------------------------------

route('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const [, , , owner, name] = pathSegments(req);
  const repo = requireRepo(ctx, owner!, name!);
  const body = await jsonBody(req);
  const title = asString(body.title);
  if (!title) throw fail(422, 'title is required');
  const labelNames = asStringArray(body.labels);
  for (const labelName of labelNames) {
    if (!repo.labels.has(labelName)) throw fail(422, `Label does not exist: ${labelName}`);
  }
  const issue = ctx.forge.createIssue(repo, title, asString(body.body) ?? '', labelNames);
  sendJson(res, 201, issueJson(repo, issue));
});

route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const [, , , owner, name] = pathSegments(req);
  const repo = requireRepo(ctx, owner!, name!);
  const query = queryOf(req);
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((i) => i.state === state);
  issues = [...issues].sort((a, b) =>
    direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq,
  );
  sendPage(res, req, issues, (issue) => issueJson(repo, issue));
});

route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const segments = pathSegments(req);
  const owner = segments[3]!;
  const name = segments[4]!;
  const number = segments[6]!;
  const repo = requireRepo(ctx, owner!, name!);
  const issue = repo.issues.get(Number(number));
  if (!issue) throw fail(404, 'Not Found');
  sendJson(res, 200, issueJson(repo, issue));
});

route('PATCH', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const segments = pathSegments(req);
  const owner = segments[3]!;
  const name = segments[4]!;
  const number = segments[6]!;
  const repo = requireRepo(ctx, owner!, name!);
  const issue = repo.issues.get(Number(number));
  if (!issue) throw fail(404, 'Not Found');
  const body = await jsonBody(req);
  const title = asString(body.title);
  if (title !== null) issue.title = title;
  const bodyText = asString(body.body);
  if (bodyText !== null) issue.body = bodyText;
  const state = asString(body.state);
  if (state === 'open' || state === 'closed') issue.state = state;
  if (Array.isArray(body.labels)) {
    const labelNames = asStringArray(body.labels);
    for (const labelName of labelNames) {
      if (!repo.labels.has(labelName)) throw fail(422, `Label does not exist: ${labelName}`);
    }
    issue.labels = labelNames;
  }
  issue.updatedSeq = ctx.forge.bumpSeq();
  sendJson(res, 200, issueJson(repo, issue));
});

route('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const segments = pathSegments(req);
  const owner = segments[3]!;
  const name = segments[4]!;
  const number = segments[6]!;
  const repo = requireRepo(ctx, owner!, name!);
  const issue = repo.issues.get(Number(number));
  if (!issue) throw fail(404, 'Not Found');
  const body = await jsonBody(req);
  const text = asString(body.body);
  if (!text) throw fail(422, 'body is required');
  const comment = ctx.forge.createComment(repo, issue, text);
  sendJson(res, 201, commentJson(repo, issue, comment));
});

route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const segments = pathSegments(req);
  const owner = segments[3]!;
  const name = segments[4]!;
  const number = segments[6]!;
  const repo = requireRepo(ctx, owner!, name!);
  const issue = repo.issues.get(Number(number));
  if (!issue) throw fail(404, 'Not Found');
  sendPage(res, req, issue.comments, (comment) => commentJson(repo, issue, comment));
});

// -- pull requests ----------------------------------------------------------

route('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const [, , , owner, name] = pathSegments(req);
  const repo = requireRepo(ctx, owner!, name!);
  const body = await jsonBody(req);
  const title = asString(body.title);
  const head = asString(body.head);
  const base = asString(body.base) ?? repo.defaultBranch;
  if (!title || !head) throw fail(422, 'title and head are required');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha) throw fail(422, `Head branch ${head} does not exist`);
  if (!baseSha) throw fail(422, `Base branch ${base} does not exist`);
  const existing = [...repo.pulls.values()].find(
    (p) => p.headRef === head && p.baseRef === base && p.state === 'open',
  );
  if (existing) throw fail(422, 'A pull request already exists');
  if (headSha === baseSha) throw fail(422, `No commits between ${base} and ${head}`);
  const pull = ctx.forge.createPull(repo, title, asString(body.body) ?? '', head, base);
  sendJson(res, 201, pullJson(ctx.forge, repo, pull));
});

route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const [, , , owner, name] = pathSegments(req);
  const repo = requireRepo(ctx, owner!, name!);
  const query = queryOf(req);
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
  pulls.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  sendPage(res, req, pulls, (pull) => pullJson(ctx.forge, repo, pull));
});

route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const segments = pathSegments(req);
  const owner = segments[3]!;
  const name = segments[4]!;
  const number = segments[6]!;
  const repo = requireRepo(ctx, owner!, name!);
  const pull = repo.pulls.get(Number(number));
  if (!pull) throw fail(404, 'Not Found');
  sendJson(res, 200, pullJson(ctx.forge, repo, pull));
});

route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const segments = pathSegments(req);
  const owner = segments[3]!;
  const name = segments[4]!;
  const number = segments[6]!;
  const repo = requireRepo(ctx, owner!, name!);
  const pull = repo.pulls.get(Number(number));
  if (!pull) throw fail(404, 'Not Found');
  const headTip = ctx.forge.resolveToCommit(repo, pull.headRef);
  const baseTip = ctx.forge.resolveToCommit(repo, pull.baseRef);
  if (!headTip || !baseTip) throw fail(404, 'Not Found');
  const headTree = ctx.forge.treeOfCommit(repo, headTip);
  const baseTree = ctx.forge.treeOfCommit(repo, baseTip);
  const changes = ctx.forge.diffTrees(repo, baseTree, headTree);
  const files: Array<Record<string, unknown>> = [];
  for (const change of changes) {
    const status = change.status === 'added' ? 'added' : change.status === 'removed' ? 'removed' : 'modified';
    const { additions, deletions } = countLineDiff(blobText(repo, change.oldOid), blobText(repo, change.newOid));
    files.push({
      sha: change.newOid ?? change.oldOid ?? ZERO_OID,
      filename: change.path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  sendPage(res, req, files, (file) => file);
});

route('PUT', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/, async (ctx, req, res) => {
  requireAuth(ctx, req);
  const segments = pathSegments(req);
  const owner = segments[3]!;
  const name = segments[4]!;
  const number = segments[6]!;
  const repo = requireRepo(ctx, owner!, name!);
  const pull = repo.pulls.get(Number(number));
  if (!pull) throw fail(404, 'Not Found');
  if (pull.state === 'closed') throw fail(405, 'Pull Request is not mergeable');
  const body = await jsonBody(req);
  const method = asString(body.merge_method) ?? 'squash';
  const message = asString(body.commit_message) ?? `Squash and merge ${pull.title} (#${pull.number})`;
  const result = mergePull(ctx.forge, repo, pull, method, message);
  sendJson(res, 200, result);
});

/** Squash-merge a pull request (the GraphQL mergePullRequest mutation shares this). */
export function mergePull(
  forge: Forge,
  repo: Repo,
  pull: PullRequest,
  method: string,
  message: string,
): { sha: string; merged: boolean; message: string } {
  const headTip = forge.resolveToCommit(repo, pull.headRef);
  const baseTip = forge.resolveToCommit(repo, pull.baseRef);
  if (!headTip || !baseTip) throw fail(404, 'Not Found');
  const plan = forge.mergePlan(repo, pull);
  if (!plan.ok) throw fail(405, 'Merge conflict');
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const commit = forge.makeCommit(repo, { tree: plan.tree, parents, message });
  forge.setRef(repo, `refs/heads/${pull.baseRef}`, commit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoOf(forge.bumpSeq());
  pull.mergeCommitSha = commit;
  pull.updatedSeq = forge.bumpSeq();
  return { sha: commit, merged: true, message };
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

// Handlers grouped by method, so a request tests only its own method's patterns.
const handlersByMethod = new Map<string, Array<{ method: string; pattern: RegExp; fn: Handler }>>();
for (const handler of handlers) {
  const list = handlersByMethod.get(handler.method) ?? [];
  list.push(handler);
  handlersByMethod.set(handler.method, list);
}

/**
 * Handle a request whose path starts with /api/v3. Returns true when handled;
 * the caller answers 404 JSON for anything else.
 */
export async function handleRest(ctx: RestContext, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = routePath(req);
  if (!path.startsWith('/api/v3')) return false;
  try {
    for (const handler of handlersByMethod.get(req.method ?? '') ?? []) {
      if (!handler.pattern.test(path)) continue;
      await handler.fn(ctx, req, res);
      return true;
    }
    // Authenticated 404 for unknown v3 routes; the root still needs auth.
    requireAuth(ctx, req);
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  } catch (error) {
    if (isApiError(error)) {
      sendJson(res, error.status, { message: error.message });
      return true;
    }
    console.error('rest error', error);
    sendJson(res, 500, { message: 'Internal Server Error' });
    return true;
  }
}
