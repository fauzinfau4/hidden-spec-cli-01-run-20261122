// main.ts is mend, the CLI SPEC.md specifies (version 1). It does all ten sections of SPEC.md: the command
// line, the output and exit codes, safe paths, format detection, matching lines at three tiers (section 5),
// unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits
// (section 9) and the all-or-nothing write (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Successful move edits, as [old, new] pairs, in patch order. Used only to render `R` output lines. */
type Moves = Array<[string, string]>;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 3: a file as lines plus its own line break and final-break flag.
// ---------------------------------------------------------------------------

interface Doc {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers, and building the replacement.
// ---------------------------------------------------------------------------

function tierKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Positions i (>= from) where O matches the file's lines at `tier`. May overlap. */
function occurrences(lines: string[], o: string[], tier: number, from: number, endAnchored: boolean): number[] {
  const out: number[] = [];
  const ok = o.map((l) => tierKey(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    if (endAnchored && i + o.length !== lines.length) continue;
    let m = true;
    for (let j = 0; j < o.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== ok[j]) {
        m = false;
        break;
      }
    }
    if (m) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (from `from`), with its occurrences, or null. */
function firstTierWith(
  lines: string[],
  o: string[],
  strict: boolean,
  from: number,
  endAnchored: boolean,
): { tier: number; occ: number[] } | null {
  for (const t of tiers(strict)) {
    const occ = occurrences(lines, o, t, from, endAnchored);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Tier-2 re-indent of one new line: P (O's first line's leading whitespace) replaced by F. */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

interface ONEntry {
  text: string;
  ctx: boolean;
  /** Index into O of the context line this N entry repeats; -1 when not a context line. */
  oIndex: number;
}

/**
 * The lines N writes when O matched at `pos` in `fileLines` at `tier`: context lines are the
 * file's own matched lines, other lines are re-indented at tier 2 and written as they are otherwise.
 */
function replaceLines(fileLines: string[], pos: number, o: string[], n: ONEntry[], tier: number): string[] {
  const p = leadWs(o[0]!);
  const f = leadWs(fileLines[pos]!);
  return n.map((e) => {
    if (e.ctx) return fileLines[pos + e.oIndex]!;
    return tier === 2 ? reindent(e.text, p, f) : e.text;
  });
}

// ---------------------------------------------------------------------------
// Shared body-line model for unified hunks and V4A chunks.
// A body line is a context line (` ` or empty), an old line (`-`) or a new line (`+`).
// In a unified hunk a `\` line marks the body line before it (no final line break).
// ---------------------------------------------------------------------------

interface BodyEntry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line follows this entry (unified only). */
  bslash: boolean;
}

function bodyEntryFromLine(line: string): BodyEntry {
  if (line.startsWith(' ')) return { kind: 'ctx', text: line.slice(1), bslash: false };
  if (line.startsWith('-')) return { kind: 'old', text: line.slice(1), bslash: false };
  if (line.startsWith('+')) return { kind: 'new', text: line.slice(1), bslash: false };
  return { kind: 'ctx', text: '', bslash: false };
}

function parseBodyLines(raw: string[]): BodyEntry[] {
  const entries: BodyEntry[] = [];
  for (const l of raw) {
    if (l.startsWith('\\')) {
      if (entries.length > 0) entries[entries.length - 1]!.bslash = true;
      continue;
    }
    entries.push(bodyEntryFromLine(l));
  }
  return entries;
}

interface SplitON {
  o: string[];
  n: ONEntry[];
  /** A `\` line follows the hunk's last context or `+` line; false when there is none. */
  lastOutBslash: boolean;
  /** A `\` line follows the hunk's last `+` line; false when there is none. */
  lastNewBslash: boolean;
}

function splitON(entries: BodyEntry[]): SplitON {
  const o: string[] = [];
  const n: ONEntry[] = [];
  let lastOut: BodyEntry | null = null;
  let lastNew: BodyEntry | null = null;
  for (const e of entries) {
    if (e.kind === 'ctx' || e.kind === 'new') lastOut = e;
    if (e.kind === 'new') lastNew = e;
    if (e.kind === 'ctx') {
      const oi = o.length;
      o.push(e.text);
      n.push({ text: e.text, ctx: true, oIndex: oi });
    } else if (e.kind === 'old') {
      o.push(e.text);
    } else {
      n.push({ text: e.text, ctx: false, oIndex: -1 });
    }
  }
  return {
    o,
    n,
    lastOutBslash: lastOut === null ? false : lastOut.bslash,
    lastNewBslash: lastNew === null ? false : lastNew.bslash,
  };
}

/**
 * Apply one unified hunk to `doc` (already the result of the section's earlier hunks). `d` is the
 * sum over those hunks of (N length minus O length); returns the updated sum. Throws Fail.
 */
function applyHunk(doc: Doc, a: number, entries: BodyEntry[], d: number, strict: boolean, path: string): number {
  const { o, n, lastOutBslash } = splitON(entries);
  if (o.length === 0) {
    const insertPos = Math.max(0, Math.min(a + d, doc.lines.length));
    const out = n.map((e) => e.text);
    const runsToEnd = insertPos === doc.lines.length;
    doc.lines.splice(insertPos, 0, ...out);
    if (runsToEnd) doc.final = !lastOutBslash;
    return d + n.length;
  }
  const found = firstTierWith(doc.lines, o, strict, 0, false);
  if (found === null) throw new Fail('no-match', path);
  const target = a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const pos = best;
  const runsToEnd = pos + o.length === doc.lines.length;
  const out = replaceLines(doc.lines, pos, o, n, found.tier);
  doc.lines.splice(pos, o.length, ...out);
  if (runsToEnd) doc.final = !lastOutBslash;
  return d + (n.length - o.length);
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface UHunk {
  a: number;
  entries: BodyEntry[];
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  pairSeen: boolean;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

/** Path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed, `a/`/`b/` stripped. */
function headerPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function parseUnified(lines: string[], strict: boolean, moves: Moves): Edit[] {
  const diffRe = /^diff --git a\/(.+) b\/(.+)$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const startSection = (oldP: string | null, newP: string | null, pairSeen: boolean): void => {
    cur = {
      oldPath: oldP,
      newPath: newP,
      pairSeen,
      renameFrom: undefined,
      renameTo: undefined,
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    sections.push(cur);
    inHeader = true;
  };
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!, false);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      if (cur !== null && inHeader && !cur.pairSeen) {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.pairSeen = true;
      } else {
        startSection(oldP, newP, true);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const raw: string[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          raw.push(bl);
          i++;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      cur.hunks.push({ a, entries: parseBodyLines(raw) });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict, moves));
}

function unifiedSectionEdit(s: USection, strict: boolean, moves: Moves): Edit {
  // Path resolution: the `---`/`+++` pair wins, then `rename from`/`rename to`, then `diff --git`.
  let oldPath = s.oldPath;
  let newPath = s.newPath;
  if (!s.pairSeen) {
    if (s.renameFrom !== undefined) oldPath = s.renameFrom;
    if (s.renameTo !== undefined) newPath = s.renameTo;
  }
  if (oldPath === null && newPath === null) return () => {};
  if (oldPath === null || s.isCreate) {
    const newP = newPath!;
    const plusLines: string[] = [];
    // The last `+` line overall decides the final break; a later hunk without `+` lines keeps it.
    let lastPlusBslash = false;
    for (const h of s.hunks) {
      for (const e of h.entries) if (e.kind === 'new') plusLines.push(e.text);
      if (h.entries.some((e) => e.kind === 'new')) lastPlusBslash = splitON(h.entries).lastNewBslash;
    }
    return (tree) => {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.now.set(newP, plusLines.length === 0 ? '' : plusLines.join('\n') + (lastPlusBslash ? '' : '\n'));
    };
  }
  if (newPath === null || s.isDelete) {
    const oldP = oldPath!;
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
    };
  }
  if (oldPath !== newPath) {
    const oldP = oldPath;
    const newP = newPath;
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const doc = parseDoc(before);
      let d = 0;
      for (const h of s.hunks) d = applyHunk(doc, h.a, h.entries, d, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, renderDoc(doc));
      moves.push([oldP, newP]);
    };
  }
  const path = oldPath;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = parseDoc(before);
    let d = 0;
    for (const h of s.hunks) d = applyHunk(doc, h.a, h.entries, d, strict, path);
    tree.now.set(path, renderDoc(doc));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const s = i;
      let e = -1;
      for (let j = s + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          e = j;
          break;
        }
      }
      if (e < 0) throw new Exit2(`error: parse ${s + 1}`);
      let r = -1;
      for (let j = e + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          r = j;
          break;
        }
      }
      if (r < 0) throw new Exit2(`error: parse ${s + 1}`);
      let path: string | null = null;
      for (let j = s - 1; j > prevEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
        path = prevPath;
      }
      blocks.push({ path, oldLines: lines.slice(s + 1, e), newLines: lines.slice(e + 1, r) });
      prevPath = path;
      prevEnd = r;
      i = r + 1;
    } else {
      i++;
    }
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    const path = b.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (b.oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const doc = parseDoc(before);
      const found = firstTierWith(doc.lines, b.oldLines, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      if (found.occ.length > 1) throw new Fail('ambiguous', path);
      const pos = found.occ[0]!;
      const n: ONEntry[] = b.newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
      const out = replaceLines(doc.lines, pos, b.oldLines, n, found.tier);
      doc.lines.splice(pos, b.oldLines.length, ...out);
      tree.now.set(path, renderDoc(doc));
    };
  });
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: BodyEntry[];
}

interface VRawSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  startLine: number;
  raw: { text: string; lineNo: number }[];
}

function parseV4a(lines: string[], strict: boolean, moves: Moves): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VRawSection[] = [];
  let cur: VRawSection | null = null;
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const kind: 'add' | 'delete' | 'update' = line.startsWith('*** Add File: ')
        ? 'add'
        : line.startsWith('*** Delete File: ')
          ? 'delete'
          : 'update';
      const prefixLen = kind === 'add' ? 14 : 17;
      cur = { kind, path: line.slice(prefixLen).trim(), startLine: i + 1, raw: [] };
      sections.push(cur);
    } else if (cur !== null) {
      cur.raw.push({ text: line, lineNo: i + 1 });
    } else if (!blank(line)) {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aSectionEdit(s, strict, moves));
}

function v4aSectionEdit(s: VRawSection, strict: boolean, moves: Moves): Edit {
  // Blank lines at the end of a section (before the next section or `*** End Patch`) are not part of it.
  const raw = [...s.raw];
  while (raw.length > 0 && raw[raw.length - 1]!.text.trim() === '') raw.pop();
  const path = s.path;
  if (s.kind === 'add') {
    const fileLines: string[] = [];
    for (const r of raw) {
      if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
      else if (r.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${r.lineNo}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    for (const r of raw) {
      if (r.text.trim() === '') continue;
      throw new Exit2(`error: parse ${r.lineNo}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let idx = 0;
  let moveTo: string | null = null;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice(13).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; idx < raw.length; idx++) {
    const r = raw[idx]!;
    const line = r.text;
    if (line.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const a = line.slice(2).trim();
      cur = { anchor: a === '' ? null : a, eof: false, entries: [] };
    } else if (line === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.lineNo}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
    } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${r.lineNo}`);
        cur = { anchor: null, eof: false, entries: [] };
      }
      cur.entries.push(bodyEntryFromLine(line));
    } else {
      throw new Exit2(`error: parse ${r.lineNo}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.startLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = parseDoc(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const t of tiers(strict)) {
          for (let k = cursor; k < doc.lines.length; k++) {
            if (tierKey(doc.lines[k]!, t) === tierKey(ch.anchor, t)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const { o, n } = splitON(ch.entries);
      if (o.length === 0) {
        const insertPos = ch.eof ? doc.lines.length : cursor;
        const out = n.map((e) => e.text);
        doc.lines.splice(insertPos, 0, ...out);
        cursor = insertPos + out.length;
      } else {
        const found = firstTierWith(doc.lines, o, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.occ[0]!;
        const out = replaceLines(doc.lines, pos, o, n, found.tier);
        doc.lines.splice(pos, o.length, ...out);
        cursor = pos + out.length;
      }
    }
    const out = renderDoc(doc);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 1, 2 and 10: invocation, output and exit codes, order and atomicity.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Moves = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rPairs: Array<{ old: string; nw: string }> = [];
  for (const [o, n] of moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rPairs.push({ old: o, nw: n });
    }
  }
  const rOld = new Set(rPairs.map((p) => p.old));
  const rNew = new Set(rPairs.map((p) => p.nw));
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p) || rNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const pr of rPairs) rows.push({ key: pr.nw, text: `R ${pr.old} -> ${pr.nw}` });
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    const sortedPaths = [...tree.now.keys()].sort(byteOrder);
    for (const p of sortedPaths) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of sortedPaths) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
