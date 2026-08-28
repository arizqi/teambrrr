// Where the room lives on disk.
//
// Global (default ~/.room):
//   recruits/<name>/{persona.json,history.jsonl}
//   recruits/<name>/revisions/<n>.json   ← superseded personas, append-only
//   recruits/<name>/briefing.md          ← current onboarding brief
//   recruits/<name>/briefings/<n>.md     ← superseded briefs, append-only
//   .dismissed/<name>-<ts>/
//   pins.json                            ← standing room context
//   spend.json
//   models-cache.json
//   events.jsonl
//
// Project overlay (<projectDir>/.room, optional): same layout. A recruit
// defined there shadows a global recruit of the same name; pins there STACK on
// the global pins rather than shadowing them.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_STATE_DIR = path.join(os.homedir(), '.room');
export const NAME_RE = /^[a-z0-9_-]{2,24}$/;

export const rd = (p, dflt) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
};
export const wr = (p, o) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(o, null, 2));
};

export const recruitsDirOf = (root) => path.join(root, 'recruits');
export const personaPathIn = (root, n) => path.join(root, 'recruits', n, 'persona.json');
export const revisionsDirIn = (root, n) => path.join(root, 'recruits', n, 'revisions');
export const revisionPathIn = (root, n, rev) => path.join(root, 'recruits', n, 'revisions', `${rev}.json`);

// Personas written before revisions existed have neither field. They are
// revision 1 by definition, and their last-known change is their creation.
export const revisionOf = (persona) => {
  const r = Number(persona?.revision);
  return Number.isInteger(r) && r >= 1 ? r : 1;
};
export const updatedAtOf = (persona) => persona?.updated_at || persona?.created_at || null;

// The bookkeeping added on every write. Kept here so room.mjs cannot drift.
export const stripInternal = (persona) => {
  const { __root, __scope, ...rest } = persona || {};
  return rest;
};
export const historyPathIn = (root, n) => path.join(root, 'recruits', n, 'history.jsonl');
export const briefingPathIn = (root, n) => path.join(root, 'recruits', n, 'briefing.md');
export const briefingsDirIn = (root, n) => path.join(root, 'recruits', n, 'briefings');
export const briefingRevPathIn = (root, n, rev) => path.join(root, 'recruits', n, 'briefings', `${rev}.md`);
export const compactionPathIn = (root, n) => path.join(root, 'recruits', n, 'compaction.json');
export const pinsPathOf = (root) => path.join(root, 'pins.json');
export const spendPathOf = (root) => path.join(root, 'spend.json');
// Attribution: one line per settled provider call, {ts, who, why, cost}. The
// totals in spend.json say how much is left; this says where it went.
export const spendLogPathOf = (root) => path.join(root, 'spend-log.jsonl');
export const modelsCachePathOf = (root) => path.join(root, 'models-cache.json');
export const eventsPathOf = (root) => path.join(root, 'events.jsonl');

function namesIn(root) {
  try {
    return fs.readdirSync(recruitsDirOf(root), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch { return []; }
}

// Resolve the two roots: global state dir, plus the project overlay when the
// project actually has a .room directory.
export function createStore({ stateDir = DEFAULT_STATE_DIR, projectDir = process.cwd() } = {}) {
  const overlay = path.join(projectDir, '.room');
  const hasOverlay = () => {
    try { return fs.statSync(overlay).isDirectory(); } catch { return false; }
  };

  // Roots in shadowing order: overlay first, then global.
  const roots = () => (hasOverlay() && overlay !== stateDir ? [overlay, stateDir] : [stateDir]);

  // Which root owns this recruit? null when nobody does.
  function rootFor(name) {
    for (const r of roots()) if (fs.existsSync(personaPathIn(r, name))) return r;
    return null;
  }

  function readPersona(name) {
    const root = rootFor(name);
    if (!root) return null;
    const p = rd(personaPathIn(root, name), null);
    return p ? { ...p, __root: root, __scope: root === stateDir ? 'global' : 'project' } : null;
  }

  function writePersona(name, persona) {
    // Existing recruits stay where they are; new ones land in the global dir.
    const root = rootFor(name) || stateDir;
    wr(personaPathIn(root, name), stripInternal(persona));
    return root;
  }

  // --- revisions -------------------------------------------------------------
  // Append-only. A rollback is a new revision that happens to carry old content,
  // never an edit to the chain: what the recruit was told, and when, stays
  // auditable even after somebody changes their mind twice.

  function listRevisions(name) {
    const root = rootFor(name);
    if (!root) return [];
    try {
      return fs.readdirSync(revisionsDirIn(root, name))
        .map((f) => /^(\d+)\.json$/.exec(f)?.[1])
        .filter(Boolean)
        .map(Number)
        .sort((a, b) => a - b);
    } catch { return []; }
  }

  function readRevision(name, rev) {
    const root = rootFor(name);
    if (!root) return null;
    return rd(revisionPathIn(root, name, Number(rev)), null);
  }

  // Freeze the persona as it stands, under its own revision number, so the next
  // write can move forward without losing it. Idempotent: re-snapshotting the
  // same revision overwrites an identical file.
  function snapshotPersona(name) {
    const current = readPersona(name);
    if (!current) return null;
    const root = current.__root;
    const rev = revisionOf(current);
    wr(revisionPathIn(root, name, rev), stripInternal(current));
    return rev;
  }

  function listPersonas() {
    const seen = new Map();
    for (const root of roots()) {
      for (const n of namesIn(root)) {
        if (seen.has(n)) continue; // first root wins => overlay shadows global
        const p = rd(personaPathIn(root, n), null);
        if (p) seen.set(n, { ...p, __root: root, __scope: root === stateDir ? 'global' : 'project' });
      }
    }
    return [...seen.values()];
  }

  function readHistory(name, n = 10) {
    const root = rootFor(name);
    if (!root) return [];
    try {
      const lines = fs.readFileSync(historyPathIn(root, name), 'utf8').split('\n').filter(Boolean);
      return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  function appendHistory(name, entry) {
    const root = rootFor(name) || stateDir;
    const p = historyPathIn(root, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + '\n');
  }

  // --- onboarding briefings ---------------------------------------------------
  // The brief is what the hiring agent knew and the recruit did not: project,
  // goal, decisions already taken, the glossary of local codenames. It rides on
  // every call, so it is versioned exactly like the persona — superseded copies
  // land in briefings/<n>.md and are never rewritten.

  function readBriefing(name) {
    const root = rootFor(name);
    if (!root) return null;
    try {
      const t = fs.readFileSync(briefingPathIn(root, name), 'utf8');
      return t.trim() ? t : null;
    } catch { return null; }
  }

  function writeBriefing(name, text) {
    const root = rootFor(name) || stateDir;
    const p = briefingPathIn(root, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(text));
    return root;
  }

  function listBriefings(name) {
    const root = rootFor(name);
    if (!root) return [];
    try {
      return fs.readdirSync(briefingsDirIn(root, name))
        .map((f) => /^(\d+)\.md$/.exec(f)?.[1])
        .filter(Boolean).map(Number).sort((a, b) => a - b);
    } catch { return []; }
  }

  function readBriefingRevision(name, rev) {
    const root = rootFor(name);
    if (!root) return null;
    try { return fs.readFileSync(briefingRevPathIn(root, name, Number(rev)), 'utf8'); }
    catch { return null; }
  }

  // Freeze the current brief under the next free number. Returns that number,
  // or null when there is no brief to freeze.
  function snapshotBriefing(name) {
    const current = readBriefing(name);
    if (current === null) return null;
    const root = rootFor(name) || stateDir;
    const rev = listBriefings(name).length + 1;
    const p = briefingRevPathIn(root, name, rev);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, current);
    return rev;
  }

  // The revision number the CURRENT brief carries: snapshots are 1..k, so the
  // live one is k+1. With no brief at all this is the number the first one gets.
  const briefingRevision = (name) => listBriefings(name).length + 1;

  // --- pins -------------------------------------------------------------------
  // Standing context that outlives any one turn. Global pins live in the state
  // dir; a project may add its own, and the two STACK (unlike recruits, where
  // the overlay shadows). Order is global first, project second — the narrower
  // scope gets the last word.

  const pinRoots = () => (hasOverlay() && overlay !== stateDir ? [stateDir, overlay] : [stateDir]);

  function readPinsIn(root) {
    const j = rd(pinsPathOf(root), null);
    const list = Array.isArray(j) ? j : Array.isArray(j?.pins) ? j.pins : [];
    return list.filter((p) => p && typeof p.text === 'string' && p.text.trim());
  }

  function readPins() {
    const out = [];
    for (const root of pinRoots()) {
      const scope = root === stateDir ? 'global' : 'project';
      for (const p of readPinsIn(root)) out.push({ ...p, __scope: scope, __root: root });
    }
    return out;
  }

  function writePinsIn(root, list) {
    wr(pinsPathOf(root), { pins: list.map(({ __scope, __root, ...rest }) => rest) });
    return root;
  }

  const pinRootFor = (scope) =>
    (scope === 'project' && overlay !== stateDir ? overlay : stateDir);

  // Spend is a single global budget, always on the global state dir.
  const readSpend = () => rd(spendPathOf(stateDir), { total: 0, byRecruit: {} });
  function addSpend(name, amount) {
    const s = readSpend();
    s.total = Number(((s.total || 0) + (amount || 0)).toFixed(6));
    const r = s.byRecruit[name] || { calls: 0, spend: 0 };
    r.calls += 1;
    r.spend = Number((r.spend + (amount || 0)).toFixed(6));
    s.byRecruit[name] = r;
    wr(spendPathOf(stateDir), s);
    return s;
  }

  function appendSpendEntry(entry) {
    const p = spendLogPathOf(stateDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + '\n');
    return p;
  }

  function readSpendLog(n = 0) {
    try {
      const lines = fs.readFileSync(spendLogPathOf(stateDir), 'utf8').split('\n').filter(Boolean);
      const wanted = n > 0 ? lines.slice(-n) : lines;
      return wanted.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  // --- brief compaction pointer ----------------------------------------------
  // How much of the channel a recruit's brief has already absorbed. Stored as an
  // event-count watermark rather than a timestamp: events.jsonl is append-only,
  // so "how many events have happened since" is a subtraction, not a scan.
  function readCompaction(name) {
    const root = rootFor(name);
    if (!root) return null;
    return rd(compactionPathIn(root, name), null);
  }

  function writeCompaction(name, entry) {
    const root = rootFor(name) || stateDir;
    wr(compactionPathIn(root, name), entry);
    return root;
  }

  function archive(name) {
    const root = rootFor(name);
    if (!root) return null;
    const src = path.join(recruitsDirOf(root), name);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(root, '.dismissed', `${name}-${ts}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    return dest;
  }

  function appendEvent(entry) {
    const p = eventsPathOf(stateDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  }

  function allEventLines() {
    try { return fs.readFileSync(eventsPathOf(stateDir), 'utf8').split('\n').filter(Boolean); }
    catch { return []; }
  }

  const parseLines = (lines) =>
    lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  function tailEvents(n = 50) {
    return parseLines(allEventLines().slice(-n));
  }

  const eventCount = () => allEventLines().length;
  const eventsFrom = (index = 0) => parseLines(allEventLines().slice(Math.max(0, index)));

  return {
    stateDir, projectDir, overlay, hasOverlay, roots, rootFor,
    readPersona, writePersona, listPersonas,
    listRevisions, readRevision, snapshotPersona,
    readBriefing, writeBriefing, listBriefings, readBriefingRevision,
    snapshotBriefing, briefingRevision,
    pinRoots, pinRootFor, readPins, readPinsIn, writePinsIn,
    readHistory, appendHistory,
    readSpend, addSpend, archive,
    appendSpendEntry, readSpendLog, spendLogPath: () => spendLogPathOf(stateDir),
    readCompaction, writeCompaction,
    appendEvent, tailEvents, eventCount, eventsFrom,
    modelsCachePath: () => modelsCachePathOf(stateDir),
    ensure: () => fs.mkdirSync(recruitsDirOf(stateDir), { recursive: true })
  };
}

// --- migration: <projectDir>/.claude/recruits -> <stateDir> ------------------
function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, d.name);
    const t = path.join(dest, d.name);
    if (d.isDirectory()) copyTree(s, t);
    else fs.copyFileSync(s, t);
  }
}

// Idempotent: guarded by a .migrated marker left in the legacy directory.
// Files are copied, never moved, so the old spike keeps working untouched.
export function migrateLegacy({ projectDir, stateDir = DEFAULT_STATE_DIR }) {
  const legacy = path.join(projectDir, '.claude', 'recruits');
  const report = { legacy, stateDir, ran: false, recruits: [], dismissed: [], files: [], skipped: [] };
  if (!fs.existsSync(legacy)) return report;
  if (fs.existsSync(path.join(legacy, '.migrated'))) { report.skipped.push('already migrated'); return report; }

  report.ran = true;
  for (const d of fs.readdirSync(legacy, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const dest = path.join(recruitsDirOf(stateDir), d.name);
    if (fs.existsSync(dest)) { report.skipped.push(`recruit ${d.name} (exists)`); continue; }
    copyTree(path.join(legacy, d.name), dest);
    report.recruits.push(d.name);
  }

  const dismissedSrc = path.join(legacy, '.dismissed');
  if (fs.existsSync(dismissedSrc)) {
    for (const d of fs.readdirSync(dismissedSrc, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dest = path.join(stateDir, '.dismissed', d.name);
      if (fs.existsSync(dest)) continue;
      copyTree(path.join(dismissedSrc, d.name), dest);
      report.dismissed.push(d.name);
    }
  }

  for (const [from, to] of [['.spend.json', 'spend.json'], ['.models-cache.json', 'models-cache.json']]) {
    const s = path.join(legacy, from);
    const t = path.join(stateDir, to);
    if (!fs.existsSync(s) || fs.existsSync(t)) continue;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.copyFileSync(s, t);
    report.files.push(to);
  }

  try {
    fs.writeFileSync(path.join(legacy, '.migrated'),
      JSON.stringify({ at: new Date().toISOString(), to: stateDir, ...report }, null, 2));
  } catch {}
  return report;
}
