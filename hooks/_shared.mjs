// Shared plumbing for the three Claude Code hooks.
//
// The hooks are the difference between a room you have to remember to use and a
// room that is simply there: SessionStart puts the roster and the pin board in
// front of Claude before the first prompt, UserPromptSubmit keeps a one-line
// reminder alive, and Stop lets watching recruits leave a note for the next turn.
//
// Everything here is best-effort by construction. A hook that throws is a hook
// that breaks the user's prompt, so every function returns a safe empty value
// rather than propagating.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStore } from '../core/state.mjs';

export const roomDir = (cwd) => path.join(cwd, '.room');
export const sessionPath = (cwd) => path.join(roomDir(cwd), 'session.json');
export const inboxPath = (cwd) => path.join(roomDir(cwd), 'watch-inbox.md');

export const PINS_HEADER = 'PINNED ROOM CONTEXT:';
export const WATCH_HEADER = 'WATCHERS — recruits reviewing your last turn:';

export function storeFor(cwd) {
  try {
    return createStore({
      projectDir: cwd,
      stateDir: process.env.ROOM_STATE_DIR || undefined
    });
  } catch { return null; }
}

export function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
  });
}

// --- session state -----------------------------------------------------------
// <cwd>/.room/session.json is shared: the digest source reads transcript_path
// out of it, and the hooks keep their own bookkeeping alongside. Always merge,
// never clobber — losing transcript_path would silently blind every recruit.
export function readSession(cwd) {
  try { return JSON.parse(fs.readFileSync(sessionPath(cwd), 'utf8')) || {}; }
  catch { return {}; }
}

export function writeSession(cwd, patch) {
  try {
    const next = { ...readSession(cwd), ...patch };
    fs.mkdirSync(roomDir(cwd), { recursive: true });
    fs.writeFileSync(sessionPath(cwd), JSON.stringify(next));
    return next;
  } catch { return null; }
}

// --- roster / pins -----------------------------------------------------------
export function rosterOf(store) {
  try { return store ? store.listPersonas() : []; } catch { return []; }
}

export const rosterLine = (p) =>
  `- ${p.name} · ${p.model || 'unknown model'}` +
  ((p.tags || []).length ? ` · ${(p.tags || []).join(', ')}` : '') +
  (p.watch ? ' · watching' : '');

export function pinsOf(store) {
  try { return store ? store.readPins() : []; } catch { return []; }
}

export const pinLine = (p) => `- ${String(p.text).trim()}${p.by ? ` — ${p.by}` : ''}`;

export function pinsBlock(pins) {
  if (!pins.length) return null;
  return `${PINS_HEADER}\n${pins.map(pinLine).join('\n')}`;
}

// Identity of the pin board, so UserPromptSubmit can re-inject the full block
// only when it actually changed rather than on every single prompt.
export function pinsHash(pins) {
  const body = pins.map((p) => `${p.id}:${String(p.text).trim()}`).join('\n');
  return crypto.createHash('sha1').update(body).digest('hex').slice(0, 16);
}

// --- watch inbox -------------------------------------------------------------
// Stop hooks cannot reliably put text in front of Claude for the NEXT turn, so a
// watcher's comment is parked here and injected by UserPromptSubmit, which can.
// Read-and-clear: a comment is delivered exactly once.
export function appendInbox(cwd, text) {
  try {
    fs.mkdirSync(roomDir(cwd), { recursive: true });
    fs.appendFileSync(inboxPath(cwd), text.endsWith('\n') ? text : `${text}\n`);
    return true;
  } catch { return false; }
}

export function takeInbox(cwd) {
  const p = inboxPath(cwd);
  let body = '';
  try { body = fs.readFileSync(p, 'utf8'); } catch { return null; }
  try { fs.unlinkSync(p); } catch {}
  return body.trim() ? body.trim() : null;
}

// --- output ------------------------------------------------------------------
export function emit(hookEventName, additionalContext) {
  if (!additionalContext) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext }
  }));
}
