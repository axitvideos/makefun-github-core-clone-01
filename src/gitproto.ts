// git smart HTTP: protocol v2 and v0 upload-pack, v0 receive-pack.
// Implements the wire format from git's protocol documentation; the only
// client is the suite (and, locally, a real git binary for testing).
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  GitStore,
  ZERO_OID,
  buildPack,
  collectForFetch,
  isAncestor,
  oidOf,
  parsePack,
  parsePktLines,
  parseTag,
  pktDelim,
  pktFlush,
  pktLine,
} from './gitcore.ts';
import { trialNowIso, type Repo } from './store.ts';

const AGENT = 'makefun-forge/1.0';
const UPLOAD_V2_CAPS = ['ls-refs=unborn', 'fetch=shallow wait-for-done filter', 'server-option', 'object-format=sha1', `agent=${AGENT}`];
const UPLOAD_V0_CAPS = `multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed agent=${AGENT} object-format=sha1`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs agent=${AGENT} object-format=sha1`;

/** Frame bytes as side-band-64k channel 1 pkt-lines (payload <= 65515). */
export function sideband(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  let pos = 0;
  const MAX = 65515;
  if (data.length === 0) return Buffer.alloc(0);
  while (pos < data.length) {
    const chunk = data.subarray(pos, Math.min(pos + MAX, data.length));
    const pkt = Buffer.alloc(5 + chunk.length);
    pkt.write((5 + chunk.length).toString(16).padStart(4, '0'), 0, 'ascii');
    pkt[4] = band;
    chunk.copy(pkt, 5);
    parts.push(pkt);
    pos += chunk.length;
  }
  return Buffer.concat(parts);
}

function sortedRefs(git: GitStore): Array<[string, string]> {
  return Array.from(git.refs.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headOid(repo: Repo): string | undefined {
  return repo.git.ref(`refs/heads/${repo.defaultBranch}`);
}

/** The v0 advertisement preamble + refs, with capabilities on the first line. */
function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo.git);
  const head = headOid(repo);
  if (refs.length === 0 && !head) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (head) {
      parts.push(pktLine(`${head} HEAD${first ? `\0${caps}` : ''}\n`));
      first = false;
    }
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}${first ? `\0${caps}` : ''}\n`));
      first = false;
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The protocol v2 capability advertisement (opens with "version 2"). */
function advertiseV2(): Buffer {
  const parts: Buffer[] = [pktLine('version 2\n')];
  for (const cap of UPLOAD_V2_CAPS) parts.push(pktLine(`${cap}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export interface InfoRefsResult {
  status: number;
  contentType: string;
  body: Buffer;
}

export function handleInfoRefs(
  repo: Repo | undefined,
  service: string | undefined,
  gitProtocol: string | undefined,
): InfoRefsResult {
  if (!repo) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n') };
  }
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV2() };
    }
    const caps = `${UPLOAD_V0_CAPS} symref=HEAD:refs/heads/${repo.defaultBranch}`;
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV0(repo, 'git-upload-pack', caps) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertiseV0(repo, 'git-receive-pack', RECEIVE_CAPS) };
  }
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n') };
}

// ---------------------------------------------------------------------------
// upload-pack protocol v2
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  unborn: boolean;
  symrefs: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: Buffer[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, unborn: false, symrefs: false, prefixes: [] };
  for (const line of lines) {
    const s = line.toString('utf8').trim();
    if (s === 'peel') args.peel = true;
    else if (s === 'unborn') args.unborn = true;
    else if (s === 'symrefs') args.symrefs = true;
    else if (s.startsWith('ref-prefix ')) args.prefixes.push(s.slice('ref-prefix '.length));
  }
  return args;
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const head = headOid(repo);
  const refs = sortedRefs(repo.git);
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (head && matches('HEAD')) {
    const attrs = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    parts.push(pktLine(`${head} HEAD${attrs}\n`));
  }
  if (refs.length === 0) {
    // An empty repository answers with one line: the literal "unborn" in
    // place of an oid, on HEAD. The client then knows the repository is
    // empty and does not try to fetch the null oid.
    if (matches('HEAD')) {
      const attrs = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(pktLine(`unborn HEAD${attrs}\n`));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  for (const [name, oid] of refs) {
    if (!matches(name)) continue;
    let attrs = '';
    if (args.peel) {
      const obj = repo.git.get(oid);
      if (obj && obj.type === 'tag') {
        const target = parseTag(obj.data).object;
        attrs += ` peeled:${target}`;
      }
    }
    parts.push(pktLine(`${oid} ${name}${attrs}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  deepen: number | null;
  deepenRelative: boolean;
  filter: string | null;
  shallowLines: string[];
  includeTag: boolean;
}

function parseFetchArgs(lines: Buffer[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], deepen: null, deepenRelative: false, filter: null, shallowLines: [], includeTag: false };
  const rawArgs: string[] = [];
  for (const line of lines) {
    const s = line.toString('utf8').trim();
    rawArgs.push(s);
    if (s.startsWith('want ')) args.wants.push(s.slice(5).trim());
    else if (s.startsWith('have ')) args.haves.push(s.slice(5).trim());
    else if (s === 'done') { /* end of negotiation */ }
    else if (s.startsWith('deepen ')) args.deepen = parseInt(s.slice(7), 10);
    else if (s === 'deepen-relative') args.deepenRelative = true;
    else if (s.startsWith('filter ')) args.filter = s.slice(7).trim();
    else if (s.startsWith('shallow-line ')) args.shallowLines.push(s.slice('shallow-line '.length).trim());
    else if (s.startsWith('shallow ')) args.shallowLines.push(s.slice('shallow '.length).trim());
    else if (s === 'include-tag') args.includeTag = true;
  }
  (args as unknown as Record<string, unknown>).rawArgs = rawArgs;
  return args;
}

function fetchResponse(repo: Repo, args: FetchArgs): Buffer {
  // A want of the null oid names an unborn ref: an empty repository. The
  // client expects an empty packfile, not an error.
  const wants = args.wants.filter((w) => w !== ZERO_OID);
  for (const w of wants) {
    if (!repo.git.has(w)) {
      return Buffer.concat([pktLine(`ERR upload-pack: not our ref ${w}\n`), pktFlush()]);
    }
  }
  const { objects, shallow, unshallow } = collectForFetch(repo.git, wants, new Set(args.haves), new Set(args.shallowLines), args.deepen, args.filter, args.deepenRelative);
  if (args.includeTag) {
    // Include tag objects pointing at any commit in the pack.
    const commitOids = new Set(objects.filter((o) => o.type === 'commit').map((o) => oidOf(o.type, o.data)));
    for (const [name, oid] of repo.git.refs) {
      if (!name.startsWith('refs/tags/')) continue;
      const tag = repo.git.get(oid);
      if (!tag || tag.type !== 'tag') continue;
      if (commitOids.has(parseTag(tag.data).object) && !objects.some((o) => oidOf(o.type, o.data) === oid)) {
        objects.push(tag);
      }
    }
  }
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    let acked = false;
    for (const h of args.haves) {
      // A have is common when it is an ancestor of (or equal to) a want.
      const common = wants.some((w) => isAncestor(repo.git, h, w) || h === w);
      if (common) {
        parts.push(pktLine(`ACK ${h}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
    // Negotiation always ends with "ready": the client proceeds to the
    // pack only after it; a bare NAK would make it expect more rounds.
    parts.push(pktLine('ready\n'));
    parts.push(pktDelim());
  }
  if (args.deepen !== null || args.shallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(buildPack(objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  let parsed;
  try {
    parsed = parsePktLines(body, 0);
  } catch (err) {
    return Buffer.concat([pktLine(`ERR ${(err as Error).message}\n`), pktFlush()]);
  }
  const lines = parsed.items.filter((i): i is { kind: 'line'; data: Buffer } => i.kind === 'line').map((i) => i.data);
  if (lines.length === 0) return Buffer.concat([pktLine('ERR empty request\n'), pktFlush()]);
  const command = lines[0].toString('utf8').trim();
  if (command === 'command=ls-refs') {
    return lsRefsResponse(repo, parseLsRefsArgs(lines.slice(1)));
  }
  if (command === 'command=fetch') {
    const args = parseFetchArgs(lines.slice(1));
    const out = fetchResponse(repo, args);
    return out;
  }
  return Buffer.concat([pktLine(`ERR unknown command ${command}\n`), pktFlush()]);
}

// ---------------------------------------------------------------------------
// upload-pack protocol v0 (streaming: the client negotiates in rounds)
// ---------------------------------------------------------------------------

/**
 * Handle a v0 upload-pack POST as a stream. The client may send haves in
 * rounds, waiting for ACKs between them, so ACKs are written as soon as a
 * flush boundary arrives, before the request body has ended.
 */
export function handleUploadPackV0Stream(repo: Repo, req: IncomingMessage, res: ServerResponse): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowLines: string[] = [];
  let deepen: number | null = null;
  let deepenRelative = false; // v0: relative only when the client sends the deepen-relative capability
  let sideBand = false;
  let done = false;
  let buf = Buffer.alloc(0);
  let headersSent = false;
  // v0 exchange order (from a real git server): after the wants flush the
  // server answers only the shallow lines; ACK/NAK come after a haves
  // flush; after "done" the server sends NAK (when nothing was ACKed) and
  // then the pack.
  let sentShallow = false;
  let sentAck = false;

  const sendHeaders = (): void => {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  };

  const commonHaves = (): string[] => {
    const out: string[] = [];
    for (const h of haves) {
      if (wants.some((w) => h === w || isAncestor(repo.git, h, w))) out.push(h);
    }
    return out;
  };

  /** Shallow/unshallow lines for the current wants/deepen, if any apply. */
  const shallowUpdate = (): { shallow: string[]; unshallow: string[] } => {
    if (deepen === null && shallowLines.length === 0) return { shallow: [], unshallow: [] };
    const sel = collectForFetch(repo.git, wants, new Set(haves), new Set(shallowLines), deepen, null, deepenRelative);
    return { shallow: sel.shallow, unshallow: sel.unshallow };
  };

  const sendShallow = (): void => {
    if (sentShallow) return;
    sentShallow = true;
    // A shallow section is only ever sent when the client asked to deepen.
    // When it merely carries existing shallow boundaries (a plain fetch in
    // a shallow clone) there is nothing to report and no section at all:
    // sending even a bare flush would be read as the ACK/NAK phase.
    if (deepen === null) return;
    sendHeaders();
    const { shallow, unshallow } = shallowUpdate();
    for (const s of shallow) res.write(pktLine(`shallow ${s}\n`));
    for (const u of unshallow) res.write(pktLine(`unshallow ${u}\n`));
    res.write(pktFlush());
  };

  // v0 ACK/NAK (real daemon, multi_ack_detailed): the server answers
  // haves with "ACK <oid> common" lines and ends the ACK phase with a
  // plain "ACK <last-common-oid>" (a duplicate of the last one). NAK
  // alone terminates it. A plain ACK sent for the FIRST have makes the
  // client think the phase is over, so it then reads the following ACK
  // lines as sideband pack data ("bad band #65").
  const sendAcks = (): void => {
    if (sentAck) return;
    sendHeaders();
    const common = commonHaves();
    if (common.length > 0) {
      for (const c of common) res.write(pktLine(`ACK ${c} common\n`));
    } else {
      res.write(pktLine('NAK\n'));
    }
    sentAck = true;
    res.write(pktFlush());
  };

  const finish = (): void => {
    if (done) return;
    done = true;
    sendHeaders();
    // Any want the store does not have is a protocol error.
    for (const w of wants) {
      if (!repo.git.has(w)) {
        res.write(pktLine(`ERR upload-pack: not our ref ${w}\n`));
        res.write(pktFlush());
        res.end();
        return;
      }
    }
    // No flush ever arrived: the shallow lines still have to go first.
    sendShallow();
    const common = commonHaves();
    if (!sentAck) {
      // No ACK/NAK round happened yet (the client sent haves + "done"
      // without a flush between them): answer the haves now, before the
      // pack, in the daemon's format.
      sendHeaders();
      if (common.length > 0) {
        for (const c of common) res.write(pktLine(`ACK ${c} common\n`));
      } else {
        res.write(pktLine('NAK\n'));
      }
      sentAck = true;
    }
    // Terminating plain ACK (duplicate of the last common have) ends the
    // ACK phase; the pack follows it directly, with no flush. Only when
    // at least one common have exists.
    if (common.length > 0) res.write(pktLine(`ACK ${common[common.length - 1]}\n`));
    const { objects } = collectForFetch(repo.git, wants, new Set(haves), new Set(shallowLines), deepen, null, deepenRelative);
    const pack = buildPack(objects);
    if (sideBand) res.write(sideband(pack));
    else res.write(pack);
    res.write(pktFlush());
    res.end();
  };

  const processLine = (line: Buffer): void => {
    const s = line.toString('utf8');
    const trimmed = s.trim();
    if (trimmed.startsWith('want ')) {
      // v0: the first want line carries the capabilities after a space
      // ("want <oid> <cap1> <cap2> ..."); there is no NUL here.
      const rest = trimmed.slice(5);
      const sp = rest.indexOf(' ');
      const oid = (sp === -1 ? rest : rest.slice(0, sp)).trim();
      wants.push(oid);
      if (sp !== -1) {
        const caps = rest.slice(sp + 1);
        if (caps.includes('side-band-64k')) sideBand = true;
        if (caps.includes('deepen-relative')) deepenRelative = true;
      }
    } else if (trimmed.startsWith('have ')) {
      haves.push(trimmed.slice(5).trim());
    } else if (trimmed.startsWith('shallow ')) {
      shallowLines.push(trimmed.slice(8).trim());
    } else if (trimmed.startsWith('deepen ')) {
      deepen = parseInt(trimmed.slice(7), 10);
    } else if (trimmed === 'done') {
      finish();
    }
  };

  req.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      let parsed;
      try {
        parsed = parsePktLines(buf, 0, true);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"message":"Bad Request"}\n');
        req.destroy();
        return;
      }
      if (parsed.next === 0) break;
      const consumed = parsed.next;
      for (const item of parsed.items) {
        if (item.kind === 'line') processLine(item.data);
        else if (item.kind === 'flush') {
          if (done) continue;
          // First flush ends the wants section: answer the shallow lines
          // (if any). Later flushes end a haves batch: answer ACK/NAK.
          if (!sentShallow) {
            sendShallow();
            // Haves may already have arrived in the same chunk.
            if (haves.length > 0) sendAcks();
          } else {
            sendAcks();
          }
        }
      }
      buf = buf.subarray(consumed);
      if (done) break;
    }
  });
  req.on('end', () => {
    if (done) return;
    if ((deepen !== null || shallowLines.length > 0) && haves.length === 0) {
      // Shallow-list query (first of two POSTs for a shallow fetch): the
      // response holds only the shallow lines. Sending the pack here would
      // corrupt it; the client POSTs again with "done" to fetch the pack.
      sendShallow();
      sendHeaders();
      res.end();
      return;
    }
    // The client never sent "done" but did send haves: answer the pack.
    finish();
  });
  req.on('error', () => {
    try {
      res.end();
    } catch {
      // The request is gone; nothing to answer.
    }
  });
}

// ---------------------------------------------------------------------------
// receive-pack v0
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  // Parse command pkt-lines by hand, stopping at the flush: the bytes after
  // it are the raw packfile, not pkt-lines.
  const commands: PushCommand[] = [];
  let caps = '';
  let sawFlush = false;
  let pos = 0;
  while (pos + 4 <= body.length) {
    const lenHex = body.subarray(pos, pos + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len) || len < 0 || len > 65520) break;
    if (len === 0) {
      sawFlush = true;
      pos += 4;
      break;
    }
    if (len === 1 || len === 2) {
      pos += 4;
      continue;
    }
    if (pos + len > body.length) break;
    const s = body.subarray(pos + 4, pos + len).toString('utf8');
    const nul = s.indexOf('\0');
    const cmdPart = nul === -1 ? s : s.slice(0, nul);
    if (nul !== -1 && commands.length === 0) caps = s.slice(nul + 1);
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(cmdPart.trim());
    if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    pos += len;
  }
  const packStart = pos;
  const sideBand = caps.includes('side-band-64k');
  const reportStatus = caps.includes('report-status');

  // Unpack the packfile first; every ref update depends on its objects.
  const packBytes = body.subarray(packStart);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const { objects } = parsePack(packBytes, (oid) => repo.git.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.git.has(oid)) repo.git.objects.set(oid, obj);
      }
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }

  const report: string[] = [];
  if (unpackError) {
    report.push(`unpack ${unpackError}\n`);
    for (const c of commands) report.push(`ng ${c.ref} failed to unpack\n`);
  } else {
    report.push('unpack ok\n');
    for (const c of commands) {
      const current = repo.git.ref(c.ref);
      const result = applyPush(repo, c, current);
      if (result === null) report.push(`ok ${c.ref}\n`);
      else report.push(`ng ${c.ref} ${result}\n`);
    }
  }

  if (!reportStatus && !sideBand) return Buffer.alloc(0);
  // Each report line is its own pkt-line; inside the sideband the whole
  // report (lines plus a flush) is the band-1 payload.
  const reportPkt = Buffer.concat([...report.map((r) => pktLine(r)), pktFlush()]);
  if (sideBand) return Buffer.concat([sideband(reportPkt), pktFlush()]);
  return reportPkt;
}

/** Apply one ref update; returns null on success or the refusal reason. */
function applyPush(repo: Repo, cmd: PushCommand, current: string | undefined): string | null {
  const cur = current ?? ZERO_OID;
  if (cmd.oldOid !== cur) return 'non-fast-forward';
  if (cmd.newOid === ZERO_OID) {
    // Delete.
    if (cur === ZERO_OID) return 'remote ref does not exist';
    repo.git.deleteRef(cmd.ref);
    touchRepo(repo);
    return null;
  }
  const obj = repo.git.get(cmd.newOid);
  if (!obj) return 'invalid object';
  if (cmd.oldOid === ZERO_OID) {
    // Create.
    if (cur !== ZERO_OID) return 'already exists';
    repo.git.setRef(cmd.ref, cmd.newOid);
    settleDefault(repo, cmd.ref);
    touchRepo(repo);
    return null;
  }
  // Update: must fast-forward.
  if (!isAncestor(repo.git, cmd.oldOid, cmd.newOid)) return 'non-fast-forward';
  repo.git.setRef(cmd.ref, cmd.newOid);
  touchRepo(repo);
  return null;
}

function settleDefault(repo: Repo, ref: string): void {
  if (!repo.defaultBranchSettled && ref.startsWith('refs/heads/')) {
    repo.defaultBranch = ref.slice('refs/heads/'.length);
    repo.defaultBranchSettled = true;
  }
}

function touchRepo(repo: Repo): void {
  const now = trialNowIso();
  repo.updatedAt = now;
  repo.pushedAt = now;
}
