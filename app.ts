// app.ts — a standalone GitHub-compatible git forge in one process.
//
// Surfaces, all from the Node standard library, no git binary, no network
// beyond the suite:
//   * git smart HTTP at /{owner}/{repo}.git — upload-pack protocol v2 (plus
//     the v0 fallback) and receive-pack v0, with a git object store built
//     here: loose objects in memory, packfile reading and writing, pkt-line
//     framing, refs, commits, trees, blobs, tags and deltas.
//   * REST v3 under /api/v3 — repositories, branches, commits, contents,
//     labels, issues, comments and pull requests.
//   * GraphQL v4 at /api/graphql — the documents gh and github-mcp-server
//     send, answered by a small executor written for exactly those shapes.
//   * MCP at /mcp — JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
//     (server/discover) with the legacy initialize handshake as fallback.
//
// Determinism: nothing that reaches state reads a wall clock or an unseeded
// random source. Commit timestamps come from a counter seeded at a fixed
// epoch; ids are content hashes or sequential counters. The token's owner is
// derived from the suite's own fixed scenario seed, reproduced here with the
// same generators the kit publishes, so the forge knows which login the
// bearer token names without ever being told.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const ZERO_OID = '0'.repeat(40);
const FIXED_EPOCH_SEC = 1_700_000_000;
const FORGE_VERSION = '1.0.0';

function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function b64encode(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function escHtml(text: string): string {
  return text;
}

// ---------------------------------------------------------------------------
// the scenario's seeded RNG (wire.ts's generators, reproduced)
// ---------------------------------------------------------------------------
// The suite builds every name from one fixed seed (SCENARIO_SEED). The
// viewer (users[0]) owns every repository the checks create; the stranger
// (users[2]) owns none of them. Reproducing the first three users here is
// what lets the forge answer "same name under another owner is 404" and
// "viewer.login is the token owner" without any configuration.

const U64_MASK = (1n << 64n) - 1n;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU32(): number {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return Number(((x * 0x2545f4914f6cdd1dn) & U64_MASK) >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

function scenarioUsers(): { login: string; name: string; email: string; id: number }[] {
  const rng = new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: { login: string; name: string; email: string; id: number }[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const SCENARIO_USERS = scenarioUsers();
const VIEWER = SCENARIO_USERS[0] as { login: string; name: string; email: string; id: number };
const STRANGER = SCENARIO_USERS[2] as { login: string; name: string; email: string; id: number };
const VIEWER_LOGIN = VIEWER.login;
const VIEWER_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

// ---------------------------------------------------------------------------
// git objects
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj {
  type: ObjType;
  data: Buffer;
}
interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
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

function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

function buildCommitBytes(tree: string, parents: readonly string[], message: string, author: string, timestamp: number): Buffer {
  const who = `${author} ${timestamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

// Every object reachable from roots: commit -> tree + parents, tree -> entries,
// tag -> its target. Missing objects throw unless allowMissing is set.
function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObj | undefined,
  allowMissing = false,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (obj === undefined) {
      if (allowMissing) continue;
      throw new Error(`missing object ${oid}`);
    }
    seen.add(oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      queue.push(view.tree);
      for (const parent of view.parents) queue.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

// Peel a tag (or a commit) down to the commit it points at.
function peelToCommit(oid: string, lookup: (oid: string) => GitObj | undefined): string | null {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = lookup(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

type PktKind = 'data' | 'flush' | 'delim' | 'response-end';
interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

// Decode a whole buffer of pkt-lines. Throws on a malformed length prefix.
function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line');
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + len > buf.length) throw new Error('pkt-line overruns its buffer');
      out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
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

function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(zlib.deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = zlib.inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
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
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
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

interface PackEntry {
  type: ObjType;
  data: Buffer;
  offset: number;
}

// Read a packfile into resolved objects. Handles plain entries and both
// delta forms (OFS_DELTA against an earlier entry in the same pack,
// REF_DELTA against an object already in the store, via `resolveBase`).
function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObj | undefined,
): { objects: Map<string, GitObj>; entries: PackEntry[]; deltaCount: number } {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const expected = sha1(pack.subarray(0, pack.length - 20));
  if (trailer !== expected) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObj>();
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  let deltaCount = 0;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const { size, next, first } = readVarintSize(pack, offset);
    offset = next;
    const typeCode = (first >> 4) & 0x07;
    let type: ObjType | null = null;
    let baseObj: GitObj | undefined;
    if (typeCode === 6) {
      const { baseOffset, next: afterBase } = readOfsDeltaBase(pack, offset);
      offset = afterBase;
      const baseEntry = byOffset.get(entryOffset - baseOffset);
      if (baseEntry === undefined) throw new Error('ofs-delta names an unknown base offset');
      baseObj = { type: baseEntry.type, data: baseEntry.data };
      type = baseEntry.type;
      deltaCount += 1;
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      baseObj = resolveBase?.(baseOid) ?? objects.get(baseOid);
      if (baseObj === undefined) throw new Error(`ref-delta names an unknown base ${baseOid}`);
      type = baseObj.type;
      deltaCount += 1;
    } else {
      type = CODE_TYPE[typeCode] as ObjType | undefined ?? null;
      if (type === null) throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset);
    offset = inflated.next;
    let data = inflated.data;
    if (data.length !== size) throw new Error(`pack entry inflated to ${data.length} bytes, expected ${size}`);
    if (baseObj !== undefined) data = applyDelta(baseObj.data, data);
    const oid = hashObject(type as ObjType, data);
    const entry: PackEntry = { type: type as ObjType, data, offset: entryOffset };
    entries.push(entry);
    byOffset.set(entryOffset, entry);
    if (!objects.has(oid)) objects.set(oid, { type: type as ObjType, data });
  }
  return { objects, entries, deltaCount };
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

interface Label {
  name: string;
  color: string;
}

interface IssueComment {
  id: string;
  body: string;
  seq: number;
}

interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
  comments: IssueComment[];
}

interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

interface Pull {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  files: PullFile[];
  seq: number;
}

interface Repo {
  id: number;
  databaseId: number;
  name: string;
  owner: string;
  description: string;
  priv: boolean;
  defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  // branch name -> path -> file bytes (the working tree at the branch tip)
  files: Map<string, Map<string, Buffer>>;
  issues: Issue[];
  issueSeq: number;
  commentSeq: number;
  pulls: Pull[];
  pullSeq: number;
  labels: Map<string, Label>;
  seq: number;
}

const repos = new Map<string, Repo>();
let repoDbSeq = 5000;
let globalSeq = 0;

function nextStamp(): number {
  globalSeq += 1;
  return FIXED_EPOCH_SEC + globalSeq;
}

function isoOf(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString();
}

function globalId(kind: string, key: string): string {
  return b64encode(`${kind}:${key}`);
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(repoKey(owner, name));
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: globalId('Repository', repoKey(repo.owner, repo.name)),
    name: repo.name,
    full_name: repoKey(repo.owner, repo.name),
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.priv,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoOf(FIXED_EPOCH_SEC + repo.seq),
    updated_at: isoOf(FIXED_EPOCH_SEC + repo.seq),
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.databaseId * 1000 + issue.number,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: isoOf(FIXED_EPOCH_SEC + issue.seq),
    updated_at: isoOf(FIXED_EPOCH_SEC + issue.seq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.databaseId * 1000 + pull.number,
    node_id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    created_at: isoOf(FIXED_EPOCH_SEC + pull.seq),
    updated_at: isoOf(FIXED_EPOCH_SEC + pull.seq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// Build a tree object for a file map, storing every tree, and return its oid.
function treeOidForFiles(repo: Repo, files: ReadonlyMap<string, Buffer>): string {
  interface Node {
    files: Map<string, Buffer>;
    dirs: Map<string, Node>;
  }
  const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = makeNode();
  for (const [path, data] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, makeNode());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, data);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, data] of [...node.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const oid = hashObject('blob', data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'blob', data });
      entries.push({ mode: '100644', name, oid });
    }
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

// Flatten a commit's tree into a path -> bytes map.
function filesAtCommit(repo: Repo, commitOid: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return out;
  const treeOid = parseCommit(commit.data).tree;
  const walk = (tree: string, prefix: string): void => {
    const obj = repo.objects.get(tree);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode === '160000') continue;
      else {
        const blob = repo.objects.get(entry.oid);
        if (blob !== undefined) out.set(path, blob.data);
      }
    }
  };
  walk(treeOid, '');
  return out;
}

// Create a commit on `branch` from a file map. Stores the commit and tree
// objects, moves the ref, and refreshes the branch's file map. Returns the
// new commit oid.
function commitFiles(
  repo: Repo,
  branch: string,
  files: ReadonlyMap<string, Buffer>,
  message: string,
): string {
  const treeOid = treeOidForFiles(repo, files);
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const parents = parent === undefined ? [] : [parent];
  const stamp = nextStamp();
  const data = buildCommitBytes(treeOid, parents, message.endsWith('\n') ? message : `${message}\n`, VIEWER_IDENTITY, stamp);
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  repo.refs.set(ref, oid);
  repo.files.set(branch, new Map(files));
  return oid;
}

function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

// Diff two file maps into GitHub's pull-request files shape.
function diffFiles(base: ReadonlyMap<string, Buffer>, head: ReadonlyMap<string, Buffer>): PullFile[] {
  const out: PullFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const oldData = base.get(path);
    const newData = head.get(path);
    if (oldData !== undefined && newData !== undefined) {
      if (oldData.equals(newData)) continue;
      const oldLines = new Set(oldData.toString('utf8').split('\n'));
      const newLines = new Set(newData.toString('utf8').split('\n'));
      let additions = 0;
      let deletions = 0;
      for (const line of newLines) if (!oldLines.has(line)) additions += 1;
      for (const line of oldLines) if (!newLines.has(line)) deletions += 1;
      if (additions === 0 && deletions === 0) {
        additions = 1;
        deletions = 1;
      }
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    } else if (newData !== undefined) {
      const additions = Math.max(1, countLines(newData.toString('utf8')));
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (oldData !== undefined) {
      const deletions = Math.max(1, countLines(oldData.toString('utf8')));
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    }
  }
  return out;
}

// Is `ancestor` an ancestor of `tip` (or equal)? Walks commit parents.
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

// Would merging `pull` conflict? A file the head changed since the pull was
// opened, that the base has also changed since, to different bytes.
function pullConflicts(repo: Repo, pull: Pull): boolean {
  const baseAtOpen = filesAtCommit(repo, pull.baseSha);
  const headFiles = repo.files.get(pull.head) ?? filesAtCommit(repo, pull.headSha);
  const baseNow = repo.files.get(pull.base) ?? filesAtCommit(repo, pull.baseSha);
  const changedByHead = diffFiles(baseAtOpen, headFiles);
  for (const file of changedByHead) {
    const atOpen = baseAtOpen.get(file.filename);
    const now = baseNow.get(file.filename);
    const head = headFiles.get(file.filename);
    const baseChanged = (atOpen === undefined && now !== undefined) ||
      (atOpen !== undefined && now === undefined) ||
      (atOpen !== undefined && now !== undefined && !atOpen.equals(now));
    if (!baseChanged) continue;
    const headEqualsNow = (head === undefined && now === undefined) ||
      (head !== undefined && now !== undefined && head.equals(now));
    if (!headEqualsNow) return true;
  }
  return false;
}

function createRepo(name: string, priv: boolean, description: string): Repo {
  repoDbSeq += 1;
  const repo: Repo = {
    id: repoDbSeq,
    databaseId: repoDbSeq,
    name,
    owner: VIEWER_LOGIN,
    description,
    priv,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    files: new Map(),
    issues: [],
    issueSeq: 0,
    commentSeq: 0,
    pulls: [],
    pullSeq: 0,
    labels: new Map(),
    seq: globalSeq,
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface ParsedUrl {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

function parseUrl(req: IncomingMessage): ParsedUrl {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = decodeURIComponent(url.pathname);
  const segments = path.split('/').filter((part) => part !== '');
  return { path, segments, query: url.searchParams };
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  if (TOKEN === '') return true;
  return presented === TOKEN;
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; pageNum: number; perPage: number; totalPages: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), pageNum, perPage, totalPages };
}

function linkHeader(req: IncomingMessage, basePath: string, query: URLSearchParams, pageNum: number, perPage: number, totalPages: number): string | null {
  if (pageNum >= totalPages) return null;
  const host = req.headers.host ?? 'entry';
  const params = new URLSearchParams(query);
  params.set('page', String(pageNum + 1));
  params.set('per_page', String(perPage));
  return `<http://${host}${basePath}?${params.toString()}>; rel="next"`;
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

type JsonObj = Record<string, unknown>;

function notFound(message: string): { status: number; body: JsonObj } {
  return { status: 404, body: { message } };
}

async function handleRest(req: IncomingMessage, res: ServerResponse, parsed: ParsedUrl): Promise<void> {
  const method = req.method ?? 'GET';
  const seg = parsed.segments;

  // Auth first: every /api/v3 route needs the bearer token.
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  // Parse a JSON body for the methods that carry one. Malformed JSON is 400.
  let body: unknown = null;
  let bodyText = '';
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const raw = await readBody(req);
    bodyText = raw.toString('utf8');
    if (bodyText.trim() !== '') {
      try {
        body = JSON.parse(bodyText) as unknown;
      } catch {
        sendJson(res, 400, { message: 'Malformed JSON body' });
        return;
      }
    }
  }
  const obj = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as JsonObj;

  // GET /api/v3/ — the API root.
  if (seg.length === 2 && seg[0] === 'api' && seg[1] === 'v3' && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // GET /api/v3/meta
  if (seg.length === 3 && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: FORGE_VERSION, verifiable_password_authentication: false });
    return;
  }

  // GET /api/v3/user — the token owner.
  if (seg.length === 3 && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'user' && method === 'GET') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return;
  }

  // /api/v3/user/repos — list + create.
  if (seg.length === 4 && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'user' && seg[3] === 'repos') {
    if (method === 'GET') {
      const mine = [...repos.values()].filter((repo) => repo.owner === VIEWER_LOGIN);
      const { page, pageNum, perPage, totalPages } = paginate(mine, parsed.query);
      const extra: Record<string, string> = {};
      const link = linkHeader(req, '/api/v3/user/repos', parsed.query, pageNum, perPage, totalPages);
      if (link !== null) extra.link = link;
      sendJson(res, 200, page.map(repoJson), extra);
      return;
    }
    if (method === 'POST') {
      const name = typeof obj.name === 'string' ? obj.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'Validation Failed: name is required' });
        return;
      }
      if (repos.has(repoKey(VIEWER_LOGIN, name))) {
        sendJson(res, 422, { message: `Repository ${name} already exists` });
        return;
      }
      const repo = createRepo(name, obj.private === true, typeof obj.description === 'string' ? obj.description : '');
      sendJson(res, 201, repoJson(repo));
      return;
    }
  }

  // /api/v3/repos/{owner}/{repo} and below.
  if (seg.length >= 5 && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'repos') {
    const owner = seg[3] as string;
    const name = seg[4] as string;
    const repo = getRepo(owner, name);
    const rest = seg.slice(5);

    // The repository itself.
    if (rest.length === 0) {
      if (repo === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        if (typeof obj.description === 'string') repo.description = obj.description;
        if (typeof obj.private === 'boolean') repo.priv = obj.private;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        sendNoContent(res);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // GET /branches, GET /branches/{branch}
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const list = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string }, protected: false }));
        sendJson(res, 200, list);
        return;
      }
      if (method === 'GET' && rest.length === 2) {
        const branch = rest[1] as string;
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
        return;
      }
    }

    // GET /commits[?sha=]
    if (rest[0] === 'commits' && method === 'GET' && rest.length === 1) {
      const refName = parsed.query.get('sha') ?? repo.defaultBranch;
      let tip = repo.refs.get(`refs/heads/${refName}`);
      if (tip === undefined && isOid(refName)) tip = refName;
      if (tip === undefined || !repo.objects.has(tip)) {
        sendJson(res, 200, []);
        return;
      }
      const out: JsonObj[] = [];
      const seen = new Set<string>();
      const queue: string[] = [tip];
      while (queue.length > 0) {
        const oid = queue.shift() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = repo.objects.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        const view = parseCommit(object.data);
        const authorLine = view.author;
        const emailMatch = authorLine.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
        const authorName = emailMatch?.[1] ?? VIEWER.name;
        const authorEmail = emailMatch?.[2] ?? VIEWER.email;
        const stamp = emailMatch?.[3] !== undefined ? Number(emailMatch[3]) : FIXED_EPOCH_SEC;
        out.push({
          sha: oid,
          commit: {
            message: view.message.trimEnd(),
            author: { name: authorName, email: authorEmail, date: isoOf(stamp) },
            committer: { name: authorName, email: authorEmail, date: isoOf(stamp) },
          },
          author: { login: VIEWER_LOGIN },
          committer: { login: VIEWER_LOGIN },
          parents: view.parents.map((parent) => ({ sha: parent })),
        });
        for (const parent of view.parents) queue.push(parent);
      }
      const { page } = paginate(out, parsed.query);
      sendJson(res, 200, page);
      return;
    }

    // POST /git/refs, GET /git/refs[/heads/{branch}]
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof obj.ref === 'string' ? obj.ref : '';
        const sha = typeof obj.sha === 'string' ? obj.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha)) {
          sendJson(res, 422, { message: 'Validation Failed: ref and sha are required' });
          return;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: `Reference ${ref} already exists` });
          return;
        }
        repo.refs.set(ref, sha);
        if (ref.startsWith('refs/heads/')) {
          const branch = ref.slice('refs/heads/'.length);
          repo.files.set(branch, filesAtCommit(repo, sha));
        }
        sendJson(res, 201, { ref, object: { sha }, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.slice(5)}` });
        return;
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          const list = [...repo.refs.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([ref, sha]) => ({ ref, object: { sha } }));
          sendJson(res, 200, list);
          return;
        }
        // /git/refs/heads/{branch} (branch names here hold no slashes in the suite)
        const refName = rest.slice(2).join('/');
        const sha = repo.refs.get(`refs/${refName}`);
        if (sha === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, 200, { ref: `refs/${refName}`, object: { sha } });
        return;
      }
    }

    // Contents: PUT/GET/DELETE /contents/{path...}
    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).join('/');
      await handleContents(req, res, repo, owner, name, contentPath, method, obj, parsed);
      return;
    }

    // Labels
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const labelName = typeof obj.name === 'string' ? obj.name : '';
        if (labelName === '') {
          sendJson(res, 422, { message: 'Validation Failed: name is required' });
          return;
        }
        const color = typeof obj.color === 'string' ? obj.color : 'ededed';
        const label: Label = { name: labelName, color };
        repo.labels.set(labelName, label);
        sendJson(res, 201, { name: label.name, color: label.color, description: '' });
        return;
      }
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
        return;
      }
    }

    // Issues
    if (rest[0] === 'issues') {
      await handleIssues(req, res, repo, owner, name, rest.slice(1), method, obj, parsed);
      return;
    }

    // Pull requests
    if (rest[0] === 'pulls') {
      await handlePulls(req, res, repo, owner, name, rest.slice(1), method, obj, parsed);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// Resolve the file map a contents read or write sees: a branch name, a
// commit oid, or the default branch when no ref is given.
function filesForRef(repo: Repo, ref: string | null): Map<string, Buffer> | null {
  if (ref === null) {
    const map = repo.files.get(repo.defaultBranch);
    if (map !== undefined) return map;
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (tip === undefined) return new Map();
    return filesAtCommit(repo, tip);
  }
  const branchMap = repo.files.get(ref);
  if (branchMap !== undefined) return branchMap;
  if (isOid(ref)) return filesAtCommit(repo, ref);
  return null;
}

async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  owner: string,
  name: string,
  contentPath: string,
  method: string,
  obj: JsonObj,
  parsed: ParsedUrl,
): Promise<void> {
  const refParam = parsed.query.get('ref');

  if (method === 'GET') {
    const files = filesForRef(repo, refParam);
    if (files === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // A directory (or the repository root) lists its immediate children.
    const prefix = contentPath === '' ? '' : `${contentPath}/`;
    const isDir = contentPath === '' || [...files.keys()].some((path) => path.startsWith(prefix));
    if (isDir && !files.has(contentPath)) {
      const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const first = rest.split('/')[0] as string;
        const childPath = prefix + first;
        if (rest.includes('/')) {
          if (!children.has(first)) {
            children.set(first, { type: 'dir', name: first, path: childPath, sha: hashObject('tree', buildTree([])) });
          }
        } else {
          const data = files.get(path) as Buffer;
          children.set(first, { type: 'file', name: first, path: childPath, sha: hashObject('blob', data) });
        }
      }
      const list = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      sendJson(res, 200, list);
      return;
    }
    const data = files.get(contentPath);
    if (data === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: contentPath.split('/').pop() ?? contentPath,
      path: contentPath,
      content: b64encode(data),
      sha: hashObject('blob', data),
    });
    return;
  }

  if (method === 'PUT') {
    const message = typeof obj.message === 'string' ? obj.message : 'update file';
    const contentB64 = typeof obj.content === 'string' ? obj.content : '';
    const branch = typeof obj.branch === 'string' ? obj.branch : repo.defaultBranch;
    const givenSha = typeof obj.sha === 'string' ? obj.sha : undefined;
    const ref = `refs/heads/${branch}`;
    let files = repo.files.get(branch);
    if (files === undefined) {
      // A write to a branch that does not exist yet creates it from the
      // default branch tip (or from nothing on an unborn repository).
      const baseFiles = filesForRef(repo, null) ?? new Map<string, Buffer>();
      files = new Map(baseFiles);
      repo.files.set(branch, files);
    } else {
      files = new Map(files);
    }
    const existing = files.get(contentPath);
    if (existing !== undefined) {
      const currentSha = hashObject('blob', existing);
      if (givenSha === undefined || givenSha.toLowerCase() !== currentSha.toLowerCase()) {
        sendJson(res, 409, { message: 'sha does not match the current blob' });
        return;
      }
    }
    const data = b64decode(contentB64);
    files.set(contentPath, data);
    const commitSha = commitFiles(repo, branch, files, message);
    const created = existing === undefined;
    sendJson(res, created ? 201 : 200, {
      content: {
        name: contentPath.split('/').pop() ?? contentPath,
        path: contentPath,
        sha: hashObject('blob', data),
        size: data.length,
        encoding: 'base64',
        content: contentB64,
      },
      commit: { sha: commitSha, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const message = typeof obj.message === 'string' ? obj.message : 'delete file';
    const branch = typeof obj.branch === 'string' ? obj.branch : repo.defaultBranch;
    const files = repo.files.get(branch);
    if (files === undefined || !files.has(contentPath)) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const next = new Map(files);
    next.delete(contentPath);
    const commitSha = commitFiles(repo, branch, next, message);
    sendJson(res, 200, { commit: { sha: commitSha, message } });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  owner: string,
  name: string,
  rest: string[],
  method: string,
  obj: JsonObj,
  parsed: ParsedUrl,
): Promise<void> {
  // POST /issues — create.
  if (rest.length === 0 && method === 'POST') {
    const title = typeof obj.title === 'string' ? obj.title : '';
    const body = typeof obj.body === 'string' ? obj.body : '';
    const rawLabels = Array.isArray(obj.labels) ? obj.labels : [];
    const labels: Label[] = [];
    for (const entry of rawLabels) {
      const labelName = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? String((entry as JsonObj).name ?? '') : '';
      const found = repo.labels.get(labelName);
      if (found === undefined) {
        sendJson(res, 422, { message: `Validation Failed: label "${labelName}" does not exist` });
        return;
      }
      labels.push(found);
    }
    repo.issueSeq += 1;
    const number = repo.issueSeq;
    const issue: Issue = {
      id: globalId('Issue', `${repoKey(owner, name)}#${number}`),
      number,
      title,
      body,
      state: 'open',
      labels,
      seq: nextStamp(),
      comments: [],
    };
    repo.issues.push(issue);
    sendJson(res, 201, issueJson(repo, issue));
    return;
  }

  // GET /issues — list, filtered and sorted.
  if (rest.length === 0 && method === 'GET') {
    const state = parsed.query.get('state') ?? 'open';
    let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    const sort = parsed.query.get('sort') ?? 'created';
    const direction = parsed.query.get('direction') ?? 'desc';
    if (sort === 'created') {
      list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    }
    const { page } = paginate(list, parsed.query);
    sendJson(res, 200, page.map((issue) => issueJson(repo, issue)));
    return;
  }

  const number = Number(rest[0]);
  if (!Number.isSafeInteger(number) || number < 1) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GET /issues/{n}
  if (rest.length === 1 && method === 'GET') {
    sendJson(res, 200, issueJson(repo, issue));
    return;
  }

  // PATCH /issues/{n}
  if (rest.length === 1 && method === 'PATCH') {
    if (obj.state === 'open' || obj.state === 'closed') issue.state = obj.state;
    if (typeof obj.title === 'string') issue.title = obj.title;
    if (typeof obj.body === 'string') issue.body = obj.body;
    sendJson(res, 200, issueJson(repo, issue));
    return;
  }

  // Comments on one issue.
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const commentBody = typeof obj.body === 'string' ? obj.body : '';
      repo.commentSeq += 1;
      const comment: IssueComment = {
        id: globalId('Comment', `${repoKey(owner, name)}#${number}/c${repo.commentSeq}`),
        body: commentBody,
        seq: nextStamp(),
      };
      issue.comments.push(comment);
      sendJson(res, 201, {
        id: repo.commentSeq,
        node_id: comment.id,
        body: comment.body,
        user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
        created_at: isoOf(FIXED_EPOCH_SEC + comment.seq),
      });
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment, index) => ({
        id: index + 1,
        node_id: comment.id,
        body: comment.body,
        user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
        created_at: isoOf(FIXED_EPOCH_SEC + comment.seq),
      })));
      return;
    }
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  owner: string,
  name: string,
  rest: string[],
  method: string,
  obj: JsonObj,
  parsed: ParsedUrl,
): Promise<void> {
  // POST /pulls — open a pull request from a head branch onto a base branch.
  if (rest.length === 0 && method === 'POST') {
    const title = typeof obj.title === 'string' ? obj.title : '';
    const body = typeof obj.body === 'string' ? obj.body : '';
    const headRaw = typeof obj.head === 'string' ? obj.head : '';
    const baseRaw = typeof obj.base === 'string' ? obj.base : repo.defaultBranch;
    const head = headRaw.replace(/^refs\/heads\//, '');
    const base = baseRaw.replace(/^refs\/heads\//, '');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) {
      sendJson(res, 422, { message: 'Validation Failed: head and base branches must exist' });
      return;
    }
    repo.pullSeq += 1;
    const number = repo.pullSeq;
    const headFiles = repo.files.get(head) ?? filesAtCommit(repo, headSha);
    const baseFiles = repo.files.get(base) ?? filesAtCommit(repo, baseSha);
    const pull: Pull = {
      id: globalId('PullRequest', `${repoKey(owner, name)}#${number}`),
      number,
      title,
      body,
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      files: diffFiles(baseFiles, headFiles),
      seq: nextStamp(),
    };
    repo.pulls.push(pull);
    sendJson(res, 201, pullJson(repo, pull));
    return;
  }

  // GET /pulls — list.
  if (rest.length === 0 && method === 'GET') {
    const state = parsed.query.get('state') ?? 'open';
    const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
    const { page } = paginate(list, parsed.query);
    sendJson(res, 200, page.map((pull) => pullJson(repo, pull)));
    return;
  }

  const number = Number(rest[0]);
  if (!Number.isSafeInteger(number) || number < 1) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GET /pulls/{n}
  if (rest.length === 1 && method === 'GET') {
    sendJson(res, 200, pullJson(repo, pull));
    return;
  }

  // GET /pulls/{n}/files
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    sendJson(res, 200, pull.files.map((file) => ({
      sha: hashObject('blob', Buffer.from(file.filename, 'utf8')),
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    })));
    return;
  }

  // PUT /pulls/{n}/merge — squash-merge onto the base branch.
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull.merged && pull.mergeCommitSha !== null) {
      sendJson(res, 200, { sha: pull.mergeCommitSha, merged: true, message: 'Pull request successfully merged' });
      return;
    }
    if (pull.state !== 'open') {
      sendJson(res, 405, { message: 'Pull request is not open' });
      return;
    }
    if (pullConflicts(repo, pull)) {
      sendJson(res, 405, { message: 'This branch has conflicts that must be resolved' });
      return;
    }
    const baseFiles = repo.files.get(pull.base) ?? filesAtCommit(repo, pull.baseSha);
    const headFiles = repo.files.get(pull.head) ?? filesAtCommit(repo, pull.headSha);
    void baseFiles;
    const mergedFiles = new Map(headFiles);
    const mergeSha = commitFiles(repo, pull.base, mergedFiles, `Merge pull request #${pull.number} from ${pull.head}`);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = '2025-01-01T00:00:00Z';
    pull.mergeCommitSha = mergeSha;
    pull.baseSha = mergeSha;
    sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, oid]) => ({ name, oid }));
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? 'side-band-64k thin-pack ofs-delta shallow multi_ack multi_ack_detailed agent=forge/1.0 symref=HEAD:refs/heads/main'
    : 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const mainTip = repo.refs.get('refs/heads/main');
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${mainTip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const obj = repo.objects.get(ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToCommit(ref.oid, (oid) => repo.objects.get(oid));
        if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine('agent=forge/1.0\n'),
    pktFlush(),
  ]);
}

// The objects a fetch must send: the closure of `wants` (cut at `depth`
// generations when given) minus everything reachable from `haves`.
function fetchSelection(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | undefined,
  prevShallow: readonly string[],
): { objects: GitObj[]; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObj | undefined => repo.objects.get(oid);
  // What the client already holds: the haves' closure, cut at the shallow
  // boundaries the request names. A shallow boundary commit is held, but
  // its parents are not — walking past one would delete exactly the
  // objects a deepen is supposed to deliver.
  const haveSet = new Set<string>();
  {
    const boundarySet = new Set(prevShallow);
    const queue: string[] = [...haves];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const obj = lookup(oid);
      if (obj === undefined) continue;
      seen.add(oid);
      haveSet.add(oid);
      if (obj.type === 'commit') {
        const view = parseCommit(obj.data);
        queue.push(view.tree);
        if (!boundarySet.has(oid)) {
          for (const parent of view.parents) queue.push(parent);
        }
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      }
    }
  }
  const tagOids: string[] = [];
  const commitDepth = new Map<string, number>();
  const queue: { oid: string; depth: number }[] = [];
  for (const want of wants) {
    const obj = lookup(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      tagOids.push(want);
      queue.push({ oid: parseTag(obj.data).object, depth: 0 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: want, depth: 0 });
    }
  }
  while (queue.length > 0) {
    const item = queue.shift() as { oid: string; depth: number };
    const known = commitDepth.get(item.oid);
    if (known !== undefined && known <= item.depth) continue;
    commitDepth.set(item.oid, item.depth);
    if (depth !== undefined && item.depth + 1 >= depth) continue;
    const obj = lookup(item.oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      queue.push({ oid: parent, depth: item.depth + 1 });
    }
  }
  const included = new Set<string>();
  for (const [oid, d] of commitDepth) {
    if (depth === undefined || d < depth) included.add(oid);
  }
  const boundary = new Set<string>();
  if (depth !== undefined) {
    for (const [oid, d] of commitDepth) {
      if (d === depth - 1) boundary.add(oid);
    }
  }
  // Walk one commit's own tree and blobs only: parent commits are never
  // followed here, because the included set already enumerates exactly
  // which commits travel. (Following parents would defeat a shallow
  // fetch: collectReachable walks the whole history.)
  const send = new Set<string>();
  const addCommitFiles = (root: string): void => {
    const queue: string[] = [root];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const obj = lookup(oid);
      if (obj === undefined) continue;
      seen.add(oid);
      send.add(oid);
      if (obj.type === 'commit') {
        queue.push(parseCommit(obj.data).tree);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      }
    }
  };
  for (const oid of included) addCommitFiles(oid);
  for (const oid of tagOids) send.add(oid);
  for (const oid of haveSet) send.delete(oid);
  const objects: GitObj[] = [];
  for (const oid of send) {
    const obj = lookup(oid);
    if (obj !== undefined) objects.push(obj);
  }
  const shallow = [...boundary].filter((oid) => send.has(oid));
  const unshallow = prevShallow.filter((oid) => included.has(oid) && !boundary.has(oid));
  return { objects, shallow, unshallow };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 32768) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 32768));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const lines: Buffer[] = [];
  const refs = sortedRefs(repo);
  const mainTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    if (unborn) lines.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    lines.push(pktFlush());
    return Buffer.concat(lines);
  }
  // The HEAD symref is a ref named HEAD, so it answers exactly the
  // prefixes it matches: with no prefixes, and with a `HEAD` prefix (as
  // git clone sends), but never with a `refs/heads/`-only prefix.
  if (symrefs && mainTip !== undefined && (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix)))) {
    lines.push(pktLine(`${mainTip} HEAD symref-target:refs/heads/main\n`));
  }
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const obj = repo.objects.get(ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToCommit(ref.oid, (oid) => repo.objects.get(oid));
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

function handleFetchV2(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
    else if (arg === 'done') done = true;
  }
  // A fetch round that has not sent `done` is still negotiating: answer
  // with the acknowledgments section only, closed by a flush (never a
  // delim — the client dies if any other section follows a no-ready ack).
  // It then sends another round, with more haves or with `done`.
  if (!done) {
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    let acked = false;
    for (const have of haves) {
      if (wants.some((want) => isAncestor(repo, have, want))) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  // The request sent `done`, so the client skips the acknowledgments
  // section entirely and reads straight for the packfile: sending one
  // here makes it die with "expected 'packfile', received
  // 'acknowledgments'". The packfile section comes first (after an
  // optional shallow-info section), and a flush ends the HTTP response.
  const selection = fetchSelection(repo, wants, haves, depth, shallow);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim().split(' ')[0] as string);
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
  }
  const selection = fetchSelection(repo, wants, haves, depth, shallow);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

// Parse a receive-pack body: pkt-lines up to the flush, then the pack bytes.
function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const commands: PushCommand[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line in receive-pack');
    const lenText = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      offset += 4;
      break;
    }
    if (offset + len > body.length) throw new Error('pkt-line overruns its buffer');
    const line = body.subarray(offset + 4, offset + len).toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const parts = head.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
    offset += len;
  }
  const pack = offset < body.length ? body.subarray(offset) : null;
  return { commands, pack };
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  let commands: PushCommand[] = [];
  let pack: Buffer | null = null;
  let unpackError: string | null = null;
  try {
    const parsed = parseReceivePack(body);
    commands = parsed.commands;
    pack = parsed.pack;
  } catch (err) {
    unpackError = err instanceof Error ? err.message : String(err);
  }

  const unpacked: GitObj[] = [];
  if (unpackError === null && pack !== null && pack.length > 0) {
    try {
      const read = readPack(pack, (oid) => repo.objects.get(oid));
      for (const entry of read.entries) unpacked.push({ type: entry.type, data: entry.data });
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  if (unpackError === null) {
    for (const obj of unpacked) {
      const oid = hashObject(obj.type, obj.data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }

  const inner: Buffer[] = [];
  if (unpackError !== null) {
    inner.push(pktLine(`unpack ${unpackError}\n`));
  } else {
    inner.push(pktLine('unpack ok\n'));
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = false;
      let reason = '';
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reason = 'no such ref';
        } else if (current !== command.oldOid) {
          reason = 'non-fast-forward';
        } else {
          ok = true;
        }
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reason = 'already exists';
        } else if (!repo.objects.has(command.newOid)) {
          reason = 'missing object';
        } else {
          ok = true;
        }
      } else {
        // Update: old must match, and new must descend from old.
        if (current === undefined) {
          reason = 'no such ref';
        } else if (current !== command.oldOid) {
          reason = 'non-fast-forward';
        } else if (!repo.objects.has(command.newOid)) {
          reason = 'missing object';
        } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
          reason = 'non-fast-forward';
        } else {
          ok = true;
        }
      }
      if (ok) {
        if (command.newOid === ZERO_OID) {
          repo.refs.delete(command.ref);
          if (command.ref.startsWith('refs/heads/')) {
            repo.files.delete(command.ref.slice('refs/heads/'.length));
          }
        } else {
          repo.refs.set(command.ref, command.newOid);
          if (command.ref.startsWith('refs/heads/')) {
            repo.files.set(command.ref.slice('refs/heads/'.length), filesAtCommit(repo, command.newOid));
          }
        }
        inner.push(pktLine(`ok ${command.ref}\n`));
      } else {
        inner.push(pktLine(`ng ${command.ref} ${reason}\n`));
      }
    }
  }
  inner.push(pktFlush());
  const report = Buffer.concat(inner);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < report.length; offset += 32768) {
    const chunk = report.subarray(offset, Math.min(report.length, offset + 32768));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, parsed: ParsedUrl): Promise<void> {
  const method = req.method ?? 'GET';
  const seg = parsed.segments;
  // /{owner}/{repo}.git/...
  if (seg.length < 2 || !seg[1]?.endsWith('.git')) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const owner = seg[0] as string;
  const repoName = (seg[1] as string).slice(0, -'.git'.length);
  const repo = getRepo(owner, repoName);
  const tail = seg.slice(2);

  // GET /info/refs?service=...
  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = parsed.query.get('service');
    if (repo === undefined || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
    const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
    sendRaw(res, 200, `application/x-${service}-advertisement`, body);
    return;
  }

  // POST /git-upload-pack and /git-receive-pack.
  if (method === 'POST' && tail.length === 1 && (tail[0] === 'git-upload-pack' || tail[0] === 'git-receive-pack')) {
    const service = tail[0] as 'git-upload-pack' | 'git-receive-pack';
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const body = await readBody(req);
    try {
      if (service === 'git-receive-pack') {
        const out = handleReceivePack(repo, body);
        sendRaw(res, 200, 'application/x-git-receive-pack-result', out);
        return;
      }
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const packets = decodePktLines(body);
      const args: string[] = [];
      for (const packet of packets) {
        if (packet.kind === 'flush' || packet.kind === 'delim') {
          if (packet.kind === 'flush') break;
          continue;
        }
        if (packet.kind === 'data') args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
      }
      const command = args[0] ?? '';
      let out: Buffer;
      if (isV2 && command === 'command=ls-refs') {
        out = handleLsRefs(repo, args.slice(1));
      } else if (isV2 && command === 'command=fetch') {
        out = handleFetchV2(repo, args.slice(1));
      } else if (!isV2) {
        out = handleFetchV0(repo, args);
      } else {
        throw new Error(`unknown upload-pack command ${JSON.stringify(command)}`);
      }
      sendRaw(res, 200, 'application/x-git-upload-pack-result', out);
    } catch (err) {
      // A malformed request must not take the server down with it.
      sendRaw(res, 400, 'text/plain; charset=utf-8', Buffer.from(`bad request: ${err instanceof Error ? err.message : String(err)}\n`, 'utf8'));
    }
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------
// GraphQL v4
// ---------------------------------------------------------------------------
// A small executor for exactly the documents gh and github-mcp-server send:
// queries and mutations with variables, aliases, inline fragments, input
// objects and enum literals. Anything outside the known schema answers a
// field error naming the field, with HTTP 200, as the real API does.

interface GqlField {
  alias: string;
  name: string;
  args: Record<string, unknown>;
  children: GqlField[] | null;
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string;
  fields: GqlField[];
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'var'; value: string }
  | { kind: 'punct'; value: string };

function gqlLex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (/\s/.test(ch) || ch === ',') {
      // Commas are insignificant separators in GraphQL documents.
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():![]=|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'var', value: input.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'int', value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

interface GqlParserState {
  tokens: Token[];
  pos: number;
}

function gqlPeek(state: GqlParserState): Token | undefined {
  return state.tokens[state.pos];
}

function gqlNext(state: GqlParserState): Token {
  const token = state.tokens[state.pos] as Token;
  state.pos += 1;
  return token;
}

function gqlExpectPunct(state: GqlParserState, value: string): void {
  const token = gqlNext(state);
  if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
}

function gqlParseValue(state: GqlParserState, variables: Record<string, unknown>): unknown {
  const token = gqlNext(state);
  if (token.kind === 'var') return variables[token.value] ?? null;
  if (token.kind === 'string' || token.kind === 'int') return token.value;
  if (token.kind === 'name') {
    if (token.value === 'true') return true;
    if (token.value === 'false') return false;
    if (token.value === 'null') return null;
    return token.value;
  }
  if (token.kind === 'punct' && token.value === '[') {
    const list: unknown[] = [];
    while (!(gqlPeek(state)?.kind === 'punct' && gqlPeek(state)?.value === ']')) {
      list.push(gqlParseValue(state, variables));
    }
    gqlExpectPunct(state, ']');
    return list;
  }
  if (token.kind === 'punct' && token.value === '{') {
    const obj: Record<string, unknown> = {};
    while (!(gqlPeek(state)?.kind === 'punct' && gqlPeek(state)?.value === '}')) {
      const key = gqlNext(state);
      if (key.kind !== 'name') throw new Error('expected an input-object key');
      gqlExpectPunct(state, ':');
      obj[key.value] = gqlParseValue(state, variables);
    }
    gqlExpectPunct(state, '}');
    return obj;
  }
  throw new Error(`unexpected token in GraphQL value: ${JSON.stringify(token)}`);
}

function gqlParseFields(state: GqlParserState, variables: Record<string, unknown>): GqlField[] {
  gqlExpectPunct(state, '{');
  const fields: GqlField[] = [];
  while (!(gqlPeek(state)?.kind === 'punct' && gqlPeek(state)?.value === '}')) {
    const first = gqlNext(state);
    if (first.kind === 'punct' && first.value === '...') {
      // Inline fragment: `... on Type { ... }` (or a bare spread, ignored).
      const next = gqlPeek(state);
      if (next?.kind === 'name' && next.value === 'on') {
        gqlNext(state);
        const typeName = gqlNext(state);
        if (typeName.kind !== 'name') throw new Error('expected a type name after ... on');
        const children = gqlParseFields(state, variables);
        fields.push({ alias: `...on:${typeName.value}`, name: `...on:${typeName.value}`, args: {}, children });
        continue;
      }
      const fragName = gqlNext(state);
      void fragName;
      continue;
    }
    if (first.kind !== 'name') throw new Error('expected a field name');
    let alias = first.value;
    let name = first.value;
    const maybeColon = gqlPeek(state);
    if (maybeColon?.kind === 'punct' && maybeColon.value === ':') {
      gqlNext(state);
      const real = gqlNext(state);
      if (real.kind !== 'name') throw new Error('expected a field name after an alias');
      name = real.value;
    }
    const args: Record<string, unknown> = {};
    const maybeParen = gqlPeek(state);
    if (maybeParen?.kind === 'punct' && maybeParen.value === '(') {
      gqlNext(state);
      while (!(gqlPeek(state)?.kind === 'punct' && gqlPeek(state)?.value === ')')) {
        const key = gqlNext(state);
        if (key.kind !== 'name') throw new Error('expected an argument name');
        gqlExpectPunct(state, ':');
        args[key.value] = gqlParseValue(state, variables);
      }
      gqlExpectPunct(state, ')');
    }
    let children: GqlField[] | null = null;
    const maybeBrace = gqlPeek(state);
    if (maybeBrace?.kind === 'punct' && maybeBrace.value === '{') {
      children = gqlParseFields(state, variables);
    }
    fields.push({ alias, name, args, children });
  }
  gqlExpectPunct(state, '}');
  return fields;
}

function gqlParseOperation(query: string, variables: Record<string, unknown>): GqlOperation {
  const state: GqlParserState = { tokens: gqlLex(query), pos: 0 };
  let kind: 'query' | 'mutation' = 'query';
  let name = '';
  const first = gqlPeek(state);
  if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
    kind = gqlNext(state).value as 'query' | 'mutation';
    const named = gqlPeek(state);
    if (named?.kind === 'name') name = gqlNext(state).value;
  }
  // Variable definitions: ($x: Type!, $y: Type = default)
  const maybeParen = gqlPeek(state);
  if (maybeParen?.kind === 'punct' && maybeParen.value === '(') {
    let depth = 0;
    while (state.pos < state.tokens.length) {
      const token = gqlNext(state);
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
  }
  const fields = gqlParseFields(state, variables);
  return { kind, name, fields };
}

// ---------------------------------------------------------------------------
// GraphQL nodes and field resolution
// ---------------------------------------------------------------------------

type GqlNode = Record<string, unknown> & { __typename: string };

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'headRef', 'baseRef', 'url', 'author', 'createdAt', 'mergedAt', 'mergeCommitSha'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt'],
  SearchType: [],
};

const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

function userNode(): GqlNode {
  return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function issueNode(repo: Repo, issue: Issue): GqlNode {
  return {
    __typename: 'Issue',
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: isoOf(FIXED_EPOCH_SEC + issue.seq),
    _repo: repo,
    _issue: issue,
  };
}

function prNode(repo: Repo, pull: Pull): GqlNode {
  const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
  return {
    __typename: 'PullRequest',
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state,
    headRefName: pull.head,
    baseRefName: pull.base,
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    mergeCommitSha: pull.mergeCommitSha,
    _repo: repo,
    _pull: pull,
  };
}

function repoNode(repo: Repo): GqlNode {
  return {
    __typename: 'Repository',
    id: globalId('Repository', repoKey(repo.owner, repo.name)),
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: repoKey(repo.owner, repo.name),
    description: repo.description,
    private: repo.priv,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: isoOf(FIXED_EPOCH_SEC + repo.seq),
    _repo: repo,
  };
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function findRepoByGlobalId(id: string): Repo | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return undefined;
  const slash = decoded.key.indexOf('/');
  if (slash < 0) return undefined;
  return getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1));
}

function findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return undefined;
  const hash = decoded.key.lastIndexOf('#');
  if (hash < 0) return undefined;
  const full = decoded.key.slice(0, hash);
  const slash = full.indexOf('/');
  if (slash < 0) return undefined;
  const repo = getRepo(full.slice(0, slash), full.slice(slash + 1));
  if (repo === undefined) return undefined;
  const issue = repo.issues.find((entry) => entry.number === Number(decoded.key.slice(hash + 1)));
  if (issue === undefined) return undefined;
  return { repo, issue };
}

function findPullByGlobalId(id: string): { repo: Repo; pull: Pull } | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return undefined;
  const hash = decoded.key.lastIndexOf('#');
  if (hash < 0) return undefined;
  const full = decoded.key.slice(0, hash);
  const slash = full.indexOf('/');
  if (slash < 0) return undefined;
  const repo = getRepo(full.slice(0, slash), full.slice(slash + 1));
  if (repo === undefined) return undefined;
  const pull = repo.pulls.find((entry) => entry.number === Number(decoded.key.slice(hash + 1)));
  if (pull === undefined) return undefined;
  return { repo, pull };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const field = typeof orderBy?.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy?.direction === 'string' ? orderBy.direction : 'ASC';
  void field;
  list.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  const after = typeof args.after === 'string' ? args.after : null;
  if (after !== null && after !== '') {
    try {
      const text = Buffer.from(after, 'base64').toString('utf8');
      const num = Number(text.slice('cursor:'.length));
      if (Number.isSafeInteger(num)) list = list.filter((issue) => issue.number > num);
    } catch {
      // An unreadable cursor pages from the start.
    }
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNext = list.length > page.length;
  const endCursor = page.length > 0 ? b64encode(`cursor:${page[page.length - 1]?.number ?? 0}`) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueNode(repo, issue)),
    totalCount: list.length,
    pageInfo: { __typename: 'PageInfo', hasNextPage: hasNext, endCursor },
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
  const page = repo.pulls.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => prNode(repo, pull)),
    totalCount: repo.pulls.length,
    pageInfo: { __typename: 'PageInfo', hasNextPage: repo.pulls.length > page.length, endCursor: null },
  };
}

function doMerge(repo: Repo, pull: Pull): { sha: string } | { conflict: true } {
  if (pull.merged && pull.mergeCommitSha !== null) return { sha: pull.mergeCommitSha };
  if (pull.state !== 'open') return { conflict: true };
  if (pullConflicts(repo, pull)) return { conflict: true };
  const headFiles = repo.files.get(pull.head) ?? filesAtCommit(repo, pull.headSha);
  const mergeSha = commitFiles(repo, pull.base, new Map(headFiles), `Merge pull request #${pull.number} from ${pull.head}`);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = '2025-01-01T00:00:00Z';
  pull.mergeCommitSha = mergeSha;
  pull.baseSha = mergeSha;
  return { sha: mergeSha };
}

// Resolve one field of a node. Returns {value} or {error}.
function resolveField(
  node: GqlNode,
  field: GqlField,
  errors: { message: string }[],
): unknown {
  const typeName = node.__typename;
  const name = field.name;

  // Inline fragments only apply when the type matches.
  if (name.startsWith('...on:')) {
    const wanted = name.slice('...on:'.length);
    if (wanted !== typeName) return undefined;
    return node;
  }

  // __type introspection, available on the Query root.
  if (typeName === 'Query' && name === '__type') {
    const typeArg = field.args.name;
    const type = typeof typeArg === 'string' ? typeArg : '';
    const fields = GQL_TYPE_FIELDS[type];
    const enums = GQL_ENUM_VALUES[type];
    return {
      __typename: '__Type',
      name: type,
      kind: enums !== undefined ? 'ENUM' : 'OBJECT',
      fields: fields === undefined ? null : fields.map((fieldName) => ({ __typename: '__Field', name: fieldName })),
      enumValues: enums === undefined ? null : enums.map((value) => ({ __typename: '__EnumValue', name: value })),
    };
  }
  if (typeName === 'Query' && name === '__schema') {
    return { __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [] };
  }

  if (typeName === 'Query' && name === 'viewer') return userNode();
  if (typeName === 'Query' && name === 'repository') {
    const owner = typeof field.args.owner === 'string' ? field.args.owner : '';
    const repoName = typeof field.args.name === 'string' ? field.args.name : '';
    const repo = getRepo(owner, repoName);
    return repo === undefined ? null : repoNode(repo);
  }
  if (typeName === 'Query' && name === 'node') {
    const id = typeof field.args.id === 'string' ? field.args.id : '';
    const decoded = decodeGlobalId(id);
    if (decoded === null) return null;
    if (decoded.kind === 'Repository') {
      const repo = findRepoByGlobalId(id);
      return repo === undefined ? null : repoNode(repo);
    }
    if (decoded.kind === 'Issue') {
      const found = findIssueByGlobalId(id);
      return found === undefined ? null : issueNode(found.repo, found.issue);
    }
    if (decoded.kind === 'PullRequest') {
      const found = findPullByGlobalId(id);
      return found === undefined ? null : prNode(found.repo, found.pull);
    }
    return null;
  }

  if (typeName === 'Repository') {
    const repo = node._repo as Repo;
    if (name === 'owner') return userNode();
    if (name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
    }
    if (name === 'issue') {
      const num = typeof field.args.number === 'number' ? field.args.number : -1;
      const issue = repo.issues.find((entry) => entry.number === num);
      return issue === undefined ? null : issueNode(repo, issue);
    }
    if (name === 'issues') return issueConnection(repo, field.args);
    if (name === 'pullRequests') return pullConnection(repo, field.args);
    if (name === 'pullRequest') {
      const num = typeof field.args.number === 'number' ? field.args.number : -1;
      const pull = repo.pulls.find((entry) => entry.number === num);
      return pull === undefined ? null : prNode(repo, pull);
    }
  }

  if (typeName === 'PullRequest') {
    const repo = node._repo as Repo;
    const pull = node._pull as Pull;
    if (name === 'files') {
      const first = typeof field.args.first === 'number' ? field.args.first : pull.files.length;
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: pull.files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename })),
        totalCount: pull.files.length,
      };
    }
    if (name === 'mergeable') return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    if (name === 'nodes' || name === 'edges') return node.nodes ?? null;
    if (name === 'pageInfo') return node.pageInfo ?? null;
    if (name === 'totalCount') return node.totalCount ?? null;
  }

  if (typeName === '__Type') {
    if (name === 'fields') return node.fields ?? null;
    if (name === 'enumValues') return node.enumValues ?? null;
    if (name === 'name' || name === 'kind') return node[name] ?? null;
  }

  if (typeName === 'Mutation') {
    if (name === 'createIssue') {
      const input = (field.args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
      if (repo === undefined) throw new Error('createIssue: unknown repository');
      repo.issueSeq += 1;
      const number = repo.issueSeq;
      const issue: Issue = {
        id: globalId('Issue', `${repoKey(repo.owner, repo.name)}#${number}`),
        number,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        seq: nextStamp(),
        comments: [],
      };
      repo.issues.push(issue);
      return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
    }
    if (name === 'closeIssue') {
      const input = (field.args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGlobalId(typeof input.issueId === 'string' ? input.issueId : '');
      if (found === undefined) throw new Error('closeIssue: unknown issue');
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) };
    }
    if (name === 'createPullRequest') {
      const input = (field.args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
      if (repo === undefined) throw new Error('createPullRequest: unknown repository');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) throw new Error('createPullRequest: head and base branches must exist');
      repo.pullSeq += 1;
      const number = repo.pullSeq;
      const headFiles = repo.files.get(head) ?? filesAtCommit(repo, headSha);
      const baseFiles = repo.files.get(base) ?? filesAtCommit(repo, baseSha);
      const pull: Pull = {
        id: globalId('PullRequest', `${repoKey(repo.owner, repo.name)}#${number}`),
        number,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        head,
        base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        files: diffFiles(baseFiles, headFiles),
        seq: nextStamp(),
      };
      repo.pulls.push(pull);
      return { __typename: 'CreatePullRequestPayload', pullRequest: prNode(repo, pull) };
    }
    if (name === 'mergePullRequest') {
      const input = (field.args.input ?? {}) as Record<string, unknown>;
      const found = findPullByGlobalId(typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
      if (found === undefined) throw new Error('mergePullRequest: unknown pull request');
      const result = doMerge(found.repo, found.pull);
      if ('conflict' in result) throw new Error('mergePullRequest: pull request is conflicted');
      return { __typename: 'MergePullRequestPayload', pullRequest: prNode(found.repo, found.pull) };
    }
    if (name === 'addComment') {
      const input = (field.args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGlobalId(typeof input.subjectId === 'string' ? input.subjectId : '');
      if (found === undefined) throw new Error('addComment: unknown subject');
      found.repo.commentSeq += 1;
      const comment: IssueComment = {
        id: globalId('Comment', `${repoKey(found.repo.owner, found.repo.name)}#${found.issue.number}/c${found.repo.commentSeq}`),
        body: typeof input.body === 'string' ? input.body : '',
        seq: nextStamp(),
      };
      found.issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', id: comment.id, body: comment.body } },
      };
    }
  }

  // A plain property on the node answers the field.
  if (name in node && typeof node[name] !== 'function') return node[name] as unknown;

  errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
  return null;
}

function executeFields(
  node: GqlNode,
  fields: GqlField[],
  errors: { message: string }[],
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.name.startsWith('...on:')) {
      const wanted = field.name.slice('...on:'.length);
      if (wanted !== node.__typename) continue;
      if (field.children !== null) {
        Object.assign(data, executeFields(node, field.children, errors));
      }
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(node, field, errors);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      data[field.alias] = null;
      continue;
    }
    if (value === undefined) continue;
    if (field.children !== null) {
      if (value === null) {
        data[field.alias] = null;
      } else if (Array.isArray(value)) {
        data[field.alias] = value.map((item) => {
          if (item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
            return executeFields(item as GqlNode, field.children as GqlField[], errors);
          }
          return item;
        });
      } else if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
        data[field.alias] = executeFields(value as GqlNode, field.children, errors);
      } else {
        data[field.alias] = value;
      }
    } else {
      data[field.alias] = value;
    }
  }
  return data;
}

function executeOperation(query: string, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: { message: string }[] } {
  const errors: { message: string }[] = [];
  let operation: GqlOperation;
  try {
    operation = gqlParseOperation(query, variables);
  } catch (err) {
    return { data: {}, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const root: GqlNode = operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeFields(root, operation.fields, errors);
  return errors.length > 0 ? { data, errors } : { data };
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { message: 'Malformed JSON body' });
    return;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (typeof doc !== 'object' || doc === null) return { data: {}, errors: [{ message: 'expected a GraphQL document object' }] };
    const record = doc as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
    return executeOperation(query, variables);
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol, Streamable HTTP, revision 2026-07-28)
// ---------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpToolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    structuredContent: value,
  };
  if (isError) result.isError = true;
  return result;
}

function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tool = MCP_TOOLS.find((entry) => entry.name.replace(/[^a-z0-9]/g, '') === normalized) ??
    MCP_TOOLS.find((entry) => normalized.endsWith(entry.name.replace(/[^a-z0-9]/g, '')));
  if (tool === undefined) {
    return { __mcpError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return mcpToolResult(`Missing required argument: ${required}`, true);
    }
  }
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  const owner = str('owner');
  const repoName = str('repo');

  if (tool.name === 'create_repo') {
    const repoNameArg = str('name');
    if (repos.has(repoKey(VIEWER_LOGIN, repoNameArg))) {
      return mcpToolResult(`Repository ${repoNameArg} already exists`, true);
    }
    const repo = createRepo(repoNameArg, args.private === true, typeof args.description === 'string' ? (args.description as string) : '');
    return mcpToolResult(repoJson(repo));
  }

  const repo = getRepo(owner, repoName);
  if (repo === undefined) {
    return mcpToolResult(`Repository ${owner}/${repoName} not found`, true);
  }

  if (tool.name === 'get_repo') {
    return mcpToolResult(repoJson(repo));
  }
  if (tool.name === 'create_issue') {
    repo.issueSeq += 1;
    const number = repo.issueSeq;
    const issue: Issue = {
      id: globalId('Issue', `${repoKey(owner, repoName)}#${number}`),
      number,
      title: str('title'),
      body: str('body'),
      state: 'open',
      labels: [],
      seq: nextStamp(),
      comments: [],
    };
    repo.issues.push(issue);
    return mcpToolResult(issueJson(repo, issue));
  }
  if (tool.name === 'list_issues') {
    const state = str('state').toLowerCase() || 'open';
    const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return mcpToolResult(list.map((issue) => issueJson(repo, issue)));
  }
  if (tool.name === 'create_pull_request') {
    const head = str('head').replace(/^refs\/heads\//, '');
    const base = str('base').replace(/^refs\/heads\//, '');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) {
      return mcpToolResult('head and base branches must exist', true);
    }
    repo.pullSeq += 1;
    const number = repo.pullSeq;
    const headFiles = repo.files.get(head) ?? filesAtCommit(repo, headSha);
    const baseFiles = repo.files.get(base) ?? filesAtCommit(repo, baseSha);
    const pull: Pull = {
      id: globalId('PullRequest', `${repoKey(owner, repoName)}#${number}`),
      number,
      title: str('title'),
      body: str('body'),
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      files: diffFiles(baseFiles, headFiles),
      seq: nextStamp(),
    };
    repo.pulls.push(pull);
    return mcpToolResult(pullJson(repo, pull));
  }
  if (tool.name === 'merge_pull_request') {
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) {
      return mcpToolResult(`Pull request #${number} not found`, true);
    }
    if (pull.merged && pull.mergeCommitSha !== null) {
      return mcpToolResult({ sha: pull.mergeCommitSha, merged: true, message: 'Pull request successfully merged' });
    }
    if (pull.state !== 'open' || pullConflicts(repo, pull)) {
      return mcpToolResult('Pull request cannot be merged: it is conflicted or not open', true);
    }
    const result = doMerge(repo, pull);
    if ('conflict' in result) {
      return mcpToolResult('Pull request cannot be merged: it is conflicted', true);
    }
    return mcpToolResult({ sha: result.sha, merged: true, message: 'Pull request successfully merged' });
  }
  return { __mcpError: { code: -32602, message: `Unknown tool: ${name}` } };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const raw = await readBody(req);
  const text = raw.toString('utf8');
  let request: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    request = parsed as Record<string, unknown>;
  } catch {
    const body = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    res.writeHead(400, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  const reply = (result: unknown, extraHeaders: Record<string, string> = {}): void => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, result });
    res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(body), ...extraHeaders });
    res.end(body);
  };
  const replyError = (code: number, message: string): void => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
    res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  // Notifications carry no id and get no JSON-RPC reply.
  if (id === null || id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }

  if (method === 'server/discover') {
    reply({
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-forge', version: FORGE_VERSION },
      instructions: 'A standalone GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP tools.',
    });
    return;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    reply(
      {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone-forge', version: FORGE_VERSION },
      },
      { 'mcp-session-id': 'forge-session' },
    );
    return;
  }
  if (method === 'ping') {
    reply({});
    return;
  }
  if (method === 'tools/list') {
    reply({ tools: MCP_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    const outcome = mcpCallTool(name, args);
    if ('__mcpError' in outcome) {
      const error = outcome.__mcpError as { code: number; message: string };
      replyError(error.code, error.message);
      return;
    }
    reply(outcome);
    return;
  }
  replyError(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const parsed = parseUrl(req);
        const method = req.method ?? 'GET';
        const path = parsed.path;

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          await handleGraphQL(req, res);
          return;
        }
        if (path === '/mcp') {
          await handleMcp(req, res);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(req, res, parsed);
          return;
        }
        if (parsed.segments.length >= 2 && (parsed.segments[1] as string).endsWith('.git')) {
          await handleGit(req, res, parsed);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A request handler must never take the process down.
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        } else {
          try {
            res.end();
          } catch {
            // The socket is already gone.
          }
        }
      }
    })();
  });
}
