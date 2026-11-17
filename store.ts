// The forge's in-memory store: repositories, git objects and refs, issues, pull
// requests, labels and comments. Everything is deterministic: no wall clock and no
// unseeded randomness anywhere in here, so two runs fed the same requests reach
// the same state. Server-made commits stamp a counter-based time, never Date.now().
//
// The token owner's login is the scenario's viewer. The suite's scenario is built
// from the fixed seed in the kit (program/env/src/wire.ts SCENARIO_SEED); its
// viewer login is "adaiversen" and the stranger is "olgabauer". That is public,
// sealed-suite data, not a secret, and it is the only way the forge can tell the
// token owner's repositories from another owner's (the foreign-owner check).

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0'.repeat(40);

/** Fixed epoch for every server-made timestamp; a counter keeps them distinct. */
export const EPOCH_SEC = 1700000000;

let globalSeq = 0;
export function nextSeq(): number {
  globalSeq += 1;
  return globalSeq;
}

/** A deterministic ISO timestamp for sequence `seq`. */
export function isoOf(seq: number): string {
  return new Date((EPOCH_SEC + seq) * 1000).toISOString();
}

/** The identity server-made commits and merges carry. */
export function serverIdentity(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export function typeCodeOf(type: ObjType): number {
  return TYPE_CODE[type];
}

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// git object builders/parsers
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const ts = fields.timestamp ?? EPOCH_SEC;
  const author = `${fields.author ?? serverIdentity()} ${ts} +0000`;
  const committer = `${fields.committer ?? serverIdentity()} ${ts} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdSeq: number;
  updatedSeq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  updatedSeq: number;
  pushedSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
  nextCommentId: number;
  /** Oids whose object closure is known complete (verified pushes, server commits). */
  verified: Set<string>;
  /** Bumped on any ref change; invalidates the fetch pack cache. */
  refVersion: number;
  packCache: Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>;
}

/** Every ref of a repo, sorted: heads first, then tags, each by name. */
export function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  out.sort((a, b) => {
    const rank = (n: string): number => (n.startsWith('refs/heads/') ? 0 : n.startsWith('refs/tags/') ? 1 : 2);
    return rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
  return out;
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextGlobalId = 1;

  nextId(): number {
    const id = this.nextGlobalId;
    this.nextGlobalId += 1;
    return id;
  }

  /** One more deterministic sequence number (timestamps, updated_at, …). */
  bumpSeq(): number {
    return nextSeq();
  }

  /** A repository by its numeric id, or undefined. */
  repoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) {
      if (repo.id === id) return repo;
    }
    return undefined;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    const seq = nextSeq();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: seq,
      updatedSeq: seq,
      pushedSeq: seq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      verified: new Set(),
      refVersion: 0,
      packCache: new Map(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /** Repositories in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ---------------------------------------------------------------- git objects

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The ref's tip, or null when the ref does not exist. */
  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.refVersion += 1;
    repo.packCache.clear();
    repo.pushedSeq = nextSeq();
    repo.updatedSeq = repo.pushedSeq;
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const ok = repo.refs.delete(ref);
    if (ok) {
      repo.refVersion += 1;
      repo.packCache.clear();
      repo.updatedSeq = nextSeq();
    }
    return ok;
  }

  /** Every ref, sorted: heads first, then tags, each by name. */
  sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return sortedRefs(repo);
  }

  /** Resolve a ref name or a raw oid to a commit oid, or null. */
  resolveToCommit(repo: Repo, refOrOid: string): string | null {
    let oid: string | null = null;
    if (isOid(refOrOid)) oid = refOrOid;
    else if (refOrOid === 'HEAD') oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    else if (refOrOid.startsWith('refs/')) oid = repo.refs.get(refOrOid) ?? null;
    else oid = repo.refs.get(`refs/heads/${refOrOid}`) ?? null;
    if (oid === null) return null;
    const obj = repo.objects.get(oid);
    if (!obj) return null;
    if (obj.type === 'commit') return oid;
    if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      const target = repo.objects.get(tag.object);
      return target && target.type === 'commit' ? tag.object : null;
    }
    return null;
  }

  /** Peel a ref's oid to its commit (annotated tags peel to their target). */
  peelToCommit(repo: Repo, oid: string): string | null {
    const obj = repo.objects.get(oid);
    if (!obj) return null;
    if (obj.type === 'commit') return oid;
    if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      return this.peelToCommit(repo, tag.object);
    }
    return null;
  }

  /** True when `ancestor` is reachable from `tip` following commit parents. */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The merge base of two commits: the first common ancestor found walking from `b`. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA: string[] = [a];
    while (queueA.length > 0) {
      const oid = queueA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queueA.push(parent);
    }
    const queueB: string[] = [b];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const oid = queueB.shift()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queueB.push(parent);
    }
    return null;
  }

  /** Every object reachable from `roots` (commits, trees, blobs, tags). */
  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [...roots].filter((oid) => isOid(oid));
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /** Commits reachable from `tip`, newest first (by creation sequence). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const reachableCommits = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (reachableCommits.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      reachableCommits.add(oid);
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
    return [...reachableCommits].sort((a, b) => (commitSeq(repo, a) - commitSeq(repo, b)));
  }

  // ---------------------------------------------------------------- trees/files

  /** Apply file changes (path -> bytes, null deletes) onto a tree; returns the new tree oid. */
  updateTree(repo: Repo, baseTreeOid: string | null, changes: Map<string, Buffer | null>): string {
    // Build a nested map of the base tree, apply the changes, rebuild.
    interface Node {
      files: Map<string, string>; // name -> blob oid
      dirs: Map<string, Node>;
    }
    const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
    const load = (treeOid: string | null): Node => {
      const node = makeNode();
      if (treeOid === null) return node;
      const obj = repo.objects.get(treeOid);
      if (!obj || obj.type !== 'tree') return node;
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') node.dirs.set(entry.name, load(entry.oid));
        else node.files.set(entry.name, entry.oid);
      }
      return node;
    };
    const root = load(baseTreeOid);
    for (const [path, content] of changes) {
      const segments = path.split('/').filter((s) => s !== '');
      if (segments.length === 0) continue;
      let node = root;
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i]!;
        let child = node.dirs.get(seg);
        if (!child) {
          child = makeNode();
          node.dirs.set(seg, child);
        }
        node = child;
      }
      const leaf = segments[segments.length - 1]!;
      if (content === null) node.files.delete(leaf);
      else node.files.set(leaf, this.putObject(repo, 'blob', content));
    }
    const store = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) {
        if (child.files.size === 0 && child.dirs.size === 0) continue;
        entries.push({ mode: '40000', name, oid: store(child) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return store(root);
  }

  /** The blob oid at `path` in the tree, or null. */
  blobAtPath(repo: Repo, treeOid: string, path: string): string | null {
    const segments = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (let i = 0; i < segments.length; i++) {
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
      current = entry.oid;
    }
    return null;
  }

  /** The tree oid of a commit, or null. */
  treeOfCommit(repo: Repo, commitOid: string): string | null {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  /** Flat file list of a tree: path -> { oid, mode }. */
  flatTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, base: string): void => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Diff two trees: paths added/modified/removed between base and head. */
  diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): Array<{
    path: string;
    status: 'added' | 'modified' | 'removed';
    oldOid: string | null;
    newOid: string | null;
  }> {
    const base = baseTreeOid === null ? new Map() : this.flatTree(repo, baseTreeOid);
    const head = headTreeOid === null ? new Map() : this.flatTree(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
      else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
      else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
    return out;
  }

  /** Create a commit object on the repo and return its oid. */
  makeCommit(repo: Repo, fields: { tree: string; parents?: readonly string[]; message: string }): string {
    const seq = nextSeq();
    const data = buildCommit({ ...fields, timestamp: EPOCH_SEC + seq });
    const oid = this.putObject(repo, 'commit', data);
    // The tree and parents are already in the store (built by updateTree or
    // taken from existing tips), so this commit's closure is complete.
    repo.verified.add(oid);
    return oid;
  }

  // ---------------------------------------------------------------- issues/PRs

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber++;
    const seq = nextSeq();
    const issue: Issue = {
      id: this.nextId(),
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.issues.set(number, issue);
    repo.updatedSeq = nextSeq();
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: repo.nextCommentId++, body, createdSeq: nextSeq() };
    issue.comments.push(comment);
    issue.updatedSeq = nextSeq();
    repo.updatedSeq = issue.updatedSeq;
    return comment;
  }

  createLabel(repo: Repo, name: string, color: string): Label {
    const label: Label = { id: this.nextId(), name, color };
    repo.labels.set(name, label);
    return label;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest {
    const number = repo.nextNumber++;
    const seq = nextSeq();
    const pull: PullRequest = {
      id: this.nextId(),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.pulls.set(number, pull);
    repo.updatedSeq = nextSeq();
    return pull;
  }

  /** The three-way merge result for a pull request, or a conflict description. */
  mergePlan(repo: Repo, pull: PullRequest): { ok: true; tree: string } | { ok: false; reason: string } {
    const headTip = this.resolveToCommit(repo, `refs/heads/${pull.headRef}`);
    const baseTip = this.resolveToCommit(repo, `refs/heads/${pull.baseRef}`);
    if (headTip === null || baseTip === null) return { ok: false, reason: 'head or base branch is missing' };
    if (headTip === baseTip) return { ok: true, tree: this.treeOfCommit(repo, baseTip) ?? '' };
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseTree = base === null ? null : this.treeOfCommit(repo, base);
    const headTree = this.treeOfCommit(repo, headTip);
    const baseTipTree = this.treeOfCommit(repo, baseTip);
    if (headTree === null || baseTipTree === null) return { ok: false, reason: 'missing tree' };
    const headDiff = this.diffTrees(repo, baseTree, headTree);
    const baseDiff = this.diffTrees(repo, baseTree, baseTipTree);
    const baseChanged = new Map(baseDiff.map((d) => [d.path, d]));
    for (const change of headDiff) {
      const other = baseChanged.get(change.path);
      if (!other) continue;
      if (other.newOid !== change.newOid) {
        return { ok: false, reason: `conflict on ${change.path}` };
      }
    }
    // Squash: base tip's tree with the head's changes applied.
    const changes = new Map<string, Buffer | null>();
    for (const change of headDiff) {
      if (change.newOid === null) changes.set(change.path, null);
      else {
        const obj = repo.objects.get(change.newOid);
        if (!obj) return { ok: false, reason: `missing object ${change.newOid}` };
        changes.set(change.path, obj.data);
      }
    }
    return { ok: true, tree: this.updateTree(repo, baseTipTree, changes) };
  }
}

/** Commit creation sequence, for newest-first ordering (stored in the object map order). */
const commitSeqMap = new WeakMap<object, Map<string, number>>();
function commitSeq(repo: Repo, oid: string): number {
  let map = commitSeqMap.get(repo);
  if (!map) {
    map = new Map();
    commitSeqMap.set(repo, map);
  }
  let seq = map.get(oid);
  if (seq === undefined) {
    seq = nextSeq();
    map.set(oid, seq);
  }
  return seq;
}

// ---------------------------------------------------------------------------
// global (Relay) ids: opaque, stable, decodable. base64url of a typed payload.
// ---------------------------------------------------------------------------

function b64uEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function b64uDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function repoGlobalId(owner: string, name: string): string {
  return b64uEncode(`R:${owner}/${name}`);
}

export function issueGlobalId(owner: string, repo: string, number: number): string {
  return b64uEncode(`I:${owner}/${repo}:${number}`);
}

export function pullGlobalId(owner: string, repo: string, number: number): string {
  return b64uEncode(`P:${owner}/${repo}:${number}`);
}

export function commentGlobalId(owner: string, repo: string, issueNumber: number, commentId: number): string {
  return b64uEncode(`C:${owner}/${repo}:${issueNumber}:${commentId}`);
}

export type GlobalId =
  | { kind: 'repo'; owner: string; name: string }
  | { kind: 'issue'; owner: string; repo: string; number: number }
  | { kind: 'pull'; owner: string; repo: string; number: number }
  | { kind: 'comment'; owner: string; repo: string; issue: number; commentId: number };

export function decodeGlobalId(id: string): GlobalId | null {
  const text = b64uDecode(id);
  if (text === null) return null;
  const kind = text[0];
  const rest = text.slice(2);
  if (kind === 'R') {
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    return { kind: 'repo', owner: rest.slice(0, slash), name: rest.slice(slash + 1) };
  }
  if (kind === 'I' || kind === 'P') {
    const colon = rest.lastIndexOf(':');
    if (colon < 0) return null;
    const ownerRepo = rest.slice(0, colon);
    const slash = ownerRepo.indexOf('/');
    if (slash < 0) return null;
    const number = Number(rest.slice(colon + 1));
    if (!Number.isInteger(number)) return null;
    return kind === 'I'
      ? { kind: 'issue', owner: ownerRepo.slice(0, slash), repo: ownerRepo.slice(slash + 1), number }
      : { kind: 'pull', owner: ownerRepo.slice(0, slash), repo: ownerRepo.slice(slash + 1), number };
  }
  if (kind === 'C') {
    const parts = rest.split(':');
    if (parts.length !== 3) return null;
    const slash = parts[0]!.indexOf('/');
    if (slash < 0) return null;
    const issue = Number(parts[1]);
    const commentId = Number(parts[2]);
    if (!Number.isInteger(issue) || !Number.isInteger(commentId)) return null;
    return { kind: 'comment', owner: parts[0]!.slice(0, slash), repo: parts[0]!.slice(slash + 1), issue, commentId };
  }
  return null;
}
