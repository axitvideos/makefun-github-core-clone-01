// Git object store, packfile parsing/generation and tree/commit helpers.
// Written from the git object format and smart-HTTP protocol as documented
// in git's own technical documentation; no git binary is used anywhere.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The git object id of a (type, content) pair: sha1("<type> <len>\0" + content). */
export function oidOf(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

/** sha1 of raw bytes, used for packfile trailers. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

/** Encode a string/buffer as one pkt-line (4 hex length digits + payload). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktItem =
  | { kind: 'line'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Parse pkt-lines starting at `offset`. Returns the items and the offset just
 * past the last complete item. `allowPartial` lets a trailing incomplete line
 * stay unconsumed (for streaming parsers). Throws on a malformed length.
 */
export function parsePktLines(
  buf: Buffer,
  offset: number,
  allowPartial = false,
): { items: PktItem[]; next: number } {
  const items: PktItem[] = [];
  let pos = offset;
  while (pos + 4 <= buf.length) {
    const lenHex = buf.subarray(pos, pos + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len) || len < 0 || len > 65520) {
      throw new Error(`invalid pkt-line length "${lenHex}"`);
    }
    if (len === 0) {
      items.push({ kind: 'flush' });
      pos += 4;
      continue;
    }
    if (len === 1) {
      items.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (len === 2) {
      items.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    if (pos + len > buf.length) {
      if (allowPartial) break;
      throw new Error('truncated pkt-line');
    }
    items.push({ kind: 'line', data: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  if (pos < buf.length && !allowPartial) {
    // A trailing partial length prefix is only an error when we expected a
    // complete frame; streaming callers pass allowPartial.
    throw new Error('truncated pkt-line header');
  }
  return { items, next: pos };
}

// ---------------------------------------------------------------------------
// zlib helpers: inflate a stream and learn exactly how many bytes it used.
// Node's inflateSync ignores trailing bytes, so the consumed length is the
// smallest prefix that inflates successfully (found by binary search).
// ---------------------------------------------------------------------------

export function inflateWithLength(buf: Buffer): { data: Buffer; consumed: number } {
  if (buf.length === 0) throw new Error('empty zlib stream');
  let lo = 1;
  let hi = buf.length;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(0, mid));
      ans = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (ans === -1) throw new Error('bad zlib stream');
  return { data: inflateSync(buf.subarray(0, ans)), consumed: ans };
}

// ---------------------------------------------------------------------------
// Delta application (packfile ofs-delta / ref-delta)
// ---------------------------------------------------------------------------

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const b = buf[pos];
    pos += 1;
    value |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { value, next: pos };
}

/** Apply a git delta to a base object, returning the reconstructed content. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const baseSize = readVarint(delta, 0);
  if (baseSize.value !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint(delta, baseSize.next);
  const out: Buffer[] = [];
  let outLen = 0;
  let pos = resultSize.next;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= delta[pos] << (i * 8);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= delta[pos] << (i * 8);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outLen !== resultSize.value) throw new Error('delta result size mismatch');
  return Buffer.concat(out, outLen);
}

// ---------------------------------------------------------------------------
// Packfile parsing and generation
// ---------------------------------------------------------------------------

export interface PackParseResult {
  objects: Map<string, GitObject>;
}

/**
 * Parse a packfile. `resolveBase` supplies objects the pack references but
 * does not contain (thin packs); it is consulted for ref-delta bases.
 */
export function parsePack(
  buf: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): PackParseResult {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { oid: string; type: ObjType; data: Buffer }>();
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = pos;
    let b = buf[pos];
    pos += 1;
    const typeNum = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[pos];
      pos += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let type: ObjType;
    let data: Buffer;
    if (typeNum === 6) {
      // ofs-delta: offset encoding, then the delta stream. The header size
      // is the size of the delta data itself, not of the reconstructed
      // object (whose size lives inside the delta stream).
      let offByte = buf[pos];
      pos += 1;
      let offsetVal = offByte & 0x7f;
      while (offByte & 0x80) {
        offByte = buf[pos];
        pos += 1;
        offsetVal = ((offsetVal + 1) << 7) | (offByte & 0x7f);
      }
      const baseOffset = entryStart - offsetVal;
      const base = byOffset.get(baseOffset);
      if (!base) throw new Error('ofs-delta base not found in pack');
      const inf = inflateWithLength(buf.subarray(pos));
      pos += inf.consumed;
      if (inf.data.length !== size) throw new Error('pack object size mismatch');
      data = applyDelta(base.data, inf.data);
      type = base.type;
    } else if (typeNum === 7) {
      // ref-delta: 20-byte base oid, then the delta stream.
      const baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const inf = inflateWithLength(buf.subarray(pos));
      pos += inf.consumed;
      if (inf.data.length !== size) throw new Error('pack object size mismatch');
      const base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (!base) throw new Error(`ref-delta base ${baseOid} not found`);
      data = applyDelta(base.data, inf.data);
      type = base.type;
    } else {
      type = NUM_TYPE[typeNum];
      if (!type) throw new Error(`unknown pack object type ${typeNum}`);
      const inf = inflateWithLength(buf.subarray(pos));
      pos += inf.consumed;
      data = inf.data;
      if (data.length !== size) throw new Error('pack object size mismatch');
    }
    const oid = oidOf(type, data);
    objects.set(oid, { type, data });
    byOffset.set(entryStart, { oid, type, data });
  }
  // Trailer: 20-byte pack checksum, when present.
  if (pos + 20 === buf.length) {
    const want = buf.subarray(pos, pos + 20).toString('hex');
    const got = sha1Hex(buf.subarray(0, pos));
    if (want !== got) throw new Error('pack checksum mismatch');
  }
  return { objects };
}

/** Serialize objects into a packfile (no deltas: every object stored whole). */
export function buildPack(objects: Iterable<GitObject>): Buffer {
  const list = Array.from(objects);
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    const typeNum = TYPE_NUM[obj.type];
    const size = obj.data.length;
    const headBytes: number[] = [];
    let s = size;
    let first = (typeNum << 4) | (s & 0x0f);
    s >>= 4;
    if (s !== 0) first |= 0x80;
    headBytes.push(first);
    while (s !== 0) {
      let byte = s & 0x7f;
      s >>= 7;
      if (s !== 0) byte |= 0x80;
      headBytes.push(byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(withoutTrailer), 'hex');
  return Buffer.concat([withoutTrailer, trailer]);
}

// ---------------------------------------------------------------------------
// Commit / tree / tag objects
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) throw new Error('malformed tree entry');
    const mode = data.subarray(pos, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul === -1) throw new Error('malformed tree entry');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Serialize tree entries in git's canonical order (dirs sort as name + '/'). */
export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(
  tree: string,
  parents: string[],
  message: string,
  authorName: string,
  authorEmail: string,
  timestampSec: number,
): Buffer {
  const ident = `${authorName} <${authorEmail}> ${timestampSec} +0000`;
  let text = `tree ${tree}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}

export interface TagInfo {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// The per-repository object store
// ---------------------------------------------------------------------------

export class GitStore {
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();

  put(type: ObjType, data: Buffer): string {
    const oid = oidOf(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  ref(name: string): string | undefined {
    return this.refs.get(name);
  }

  setRef(name: string, oid: string): void {
    this.refs.set(name, oid);
  }

  deleteRef(name: string): boolean {
    return this.refs.delete(name);
  }
}

/** True when `ancestor` is reachable from `descendant` (or they are equal). */
export function isAncestor(store: GitStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    for (const p of info.parents) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}

/** A merge-base of two commits (first common ancestor found by BFS). */
export function mergeBase(store: GitStore, a: string, b: string): string | undefined {
  if (a === b) return a;
  const fromA = new Set<string>([a]);
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.shift() as string;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!fromA.has(p)) {
        fromA.add(p);
        queueA.push(p);
      }
    }
  }
  const queueB = [b];
  const seenB = new Set<string>([b]);
  while (queueB.length > 0) {
    const oid = queueB.shift() as string;
    if (fromA.has(oid)) return oid;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!seenB.has(p)) {
        seenB.add(p);
        queueB.push(p);
      }
    }
  }
  return undefined;
}

/** Commits reachable from `tip`, newest-first (depth-first, parents after). */
export function walkCommits(store: GitStore, tip: string, limit = 100000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const info = parseCommit(obj.data);
    for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i]);
  }
  return out;
}

export interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Select the objects a fetch of `wants` needs. Commits the client already
 * has (in `haves`) and their ancestors are excluded. `depth` limits how many
 * commit generations are included; commits at the limit are reported shallow.
 * `filter` honours "blob:none" and "tree:0".
 */
export function collectForFetch(
  store: GitStore,
  wants: string[],
  haves: Set<string>,
  shallowLines: Set<string>,
  depth: number | null,
  filter: string | null,
  deepenRelative = true,
): FetchSelection {
  const objects = new Map<string, GitObject>();
  const shallow = new Set<string>();
  const unshallow = new Set<string>();
  const include = (oid: string): void => {
    const obj = store.get(oid);
    if (obj && !objects.has(oid)) objects.set(oid, obj);
  };
  const includeTree = (treeOid: string): void => {
    if (filter === 'tree:0') return;
    const obj = store.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    include(treeOid);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') includeTree(e.oid);
      else if (filter !== 'blob:none') include(e.oid);
    }
  };
  const includeCommitTree = (commitOid: string): void => {
    const obj = store.get(commitOid);
    if (!obj || obj.type !== 'commit') return;
    includeTree(parseCommit(obj.data).tree);
  };
  // A have that is also a client shallow boundary is not a full have: the
  // client holds that object but not its parents.
  const fullHaves = new Set<string>([...haves].filter((h) => !shallowLines.has(h)));
  // Objects the client already holds, so the pack must not repeat them
  // (real git excludes everything reachable from a have). Full haves
  // carry their whole history; a shallow line carries only itself and
  // its own tree, never its parents.
  const held = new Set<string>();
  const markTreeHeld = (treeOid: string): void => {
    const obj = store.get(treeOid);
    if (!obj || obj.type !== 'tree' || held.has(treeOid)) return;
    held.add(treeOid);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') markTreeHeld(e.oid);
      else held.add(e.oid);
    }
  };
  for (const h of fullHaves) {
    const stackH = [h];
    while (stackH.length > 0) {
      const c = stackH.pop() as string;
      if (held.has(c)) continue;
      const obj = store.get(c);
      if (!obj || obj.type !== 'commit') continue;
      held.add(c);
      markTreeHeld(parseCommit(obj.data).tree);
      for (const p of parseCommit(obj.data).parents) stackH.push(p);
    }
  }
  for (const s of shallowLines) {
    const obj = store.get(s);
    if (!obj || obj.type !== 'commit' || held.has(s)) continue;
    held.add(s);
    markTreeHeld(parseCommit(obj.data).tree);
  }
  // Smallest depth at which a commit was visited. Depth is counted from a
  // want, and resets to 1 below a client shallow boundary: `deepen N`
  // means N more levels under the boundary the client already has.
  const depthMap = new Map<string, number>();
  const stack: Array<{ oid: string; depth: number }> = [];
  for (const w of wants) {
    if (w === ZERO_OID) continue;
    const obj = store.get(w);
    if (!obj) continue;
    if (obj.type === 'commit') stack.push({ oid: w, depth: 1 });
    else if (obj.type === 'tag') {
      include(w);
      const tag = parseTag(obj.data);
      const target = store.get(tag.object);
      if (target) {
        if (target.type === 'commit') stack.push({ oid: tag.object, depth: 1 });
        else if (target.type === 'tree') includeTree(tag.object);
        else include(tag.object);
      }
    } else if (obj.type === 'tree') includeTree(w);
    else include(w);
  }
  while (stack.length > 0) {
    const { oid, depth: d } = stack.pop() as { oid: string; depth: number };
    const prev = depthMap.get(oid);
    if (prev !== undefined && prev <= d) continue;
    depthMap.set(oid, d);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    if (fullHaves.has(oid)) {
      // A have is never sent, but when the client is deepening the walk
      // must pass through it: the commits above a shallow boundary are
      // haves too, and the new history lies below the boundary, so the
      // walk can only reach it by descending through them. (Without
      // deepening the client already holds everything below a have, so
      // the walk stops there.)
      if (depth !== null) {
        for (const p of parseCommit(obj.data).parents) stack.push({ oid: p, depth: d + 1 });
      }
      continue;
    }
    if (shallowLines.has(oid)) {
      // Client already holds this object; its parents are wanted only
      // when deepening, counted from the boundary. Once the parents are
      // sent, the commit is no longer shallow: report it unshallow so the
      // client drops it from .git/shallow. With deepen-relative the depth
      // resets to 1 below the boundary; without it the deepen is an
      // absolute depth counted from the want, so the depth keeps
      // incrementing across the boundary.
      if (depth === null) continue;
      unshallow.add(oid);
      for (const p of parseCommit(obj.data).parents) stack.push({ oid: p, depth: deepenRelative ? 1 : d + 1 });
      continue;
    }
    if (depth !== null && d > depth) continue;
    if (!objects.has(oid)) {
      include(oid);
      includeCommitTree(oid);
    }
    if (depth !== null && d === depth) {
      shallow.add(oid);
      continue;
    }
    for (const p of parseCommit(obj.data).parents) stack.push({ oid: p, depth: d + 1 });
  }
  // Never send an object the client already holds.
  const out = Array.from(objects.entries()).filter(([oid]) => !held.has(oid)).map(([, obj]) => obj);
  return { objects: out, shallow: Array.from(shallow), unshallow: Array.from(unshallow) };
}

// ---------------------------------------------------------------------------
// Tree surgery: read / write one path inside a tree, rebuilding parents.
// ---------------------------------------------------------------------------

/** Flatten a tree into path -> {mode, oid}, recursively. */
export function flattenTree(store: GitStore, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const obj = store.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') {
      for (const [p, v] of flattenTree(store, e.oid, path)) out.set(p, v);
    } else {
      out.set(path, { mode: e.mode, oid: e.oid });
    }
  }
  return out;
}

/**
 * Set (or, with oid null, remove) one path inside a tree, returning the new
 * root tree oid. Intermediate directories are created as needed; empty
 * directories left behind by a removal are pruned.
 */
export function treeSetPath(
  store: GitStore,
  treeOid: string,
  parts: string[],
  oid: string | null,
  mode: string,
): string {
  const obj = store.get(treeOid);
  const entries: TreeEntry[] = obj && obj.type === 'tree' ? parseTree(obj.data) : [];
  const [head, ...rest] = parts;
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    if (oid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode, name: head, oid };
    } else {
      entries.push({ mode, name: head, oid });
    }
  } else {
    let subOid = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].oid : null;
    if (oid === null && subOid === null) return treeOid;
    if (subOid === null) {
      subOid = store.put('tree', serializeTree([]));
    }
    const next = treeSetPath(store, subOid, rest, oid, mode);
    if (next === subOid) return treeOid;
    const nextObj = store.get(next);
    const nextEntries = nextObj && nextObj.type === 'tree' ? parseTree(nextObj.data) : [];
    if (oid === null && nextEntries.length === 0) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '40000', name: head, oid: next };
    } else {
      entries.push({ mode: '40000', name: head, oid: next });
    }
  }
  return store.put('tree', serializeTree(entries));
}

/** Look up one path inside a tree; undefined when absent. */
export function treeGetPath(
  store: GitStore,
  treeOid: string,
  parts: string[],
): { mode: string; oid: string } | undefined {
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = store.get(current);
    if (!obj || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return undefined;
    if (i === parts.length - 1) return { mode: entry.mode, oid: entry.oid };
    if (entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  return undefined;
}

/** List the direct entries of the tree at `parts` (empty = root). */
export function treeListDir(
  store: GitStore,
  treeOid: string,
  parts: string[],
): TreeEntry[] | undefined {
  let current = treeOid;
  for (const part of parts) {
    const obj = store.get(current);
    if (!obj || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((e) => e.name === part);
    if (!entry || entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  const obj = store.get(current);
  if (!obj || obj.type !== 'tree') return undefined;
  return parseTree(obj.data);
}
