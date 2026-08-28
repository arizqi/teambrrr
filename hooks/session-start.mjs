#!/usr/bin/env node
// SessionStart hook: puts the room in front of Claude before the first prompt.
//
// Without this, a room only exists once somebody remembers it exists. The roster
// and the pin board are cheap — a handful of lines — and they are the difference
// between "who do we have?" and just addressing @reviewer.
//
// Silent when there are no recruits: an empty room should cost an empty session
// nothing. Never throws, always exits 0.
//
// Input (per https://code.claude.com/docs/en/hooks):
//   { session_id, transcript_path, cwd, hook_event_name: "SessionStart", model? }
// Output: stdout JSON with hookSpecificOutput.hookEventName "SessionStart" and
// additionalContext — SessionStart is one of the three events whose output is
// added to the context Claude can see.
import {
  readStdin, storeFor, rosterOf, rosterLine, pinsOf, pinsBlock, pinsHash,
  writeSession, emit
} from './_shared.mjs';

async function main() {
  const raw = await readStdin();
  let hook = {};
  try { hook = JSON.parse(raw || '{}'); } catch { hook = {}; }
  const cwd = hook.cwd || process.cwd();

  const store = storeFor(cwd);
  const recruits = rosterOf(store);
  if (!recruits.length) return;                    // empty room, empty output

  const pins = pinsOf(store);
  const parts = [
    'Room active — a shared agent room is wired into this session. Address a ' +
    'recruit with @name and the room skill will route it; `roster` lists them.',
    `ROOM ROSTER (${recruits.length}):\n` +
      recruits.map(rosterLine).join('\n')
  ];
  const pinned = pinsBlock(pins);
  if (pinned) parts.push(pinned);

  // Record what the session has already been shown, so UserPromptSubmit does not
  // repeat the pin board on the very first prompt.
  writeSession(cwd, {
    ...(hook.session_id ? { session_id: hook.session_id } : {}),
    ...(hook.transcript_path ? { transcript_path: hook.transcript_path } : {}),
    pins_hash: pinsHash(pins)
  });

  emit('SessionStart', parts.join('\n\n'));
}

main().catch(() => {}).finally(() => process.exit(0));
