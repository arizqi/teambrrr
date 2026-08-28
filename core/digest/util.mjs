import fs from 'node:fs';
import path from 'node:path';

export const MAX_DIGEST_CHARS = 6000;
export const NO_DIGEST = '(no channel transcript available)';

// --- tool results ------------------------------------------------------------
// Artifacts live in tool results: a recruit told only "[tool: Bash]" learns THAT
// something ran, never WHAT came back. So each result contributes a short
// excerpt. Excerpts share the digest window with the conversation but may never
// take more than TOOL_SHARE of it; when they would, the OLDEST excerpts are
// dropped first (their `[tool: name]` markers always survive, those live on the
// conversation line).
export const TOOL_EXCERPT_CHARS = 400;
export const TOOL_SHARE = 0.4;
export const TOOL_PREFIX = '  ⤷ result: ';
const TOOL_INDENT = '\n      ';

// Cheap, conservative binary/base64 sniff. Prose and stack traces contain
// spaces; base64 payloads (even wrapped at 76 columns) never do.
export function looksBinary(s) {
  const t = String(s ?? '');
  if (!t.trim()) return true;
  if (/^\s*data:[\w.+-]+\/[\w.+-]+;base64,/i.test(t)) return true;
  const ctrl = (t.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g) || []).length;
  if (ctrl > 0 && ctrl / t.length > 0.02) return true;
  if (!/ /.test(t)) {
    const compact = t.replace(/\s+/g, '');
    if (compact.length >= 120 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return true;
  }
  return false;
}

// null => nothing worth showing (empty or binary).
export function toolExcerpt(raw, cap = TOOL_EXCERPT_CHARS) {
  const t = String(raw ?? '').replace(/\r/g, '').trim();
  if (!t || looksBinary(t)) return null;
  const flat = t.replace(/\n[ \t]*\n+/g, '\n').trim();
  if (flat.length <= cap) return flat;
  return `${flat.slice(0, cap).trimEnd()}… (+${flat.length - cap} more chars)`;
}

// The digest line for one tool result, or null when it is skipped.
export function toolLine(raw, cap = TOOL_EXCERPT_CHARS) {
  const ex = toolExcerpt(raw, cap);
  if (!ex) return null;
  return TOOL_PREFIX + ex.split('\n').join(TOOL_INDENT);
}

// items: [{text, tool:boolean}] oldest first.
export function fitMixed(items, maxChars = MAX_DIGEST_CHARS, toolShare = TOOL_SHARE) {
  const cap = Math.floor(maxChars * toolShare);
  const kept = [];
  let toolTotal = 0;
  let toolsClosed = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.tool) {
      const len = it.text.length + 1;
      // Once the share is spent, every older excerpt goes — oldest dropped first.
      if (toolsClosed || toolTotal + len > cap) { toolsClosed = true; continue; }
      toolTotal += len;
    }
    kept.unshift(it.text);
  }
  return fitLines(kept, maxChars);
}

// Keep the newest lines that fit, trimming from the front.
export function fitLines(lines, maxChars = MAX_DIGEST_CHARS) {
  if (!lines.length) return NO_DIGEST;
  const kept = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const len = lines[i].length + 1;
    if (total + len > maxChars && kept.length) break;
    kept.unshift(lines[i].slice(0, maxChars));
    total += len;
  }
  return kept.join('\n');
}

export const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

export function walkFiles(dir, match, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of entries) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) walkFiles(full, match, out);
    else if (match(d.name)) out.push(full);
  }
  return out;
}

// Read only the first line of a possibly huge JSONL file.
export function readFirstLine(file, cap = 1 << 20) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(cap, 1 << 16));
    let acc = '';
    let pos = 0;
    while (pos < cap) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      acc += buf.subarray(0, n).toString('utf8');
      const i = acc.indexOf('\n');
      if (i >= 0) return acc.slice(0, i);
      pos += n;
    }
    return acc;
  } catch { return ''; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
