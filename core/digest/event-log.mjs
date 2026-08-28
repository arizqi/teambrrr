// DigestSource: the room's own channel log (<stateDir>/events.jsonl).
//
// For hosts with no transcript of their own (hermes, Slack, cron). Core appends
// to this log on every ask regardless of which source is active, so cross-host
// memory accrues either way.
//
// Line shape: {ts, host, author, role, text}
import fs from 'node:fs';
import { MAX_DIGEST_CHARS, NO_DIGEST, fitLines, mtimeOf } from './util.mjs';
import { eventsPathOf } from '../state.mjs';

export const id = 'event-log';

export function createEventLogSource(stateDir) {
  const file = eventsPathOf(stateDir);
  return {
    id,
    locate: () => (fs.existsSync(file) ? { file, mtime: mtimeOf(file), exact: true } : null),
    build: async ({ maxChars = MAX_DIGEST_CHARS } = {}) => buildFromFile(file, maxChars)
  };
}

export function buildFromFile(file, maxChars = MAX_DIGEST_CHARS) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return NO_DIGEST; }
  const lines = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const text = typeof e.text === 'string' ? e.text.trim() : '';
    if (!text) continue;
    const author = String(e.author || e.role || 'unknown').toUpperCase();
    lines.push(`${author}: ${text}`);
  }
  return fitLines(lines, maxChars);
}

export default { id, createEventLogSource, buildFromFile };
