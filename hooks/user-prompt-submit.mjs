#!/usr/bin/env node
// UserPromptSubmit hook. Three jobs, in order of how much they matter:
//
//  1. Record where this session's transcript lives, so the room can build the
//     channel digest. This is the one job that must never fail.
//  2. Route @mentions: when the user addresses a recruit, tell Claude to call
//     the TeamBrrr `ask` tool instead of answering for them.
//  3. Keep the room present: a one-line room-state reminder while recruits
//     exist, the pin board when it has changed since it was last injected, and
//     any watcher comments the Stop hook parked in the inbox.
//
// Must never break the prompt: everything is wrapped, always exit 0.
import fs from 'node:fs';
import path from 'node:path';
import {
  readStdin, storeFor, rosterOf, pinsOf, pinsBlock, pinsHash,
  readSession, writeSession, takeInbox, WATCH_HEADER
} from './_shared.mjs';

// Claude Code has spelled this field `prompt` for a long time; newer builds have
// also been seen using `user_prompt`. Accept whichever arrives.
const promptOf = (hook) => {
  for (const k of ['prompt', 'user_prompt', 'user_prompt_raw', 'user_input']) {
    if (typeof hook[k] === 'string' && hook[k]) return hook[k];
  }
  return '';
};

// The routing instruction, unchanged since the first version of this hook.
const routingText = (mentioned) => {
  const list = mentioned.join(', ');
  const arr = `[${mentioned.map((n) => `"${n}"`).join(', ')}]`;
  return `The user addressed recruit(s) ${list}. You MUST call the TeamBrrr ` +
    `\`ask\` tool with names ${arr} and the user's message verbatim (strip the @mentions). ` +
    `If each person is asked something different, pass \`per\` as {name: message}. ` +
    `Then re-post each recruit's reply VERBATIM in your response, preserving its ` +
    `\`[name · model · $]\` header line, and do NOT add your own synthesis or answer ` +
    `unless the user also asked you directly.`;
};

async function main() {
  const raw = await readStdin();
  let hook = {};
  try { hook = JSON.parse(raw || '{}'); } catch { return; }
  const cwd = hook.cwd || process.cwd();

  // --- 1. session pointer ----------------------------------------------------
  // The legacy path keeps an older checkout of the server (or a stale MCP
  // process) resolving the transcript; the new one carries hook bookkeeping too,
  // so it is merged rather than overwritten.
  const pointer = {
    session_id: hook.session_id || null,
    transcript_path: hook.transcript_path || null
  };
  writeSession(cwd, pointer);
  try {
    const legacy = path.join(cwd, '.claude', 'recruits', '.session');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify(pointer));
  } catch {}

  const prompt = promptOf(hook);
  if (!prompt) return;

  // Roster is global (~/.room) with an optional per-project overlay.
  const store = storeFor(cwd);
  const recruits = rosterOf(store);
  const names = recruits.map((p) => p.name);
  if (!names.length) return;                 // no room, nothing to say

  const parts = [];

  // --- 2. @mention routing ---------------------------------------------------
  const mentioned = [];
  for (const m of prompt.matchAll(/@([a-z0-9_-]{2,24})/g)) {
    if (names.includes(m[1]) && !mentioned.includes(m[1])) mentioned.push(m[1]);
  }
  if (mentioned.length) parts.push(routingText(mentioned));

  // --- 3. standing room state ------------------------------------------------
  const pins = pinsOf(store);
  parts.push(`[room] recruits: ${names.join(', ')} · pins: ${pins.length}`);

  // The pin board is only worth its tokens when it has moved. SessionStart shows
  // it once; after that only a pin or an unpin brings it back.
  const session = readSession(cwd);
  const hash = pinsHash(pins);
  if (hash !== session.pins_hash) {
    const block = pinsBlock(pins);
    if (block) parts.push(block);
    writeSession(cwd, { pins_hash: hash });
  }

  // Watcher comments parked by the Stop hook, delivered exactly once.
  const inbox = takeInbox(cwd);
  if (inbox) parts.push(`${WATCH_HEADER}\n${inbox}`);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n') }
  }));
}

main().catch(() => {}).finally(() => process.exit(0));
