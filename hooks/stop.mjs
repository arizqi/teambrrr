#!/usr/bin/env node
// Stop hook: lets recruits marked `watch: true` review the chair's turn.
//
// A recruit you have to remember to ask is a recruit you forget to ask. A
// watcher reads each of your finished turns and either says something material
// or says nothing at all — the PASS reply exists so silence is cheap and
// explicit rather than a wall of "looks good to me".
//
// Delivery: Stop hooks cannot reliably put text in front of Claude for the NEXT
// turn — per https://code.claude.com/docs/en/hooks, only UserPromptSubmit,
// UserPromptExpansion and SessionStart have their stdout added as context, and
// the only decision control Stop is documented to have is
// `{decision: "block", reason}`, which would force Claude to keep working. That
// is the wrong shape for an advisory note. So comments are appended to
// <cwd>/.room/watch-inbox.md and the UserPromptSubmit hook injects and clears
// them on the next prompt. This hook NEVER blocks.
//
// Input (documented fields used here): { cwd, transcript_path, hook_event_name,
// last_assistant_message, stop_hook_active? }. `stop_hook_active` is true when
// Claude is already continuing because of a stop hook; older docs describe it as
// the loop guard, so it is honoured whenever present.
import fs from 'node:fs';
import { createRoom } from '../core/room.mjs';
import { extractParts } from '../core/digest/claude-code.mjs';
import { readStdin, storeFor, readSession, appendInbox } from './_shared.mjs';

export const WATCH_PROMPT =
  'You are watching the room. Here is the chair\'s latest turn. If you have a ' +
  'material concern or improvement, state it in ≤80 words; if not, reply exactly PASS.';

// A watcher that has nothing to say should cost the next turn nothing, so the
// PASS check is forgiving about the shapes models actually emit.
export const isPass = (reply) =>
  /^["'`*_\s]*pass[.!\s"'`*_]*$/i.test(String(reply || ''));

// The chair's last turn. `last_assistant_message` is authoritative when present
// (the transcript file can lag behind the turn that just ended); otherwise fall
// back to the transcript, parsed with the same extractor the digest uses.
export function lastAssistantTurn(hook, cwd) {
  const direct = hook?.last_assistant_message;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  const file = hook?.transcript_path || readSession(cwd).transcript_path;
  if (!file) return null;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of raw.split('\n').reverse()) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'assistant' || e.isSidechain) continue;
    const { text } = extractParts(e.message?.content);
    if (text) return text.trim();
  }
  return null;
}

const entry = (b) =>
  `[${b.name} · ${b.model} · ${typeof b.cost === 'number' ? `$${b.cost.toFixed(4)}` : '$n/a'}]\n${String(b.reply).trim()}`;

// `makeRoom` is injectable so the tests can drive the flow without a provider.
export async function runStop({ raw, cwd: cwdIn, makeRoom } = {}) {
  let hook = {};
  try { hook = JSON.parse(raw || '{}'); } catch { return { ok: false, reason: 'bad-json' }; }

  // Loop guard first, before anything that could cost money.
  if (hook.stop_hook_active === true) return { ok: true, reason: 'stop_hook_active' };

  const cwd = cwdIn || hook.cwd || process.cwd();
  const store = storeFor(cwd);
  const watchers = (() => {
    try { return store.listPersonas().filter((p) => p.watch === true).map((p) => p.name); }
    catch { return []; }
  })();
  if (!watchers.length) return { ok: true, reason: 'no-watchers' };

  const turn = lastAssistantTurn(hook, cwd);
  if (!turn) return { ok: true, reason: 'no-turn' };

  const room = (makeRoom || defaultRoom)({ cwd });
  // Watchers are real provider calls. The room refuses over the cap anyway, but
  // checking first means the cap does not turn into a stack of error blocks.
  if (typeof room.overBudget === 'function' && room.overBudget()) {
    return { ok: true, reason: 'over-budget', watchers };
  }

  const res = await room.ask({
    names: watchers,
    message: `${WATCH_PROMPT}\n\n--- the chair's latest turn ---\n${turn}`
  });
  if (!res || res.ok === false) return { ok: true, reason: 'ask-failed', watchers };

  const comments = (res.blocks || []).filter((b) => !b.error && !isPass(b.reply));
  if (!comments.length) return { ok: true, reason: 'all-pass', watchers };

  appendInbox(cwd, `## watchers · ${new Date().toISOString()}\n${comments.map(entry).join('\n\n')}\n`);
  return { ok: true, reason: 'commented', watchers, comments: comments.map((c) => c.name) };
}

const defaultRoom = ({ cwd }) => createRoom({
  projectDir: cwd,
  stateDir: process.env.ROOM_STATE_DIR || undefined,
  host: 'claude-code'
});

// CLI entry only when run directly, so the tests can import the pieces above.
if (process.argv[1] && process.argv[1].endsWith('stop.mjs')) {
  readStdin()
    .then((raw) => runStop({ raw }))
    .catch(() => {})
    .finally(() => process.exit(0));
}
