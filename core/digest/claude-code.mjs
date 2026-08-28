// DigestSource: Claude Code session transcripts (~/.claude/projects/<slug>/*.jsonl).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MAX_DIGEST_CHARS, NO_DIGEST, TOOL_SHARE, TOOL_EXCERPT_CHARS, fitMixed, toolLine, mtimeOf } from './util.mjs';

export const id = 'claude-code';

// cwd -> project slug. Claude Code replaces path separators and dots with '-';
// current versions (>=2.1.229) also replace '_', older ones did not. Compare on
// a fully normalized form so either directory naming convention resolves.
export function projectSlug(cwd) {
  return cwd.replace(/[/.]/g, '-');
}
const normalize = (s) => s.replace(/[^a-zA-Z0-9]/g, '-');

// The hook writes a session pointer. New location first, legacy spike path as
// fallback (the shipped UserPromptSubmit hook still writes the old one).
function sessionPointer(projectDir) {
  const candidates = [
    path.join(projectDir, '.room', 'session.json'),
    path.join(projectDir, '.claude', 'recruits', '.session')
  ];
  for (const p of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.transcript_path && fs.existsSync(j.transcript_path)) return j.transcript_path;
    } catch {}
  }
  return null;
}

export function locate({ projectDir }) {
  const pointed = sessionPointer(projectDir);
  if (pointed) return { file: pointed, mtime: mtimeOf(pointed), exact: true };
  try {
    const root = path.join(os.homedir(), '.claude', 'projects');
    const want = normalize(projectSlug(projectDir));
    const files = [];
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || normalize(d.name) !== want) continue;
      const dir = path.join(root, d.name);
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        files.push({ file: full, mtime: mtimeOf(full), exact: true });
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    if (files.length) return files[0];
  } catch {}
  return null;
}

// A tool_result's `content` is a string, or blocks ({type:'text'|'image'|...}).
// Images and other non-text blocks are dropped; only text can be excerpted.
function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean).join('\n');
  }
  if (c && typeof c === 'object' && typeof c.text === 'string') return c.text;
  return '';
}

// message.content is either a string or an array of blocks
// ({type:'text'|'thinking'|'tool_use'|'tool_result'|...}).
//
// Returns the conversation text for the turn plus the tool-result excerpts it
// carried. The two are budgeted separately by fitMixed, so they come back apart.
export function extractParts(content, cap = TOOL_EXCERPT_CHARS) {
  if (typeof content === 'string') return { text: content.trim(), results: [] };
  if (!Array.isArray(content)) return { text: '', results: [] };
  const parts = [];
  const results = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text.trim());
    else if (b.type === 'tool_use') parts.push(`[tool: ${b.name || 'unknown'}]`);
    else if (b.type === 'tool_result') {
      const line = toolLine(resultText(b), cap);
      if (line) results.push(b.is_error ? line.replace(/^(\s*⤷ result: )/, '$1(error) ') : line);
    }
    // 'thinking' and everything else is dropped
  }
  return { text: parts.filter(Boolean).join('\n').trim(), results };
}

// Kept for callers that only want the conversation half.
export const extractText = (content) => extractParts(content).text;

export function buildFromFile(file, maxChars = MAX_DIGEST_CHARS, { toolShare = TOOL_SHARE, toolChars = TOOL_EXCERPT_CHARS } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return NO_DIGEST; }
  const items = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.isSidechain) continue; // subagent chatter is not the room
    const { text, results } = extractParts(e.message?.content, toolChars);
    if (text) items.push({ text: `${e.type === 'user' ? 'USER' : 'CLAUDE'}: ${text}`, tool: false });
    for (const r of results) items.push({ text: r, tool: true });
  }
  return fitMixed(items, maxChars, toolShare);
}

export async function build({ projectDir, maxChars = MAX_DIGEST_CHARS, toolShare = TOOL_SHARE, toolChars = TOOL_EXCERPT_CHARS }) {
  const hit = locate({ projectDir });
  if (!hit) return NO_DIGEST;
  return buildFromFile(hit.file, maxChars, { toolShare, toolChars });
}

export default { id, locate, build };
