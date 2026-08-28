// DigestSource: Codex CLI rollout files.
//
// FORMAT (verified against 97 real rollouts, codex 0.145.0-alpha.18, 2026-08):
//   path      $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
//   envelope  {timestamp, type, payload}
//   line 1    type:"session_meta" -> payload.{session_id,cwd,originator,cli_version,git}
//   turns     type:"response_item", payload.type:"message",
//             payload.role in user|assistant|developer,
//             payload.content: [{type:"input_text"|"output_text", text}]
//   tools     type:"response_item", payload.type:"function_call"|"custom_tool_call"
//             -> payload.name
//   outputs   type:"response_item", payload.type:"function_call_output" |
//             "custom_tool_call_output" -> payload.output, which is either a
//             plain string, a JSON string {"output":"…","metadata":{…}}, or an
//             array of {type,text} blocks. Excerpted since 0.3 (they used to be
//             dropped, which hid every artifact a tool produced).
//   dropped   reasoning, event_msg (duplicates response_item),
//             turn_context, world_state, token_count
// This block is the single place the assumption lives.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MAX_DIGEST_CHARS, NO_DIGEST, TOOL_SHARE, TOOL_EXCERPT_CHARS, fitMixed, toolLine, mtimeOf, walkFiles, readFirstLine } from './util.mjs';

export const id = 'codex';

export const codexHome = () =>
  process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const sessionsRoot = () => path.join(codexHome(), 'sessions');

// Codex injects these as ordinary user/developer turns; they are plumbing.
const PLUMBING = /^\s*<(environment_context|user_instructions|permissions instructions)/;

export function metaOf(file) {
  try {
    const o = JSON.parse(readFirstLine(file));
    if (o?.type === 'session_meta') return o.payload || null;
  } catch {}
  return null;
}

// Newest rollout whose session cwd is this project; otherwise newest overall
// (flagged so build() can prefix a warning).
export function locate({ projectDir }) {
  const files = walkFiles(sessionsRoot(), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))
    .map((file) => ({ file, mtime: mtimeOf(file) }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;
  for (const f of files) {
    const meta = metaOf(f.file);
    if (meta && meta.cwd === projectDir) return { ...f, exact: true, cwd: meta.cwd };
  }
  const newest = files[0];
  return { ...newest, exact: false, cwd: metaOf(newest.file)?.cwd || null };
}

function textOf(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text.trim() : ''))
    .filter(Boolean).join('\n').trim();
}

// Unwrap the three shapes codex uses for a tool output.
export function outputTextOf(out) {
  if (typeof out === 'string') {
    const t = out.trim();
    if (t.startsWith('{')) {
      try {
        const j = JSON.parse(t);
        if (j && typeof j.output === 'string') return j.output;
      } catch {}
    }
    return out;
  }
  if (Array.isArray(out)) {
    return out
      .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean).join('\n');
  }
  if (out && typeof out === 'object' && typeof out.output === 'string') return out.output;
  return '';
}

export function buildFromFile(file, maxChars = MAX_DIGEST_CHARS, { toolShare = TOOL_SHARE, toolChars = TOOL_EXCERPT_CHARS } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return NO_DIGEST; }
  const items = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'response_item') continue; // event_msg mirrors these
    const p = e.payload || {};
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      items.push({ text: `CODEX: [tool: ${p.name || 'unknown'}]`, tool: false });
      continue;
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const l = toolLine(outputTextOf(p.output), toolChars);
      if (l) items.push({ text: l, tool: true });
      continue;
    }
    if (p.type !== 'message') continue;
    if (p.role !== 'user' && p.role !== 'assistant') continue; // developer = plumbing
    const text = textOf(p.content);
    if (!text || PLUMBING.test(text)) continue;
    items.push({ text: `${p.role === 'user' ? 'USER' : 'CODEX'}: ${text}`, tool: false });
  }
  return fitMixed(items, maxChars, toolShare);
}

export async function build({ projectDir, maxChars = MAX_DIGEST_CHARS, toolShare = TOOL_SHARE, toolChars = TOOL_EXCERPT_CHARS }) {
  const hit = locate({ projectDir });
  if (!hit) return NO_DIGEST;
  const body = buildFromFile(hit.file, maxChars, { toolShare, toolChars });
  if (hit.exact) return body;
  return `(warning: no Codex session for ${projectDir}; showing newest session from ${hit.cwd || 'unknown cwd'})\n${body}`;
}

export default { id, locate, build, buildFromFile, metaOf, codexHome, outputTextOf };
