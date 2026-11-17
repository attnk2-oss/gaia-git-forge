// Git smart HTTP: pkt-line framing, packfiles (read with OFS/REF delta support,
// written plain), protocol v2 ls-refs/fetch, v0 advertisements and receive-pack.
// No git binary anywhere: everything here is hand-rolled on node:zlib/node:crypto.
//
// Wire notes (from the suite's own client, program/env/src/git-client.ts):
// - upload-pack info/refs with `Git-Protocol: version=2` answers a v2 advertisement
//   (`version 2` + capability lines); without it, a v0 advertisement with the
//   `# service=git-upload-pack` preamble. receive-pack is v0 only.
// - v2 fetch answers sections in order: acknowledgments (NAK), shallow-info, then
//   packfile as sideband band-1 packets, each pkt-line <= 65520 bytes.
// - receive-pack answers report-status inside sideband band 1; a refused ref is
//   `ng <ref> non-fast-forward` and the ref does not move.

import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  sortedRefs,
  hashObject,
  type Forge,
  type GitObject,
  type ObjType,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export const PKT_MAX = 65520;

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_MAX) throw new Error('pkt-line payload too long');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** A cursor over a buffer that reads pkt-lines one at a time. */
export class PktReader {
  private offset = 0;
  readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get position(): number {
    return this.offset;
  }

  get remaining(): Buffer {
    return this.buf.subarray(this.offset);
  }

  next(): Packet | null {
    if (this.offset + 4 > this.buf.length) return null;
    const header = this.buf.subarray(this.offset, this.offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.offset += 4;
      return { kind: 'response-end' };
    }
    if (length < 4 || length > PKT_MAX) throw new Error(`bad pkt-line length ${length}`);
    if (this.offset + length > this.buf.length) throw new Error('truncated pkt-line');
    const payload = this.buf.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', payload };
  }

  /** Read data packets until a flush/delim/end; returns their payloads as strings. */
  readLines(): string[] {
    const lines: string[] = [];
    for (;;) {
      const packet = this.next();
      if (packet === null) break;
      if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
      else break;
    }
    return lines;
  }
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

const PACK_TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = PACK_TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Deterministic order. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  list.sort((a, b) => {
    const rank = (t: ObjType): number => (t === 'commit' ? 0 : t === 'tag' ? 1 : t === 'tree' ? 2 : 3);
    return rank(a.type) - rank(b.type) || (hashObject(a.type, a.data) < hashObject(b.type, b.data) ? -1 : 1);
  });
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number, trailerStart: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset, trailerStart);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Parse a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA entries. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index++) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!PACK_CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolved = new Map<number, { type: ObjType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjType; data: Buffer; oid: string } => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const base = resolveBase?.(entry.baseOid!);
      if (!base) throw new Error(`ref-delta base ${entry.baseOid} is not available`);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = PACK_CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    resolved.set(entry.offset, out);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------

export interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/** The objects a client holding `haves` (bounded by `shallowBoundaries`) already has. */
function heldClosure(repo: Repo, haves: readonly string[], shallowBoundaries: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  const queue: string[] = [...haves].filter((oid) => isOid(oid));
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      queue.push(commit.tree);
      if (!shallowBoundaries.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return held;
}

/**
 * What a fetch sends: reachable(wants) minus what the client holds, honouring
 * `depth` (commit generations from each want) and the client's shallow boundaries.
 */
export function computeFetch(
  forge: Forge,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
): FetchPlan {
  const boundarySet = new Set(shallowBoundaries);
  const held = heldClosure(repo, haves, boundarySet);
  const maxDepth = depth ?? Number.POSITIVE_INFINITY;
  const sendCommits = new Set<string>();
  const sendTags = new Set<string>();
  const newBoundaries = new Set<string>();

  const walkCommit = (oid: string, d: number): void => {
    if (d > maxDepth) return;
    if (held.has(oid)) {
      if (boundarySet.has(oid)) {
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'commit') {
          for (const parent of parseCommit(obj.data).parents) walkCommit(parent, d + 1);
        }
      }
      return;
    }
    if (sendCommits.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return;
    sendCommits.add(oid);
    const parents = parseCommit(obj.data).parents;
    if (d === maxDepth) {
      for (const parent of parents) {
        if (!held.has(parent) && !sendCommits.has(parent)) newBoundaries.add(oid);
      }
      return;
    }
    for (const parent of parents) walkCommit(parent, d + 1);
  };

  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      if (!held.has(want)) sendTags.add(want);
      const target = parseTag(obj.data).object;
      const targetObj = repo.objects.get(target);
      if (targetObj && targetObj.type === 'commit') walkCommit(target, 1);
    } else if (obj.type === 'commit') {
      walkCommit(want, 1);
    }
  }

  // The objects to send: each sent commit plus its tree closure, and each sent
  // tag plus its target's closure — never a commit's ancestors. (A plain
  // reachable() closure would leak history past a shallow depth boundary.)
  const objects = new Map<string, GitObject>();
  const addTreeClosure = (treeOid: string): void => {
    const queue: string[] = [treeOid];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (objects.has(oid) || held.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      objects.set(oid, obj);
      if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
  };
  for (const oid of sendCommits) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    objects.set(oid, obj);
    if (obj.type === 'commit') addTreeClosure(parseCommit(obj.data).tree);
  }
  for (const oid of sendTags) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    objects.set(oid, obj);
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      const targetObj = repo.objects.get(target);
      if (!targetObj) continue;
      if (targetObj.type === 'commit' && sendCommits.has(target)) continue; // already added
      if (targetObj.type === 'commit') {
        if (!held.has(target)) {
          objects.set(target, targetObj);
          addTreeClosure(parseCommit(targetObj.data).tree);
        }
      } else if (targetObj.type === 'tree') addTreeClosure(target);
      else if (!held.has(target)) objects.set(target, targetObj);
    }
  }

  const unshallow: string[] = [];
  const stillShallow: string[] = [];
  for (const boundary of shallowBoundaries) {
    const obj = repo.objects.get(boundary);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    const freed = parents.every((p) => held.has(p) || sendCommits.has(p));
    if (freed) unshallow.push(boundary);
    else stillShallow.push(boundary);
  }
  const shallow = [...newBoundaries, ...stillShallow];
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

const AGENT = 'gaia-git-forge/1.0';

function v0Caps(repo: Repo): string {
  return [
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'shallow',
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
    `agent=${AGENT}`,
  ].join(' ');
}

function receiveCaps(repo: Repo): string {
  return [
    'report-status',
    'side-band-64k',
    'delete-refs',
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
    `agent=${AGENT}`,
  ].join(' ');
}

/** A v0 ref advertisement (with the service preamble) for upload-pack or receive-pack. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? v0Caps(repo) : receiveCaps(repo);
  const lines: Array<string | 'flush'> = [`# service=${service}\n`];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const obj = repo.objects.get(ref.oid);
      if (obj && obj.type === 'tag') {
        const peeled = parseTag(obj.data).object;
        const target = repo.objects.get(peeled);
        if (target && target.type === 'commit') lines.push(`${peeled} ${ref.name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

/** A v2 capability advertisement: `version 2` + capability lines. */
export function v2Advertisement(): Buffer {
  return pktLines(['version 2\n', 'ls-refs\n', 'fetch=shallow\n', 'object-format=sha1\n', 'agent=gaia-git-forge/1.0\n', 'flush']);
}

/** ls-refs response lines for the requested refs. */
export function lsRefsResponse(
  repo: Repo,
  prefixes: readonly string[],
  peel: boolean,
  symrefs: boolean,
): Buffer {
  const lines: Array<string | 'flush'> = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (keep('HEAD')) {
    const symref = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    lines.push(`${headTip ?? ZERO_OID} HEAD${symref}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    const obj = repo.objects.get(ref.oid);
    if (peel && obj && obj.type === 'tag') {
      const peeled = parseTag(obj.data).object;
      const target = repo.objects.get(peeled);
      if (target && target.type === 'commit') line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return pktLines(lines);
}

// ---------------------------------------------------------------------------
// v2 fetch response
// ---------------------------------------------------------------------------

/** Sideband-wrap pack bytes: band-1 pkt-lines, each chunk <= 32768 bytes. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const data = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), data]);
    parts.push(pktLine(payload));
  }
  return parts;
}

export function fetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  const pack = writePack(plan.objects.values());
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Apply a receive-pack command list. Returns the unpack status and one report
 * line per command, in order. Objects from the pack are stored first; a command
 * whose new tip's closure is incomplete fails the unpack.
 */
export function applyPush(
  forge: Forge,
  repo: Repo,
  commands: readonly PushCommand[],
  packObjects: Map<string, GitObject> | null,
): { unpackOk: boolean; unpackDetail: string; lines: PushReportLine[] } {
  if (packObjects !== null) {
    for (const [oid, obj] of packObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }
  // Every new tip's closure must be complete in the store now. The walk stops
  // at already-verified oids, so a push onto a long history costs only its own
  // new objects instead of re-walking everything.
  for (const command of commands) {
    if (command.newOid === ZERO_OID) continue;
    const tip = repo.objects.get(command.newOid);
    if (!tip) return { unpackOk: false, unpackDetail: 'error', lines: [] };
    const queue: string[] = [command.newOid];
    const seen = new Set<string>();
    const newlyVerified: string[] = [];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid) || repo.verified.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) return { unpackOk: false, unpackDetail: 'error', lines: [] };
      newlyVerified.push(oid);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (obj.type === 'tag') queue.push(parseTag(obj.data).object);
      else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
    for (const oid of newlyVerified) repo.verified.add(oid);
  }

  const lines: PushReportLine[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        lines.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        lines.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        forge.deleteRef(repo, command.ref);
        lines.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        lines.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        forge.setRef(repo, command.ref, command.newOid);
        lines.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid !== current) {
      lines.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      continue;
    }
    // Update: must fast-forward when both ends are commits.
    const oldObj = repo.objects.get(current);
    const newObj = repo.objects.get(command.newOid);
    if (oldObj && newObj && oldObj.type === 'commit' && newObj.type === 'commit') {
      if (!forge.isAncestor(repo, current, command.newOid)) {
        lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    forge.setRef(repo, command.ref, command.newOid);
    lines.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { unpackOk: true, unpackDetail: 'ok', lines };
}

/** The report-status stream, wrapped in sideband band 1. */
export function pushReportResponse(result: { unpackOk: boolean; unpackDetail: string; lines: PushReportLine[] }): Buffer {
  const inner: Array<string | 'flush'> = [`unpack ${result.unpackDetail}\n`];
  for (const line of result.lines) {
    inner.push(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`);
  }
  inner.push('flush');
  const report = pktLines(inner);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < report.length; offset += 32768) {
    const data = report.subarray(offset, Math.min(report.length, offset + 32768));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), data])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// request parsing helpers
// ---------------------------------------------------------------------------

/** Parse a v2 request body into its command and argument lines. A delim packet
 * separates the command section (command=, agent=, object-format=) from the
 * argument section (want/have/deepen/peel/symrefs/ref-prefix/…); both sections
 * are data packets, and the body ends at the flush. */
export function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const reader = new PktReader(body);
  const lines: string[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null) break;
    if (packet.kind === 'flush' || packet.kind === 'response-end') break;
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (lines.length === 0) throw new Error('empty v2 request');
  const first = lines[0]!;
  const match = /^command=([a-z-]+)$/.exec(first);
  if (!match) throw new Error(`bad v2 command line ${JSON.stringify(first)}`);
  const args = lines.slice(1).filter((line) => !line.startsWith('agent=') && !line.startsWith('object-format='));
  return { command: match[1]!, args };
}

/** Parse a receive-pack body: command pkt-lines, then the raw pack bytes. */
export function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null) throw new Error('truncated receive-pack command list');
    if (packet.kind !== 'data') break;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    text = text.replace(/\n$/, '');
    const parts = text.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]!) || !isOid(parts[1]!)) {
      throw new Error(`bad receive-pack command ${JSON.stringify(text)}`);
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  const rest = reader.remaining;
  return { commands, pack: rest.length > 0 ? Buffer.from(rest) : null };
}

/** A fresh request id for logs (not a secret, not a timestamp). */
export function newRequestId(): string {
  return `req-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
