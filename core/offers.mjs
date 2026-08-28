// Offers: turn a ranked audition into 2-3 hireable cards the user can pick from.
//
// An audition answers "which of these models is honest and fast". It does not
// answer the question the user actually asked — "what will this cost me if I
// hire them". That gap is what this file closes: each surviving candidate
// becomes an offer card carrying a proposed handle, the model, a fallback
// suggestion, the trap verdict, latency, and a **monthly cost projection** from
// a volume profile.
//
// Three deliberate rules:
//
//   1. Free models are shown as $0.00/mo with the rate-limit caveat attached,
//      never as "free" full stop — a free model that 429s at noon is not free,
//      it is unavailable, which is why every offer also carries a fallback.
//   2. If the field contains any paid model, one paid option is always shown
//      even when the cheap ones outrank it. The user asked for the cheapest;
//      they still deserve to see what the money would have bought.
//   3. Nobody is hired here either. makeOffers returns cards; the chair asks
//      the user to pick one, and only then calls recruit().
import { NAME_RE } from './state.mjs';

export const DAYS_PER_MONTH = 30;
export const MAX_OFFERS = 3;
export const MIN_OFFERS = 2;
export const FREE_NOTE = 'free tier — rate limits apply';

// How much dearer the top card must be before "premium" means anything. $0.38
// against $0.36 is not a trade-off, it is noise, and badging it as one trains
// the user to ignore the badge.
export const PREMIUM_RATIO = 2;

// Built-in volume profiles. Numbers are per weekday-ish day, times 30 days.
//   advisor — a colleague you consult: a few dozen exchanges, long context in,
//             short answers out. This is the default because it is what the
//             room is for.
//   worker  — something running tasks for you all day.
//   heavy   — a pipeline: a model in a loop.
export const VOLUME_PROFILES = {
  advisor: { per_day: 30, tokens_in: 2000, tokens_out: 500 },
  worker: { per_day: 300, tokens_in: 3000, tokens_out: 1000 },
  heavy: { per_day: 1500, tokens_in: 4000, tokens_out: 1000 }
};
export const DEFAULT_VOLUME = 'advisor';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'who',
  'that', 'which', 'my', 'our', 'me', 'us', 'someone', 'somebody', 'person',
  'find', 'hire', 'recruit', 'get', 'need', 'want', 'best', 'good', 'great',
  'cheap', 'cheapest', 'lowest', 'cost', 'budget', 'model', 'agent', 'is', 'as'
]);

// --- volume ------------------------------------------------------------------

// Accepts a profile name, a partial override object, or nothing. Unknown names
// fall back to the default rather than throwing: a bad guess at the volume
// should not lose the user their audition.
export function resolveVolume(volume) {
  if (volume && typeof volume === 'object') {
    const base = VOLUME_PROFILES[DEFAULT_VOLUME];
    const num = (v, d) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : d;
    };
    return {
      profile: 'custom',
      per_day: num(volume.per_day, base.per_day),
      tokens_in: num(volume.tokens_in, base.tokens_in),
      tokens_out: num(volume.tokens_out, base.tokens_out)
    };
  }
  const key = typeof volume === 'string' && VOLUME_PROFILES[volume] ? volume : DEFAULT_VOLUME;
  return { profile: key, ...VOLUME_PROFILES[key] };
}

// price is OpenRouter's shape: USD *per token*, not per million.
export function projectCost(price, vol) {
  const inMonth = vol.per_day * DAYS_PER_MONTH * vol.tokens_in;
  const outMonth = vol.per_day * DAYS_PER_MONTH * vol.tokens_out;
  const base = {
    profile: vol.profile,
    per_day: vol.per_day,
    tokens_in: vol.tokens_in,
    tokens_out: vol.tokens_out,
    tokens_in_month: inMonth,
    tokens_out_month: outMonth
  };
  if (!price || !Number.isFinite(Number(price.prompt)) || !Number.isFinite(Number(price.completion))) {
    return { ...base, known: false, free: false, monthly_usd: null, daily_usd: null, per_call_usd: null };
  }
  const p = Number(price.prompt);
  const c = Number(price.completion);
  const monthly = inMonth * p + outMonth * c;
  const perCall = vol.tokens_in * p + vol.tokens_out * c;
  return {
    ...base,
    known: true,
    free: p === 0 && c === 0,
    prompt_per_m: p * 1e6,
    completion_per_m: c * 1e6,
    monthly_usd: round6(monthly),
    daily_usd: round6(monthly / DAYS_PER_MONTH),
    per_call_usd: round6(perCall)
  };
}

const round6 = (n) => Number(n.toFixed(6));

// --- handle ------------------------------------------------------------------

// "an SDR for outbound" -> "sdr"; "staff platform engineer" -> "staff-platform".
// Always returns something NAME_RE accepts so the chair can pass it straight to
// recruit() without a second round-trip.
export function handleFromRole(role, fallback = 'recruit') {
  const tokens = String(role || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const meaty = tokens.filter((t) => !STOPWORDS.has(t));
  const pick = meaty.length ? meaty : tokens;
  let handle = pick.length === 1 ? pick[0] : pick.slice(0, 2).join('-');
  handle = (handle || '').slice(0, 24).replace(/-+$/, '');
  if (!NAME_RE.test(handle)) {
    handle = (pick[0] || '').slice(0, 24).replace(/-+$/, '');
  }
  return NAME_RE.test(handle) ? handle : fallback;
}

// --- offers ------------------------------------------------------------------

const tierOf = (cost) => (!cost.known ? 'unknown' : cost.free ? 'free' : 'paid');

// Which candidates become cards. Rows arrive already ranked, so the default is
// simply the top three — except that the field's dearest model is always kept,
// even when it was outranked, because dropping it is what hides the trade-off.
//
// The subtle failure this avoids: an audition ranks on honesty and latency, so a
// $12/mo frontier model routinely places fourth behind three cheap ones. Take
// the naive top three and the user never learns the expensive option existed,
// while the dearest of the three cheap ones gets badged "premium" at $0.38 —
// a contrast between $0.38 and $0.36, which is no contrast at all.
export function selectOffers(rows, { max = MAX_OFFERS, volume } = {}) {
  const vol = resolveVolume(volume);
  const live = rows.filter((r) => !r.error);
  const picked = live.slice(0, max);

  const paidMonthly = (r) => {
    const c = projectCost(r.price, vol);
    return c.known && !c.free && c.monthly_usd > 0 ? c.monthly_usd : null;
  };
  const paid = live.map((r) => [r, paidMonthly(r)]).filter(([, m]) => m !== null);
  if (!paid.length) return picked;

  const dearest = paid.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  if (picked.includes(dearest)) return picked;
  if (picked.length < max) return [...picked, dearest];
  // Keep at least MIN_OFFERS of the ranked field; the weakest makes way.
  return [...picked.slice(0, Math.max(MIN_OFFERS, max - 1)), dearest];
}

// The next-ranked model is the natural fallback: it survived the same probe and
// is the closest thing to a like-for-like substitute when the primary rate
// limits. An explicit fallback_model on the candidate always wins.
function suggestFallback(row, rows) {
  if (row.fallback_model) return row.fallback_model;
  const live = rows.filter((r) => !r.error && r.model !== row.model);
  if (!live.length) return null;
  const after = live.find((r) => (r.rank || 0) > (row.rank || 0));
  return (after || live[0]).model;
}

export function makeOffers({ auditionRows, rows, role, volume, handle, max = MAX_OFFERS } = {}) {
  const all = auditionRows || rows || [];
  const vol = resolveVolume(volume);
  const baseHandle = handle && NAME_RE.test(handle) ? handle : handleFromRole(role);

  const chosen = selectOffers(all, { max, volume: vol });
  if (!chosen.length) {
    return {
      ok: false,
      offers: [],
      volume: vol,
      role: role || null,
      text: 'No offers: every candidate errored in the audition. Nothing was hired.'
    };
  }

  let offers = chosen.map((r, i) => {
    const cost = projectCost(r.price, vol);
    return {
      n: i + 1,
      handle: baseHandle,
      model: r.model,
      fallback_model: suggestFallback(r, all),
      trap_verdict: r.verdict || r.trap_verdict || (r.trap_honest ? 'honest' : 'evasive'),
      eligible: typeof r.eligible === 'boolean' ? r.eligible : null,
      latency_ms: r.latency_ms ?? null,
      score: typeof r.score === 'number' ? r.score : null,
      audition_rank: r.rank ?? null,
      tier: tierOf(cost),
      free: cost.free,
      price: r.price || null,
      cost,
      premium: false,
      recommended: false
    };
  });

  // Premium = the dearest card, badged only when it is a real step up: at least
  // twice the cheapest card, or paid where the cheapest is free. One card, or
  // three cards within pennies of each other, is not a trade-off.
  const priced = offers.filter((o) => o.cost.known);
  if (priced.length > 1) {
    const values = priced.map((o) => o.cost.monthly_usd);
    const hi = Math.max(...values);
    const lo = Math.min(...values);
    if (hi > 0 && (lo === 0 || hi / lo >= PREMIUM_RATIO)) {
      priced.find((o) => o.cost.monthly_usd === hi).premium = true;
    }
  }

  // Recommended = the best-ranked card that told the truth about the missing
  // file. Honesty is the thing the audition actually measured; if nobody was
  // honest, fall back to rank and say nothing more.
  const rec = offers.find((o) => o.eligible === true) ||
    offers.find((o) => o.trap_verdict === 'honest') || offers[0];
  rec.recommended = true;

  offers = offers.map((o) => ({ ...o }));
  return {
    ok: true,
    offers,
    volume: vol,
    role: role || null,
    handle: baseHandle,
    recommended: rec.model,
    text: formatOffers({ offers, volume: vol, role, handle: baseHandle })
  };
}

// --- rendering ---------------------------------------------------------------

export const fmtLatency = (ms) =>
  typeof ms === 'number' && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : 'n/a';

export function fmtMonthly(cost) {
  if (!cost.known) return '$n/a/mo (price unknown)';
  if (cost.free) return `$0.00/mo (${FREE_NOTE})`;
  const v = cost.monthly_usd;
  const n = v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2);
  return `$${n}/mo est`;
}

const fmtTokens = (n) => (n >= 1000 ? `${n / 1000}k` : String(n));

export function offerLine(o) {
  const parts = [
    `#${o.n} ${o.handle}`,
    o.model,
    o.trap_verdict,
    fmtMonthly(o.cost),
    fmtLatency(o.latency_ms)
  ];
  if (o.premium) parts.push('premium');
  if (o.recommended) parts.push('recommended');
  return parts.join(' · ');
}

export function formatOffers({ offers, volume, role, handle }) {
  const vol = volume;
  const head =
    `Offers for "${role || handle}" — volume ${vol.profile} ` +
    `(${vol.per_day}/day · ${fmtTokens(vol.tokens_in)} in / ${fmtTokens(vol.tokens_out)} out per exchange)`;
  const lines = offers.map(offerLine);
  const fallbacks = offers
    .map((o) => `#${o.n} → ${o.fallback_model || 'none'}`)
    .join(' · ');
  return [
    head,
    '',
    ...lines,
    '',
    `fallbacks — ${fallbacks}`,
    'Nobody is hired yet. Pick a number and I will recruit them on that model.'
  ].join('\n');
}

export default { makeOffers, selectOffers, projectCost, resolveVolume, handleFromRole, VOLUME_PROFILES };
