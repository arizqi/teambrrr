// DigestSource picker.
//
//   1. ROOM_HOST=claude-code|codex|event-log wins outright.
//   2. otherwise: whichever of claude-code / codex has the newest transcript
//      for this project.
//   3. otherwise: the room's own event log.
import claudeCode from './claude-code.mjs';
import codex from './codex.mjs';
import { createEventLogSource } from './event-log.mjs';
import { MAX_DIGEST_CHARS } from './util.mjs';

export function createAutoSource({ stateDir, projectDir, host = process.env.ROOM_HOST } = {}) {
  const eventLog = createEventLogSource(stateDir);
  const byId = { 'claude-code': claudeCode, codex, 'event-log': eventLog };

  function pick() {
    if (host && byId[host]) return byId[host];
    // Only transcripts that actually belong to this project count. A stranger's
    // newer session is worse than no digest at all, so it never wins here;
    // ROOM_HOST=codex still reaches that fallback (with its warning line).
    const ranked = [claudeCode, codex]
      .map((s) => ({ s, hit: safeLocate(s, projectDir) }))
      .filter((x) => x.hit && x.hit.exact)
      .sort((a, b) => b.hit.mtime - a.hit.mtime);
    return ranked.length ? ranked[0].s : eventLog;
  }

  return {
    id: 'auto',
    resolved: () => pick().id,
    locate: () => safeLocate(pick(), projectDir),
    build: async ({ projectDir: pd = projectDir, maxChars = MAX_DIGEST_CHARS } = {}) =>
      pick().build({ projectDir: pd, maxChars })
  };
}

function safeLocate(source, projectDir) {
  try { return source.locate({ projectDir }); } catch { return null; }
}

export default { createAutoSource };
