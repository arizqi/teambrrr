// The Autonomy Ladder: how far a teammate may act on their own.
//
// A hire is two decisions, not one. "Which model" is the one everybody asks
// about; "how much rope" is the one that decides whether the hire is safe, and
// it was previously implicit — every recruit was advisory because the room has
// no tools, right up until somebody exported them to a runtime that does.
//
// So it is written down at hire time, carried in persona.json, shown on every
// offer card and roster line, and exported into the hermes SOUL.md, where it
// stops being advice and starts being the runtime's instruction.
//
// Four rungs, deliberately few. The distinction that matters is not "how
// powerful" but "what happens when they are wrong":
//
//   L0  they cannot be wrong expensively, because they only ever propose
//   L1  a mistake is undone by the next command
//   L2  a mistake is undone by a rollback somebody has to perform
//   L3  a mistake would not be undoable, so a human sees it first
export const AUTONOMY_LEVELS = ['L0', 'L1', 'L2', 'L3'];
export const DEFAULT_AUTONOMY = 'L0';

export const AUTONOMY = {
  L0: {
    level: 'L0',
    label: 'advise-only',
    short: 'proposes, never acts',
    rule: 'You never take actions. You produce recommendations, drafts and analysis; ' +
      'a human or another agent decides whether to act on them.'
  },
  L1: {
    level: 'L1',
    label: 'reversible acts',
    short: 'may act where the act is trivially reversible',
    rule: 'You may take actions whose effect is trivially reversible (reading, drafting, ' +
      'writing to a scratch area, opening a branch). Anything that leaves that boundary ' +
      'is proposed, not done.'
  },
  L2: {
    level: 'L2',
    label: 'impactful, rollbackable',
    short: 'may act where a rollback exists — and names it first',
    rule: 'You may take impactful actions provided a rollback exists and you state it ' +
      'before acting ("this can be undone by ..."). If you cannot name the rollback, ' +
      'you do not have one, and the action is escalated instead.'
  },
  L3: {
    level: 'L3',
    label: 'needs human confirmation',
    short: 'acts only after an explicit human yes',
    rule: 'You take no action until a human has explicitly confirmed that specific action. ' +
      'Ask with the action stated plainly and the consequence named; silence is not consent.'
  }
};

export const isAutonomy = (v) => typeof v === 'string' && AUTONOMY_LEVELS.includes(v.toUpperCase());

// Accepts "l2", "L2", " L2 ". Anything else is not silently downgraded — the
// caller decides whether to refuse or to fall back to the default.
export function normalizeAutonomy(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toUpperCase();
  return AUTONOMY_LEVELS.includes(s) ? s : undefined;   // undefined = invalid
}

export const autonomyOf = (persona) => normalizeAutonomy(persona?.autonomy) || DEFAULT_AUTONOMY;

export const describeAutonomy = (level) => {
  const a = AUTONOMY[normalizeAutonomy(level) || DEFAULT_AUTONOMY] || AUTONOMY[DEFAULT_AUTONOMY];
  return `${a.level} ${a.label} — ${a.short}`;
};

export const autonomyRule = (level) =>
  (AUTONOMY[normalizeAutonomy(level) || DEFAULT_AUTONOMY] || AUTONOMY[DEFAULT_AUTONOMY]).rule;

export const AUTONOMY_MENU = AUTONOMY_LEVELS
  .map((l) => `${l} ${AUTONOMY[l].label}`)
  .join(' | ');

export default { AUTONOMY, AUTONOMY_LEVELS, DEFAULT_AUTONOMY, autonomyOf, describeAutonomy, autonomyRule };
