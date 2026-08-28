#!/usr/bin/env node
// offers(): an audition becomes 2-3 hireable cards with a monthly cost.
// The arithmetic is checked against hand-computed numbers, the free tier is
// never rendered as a bare "$0.00", a field of only free models still shows one
// paid option, and the table format is pinned so the chair can rely on it.
import fs from 'node:fs';
import path from 'node:path';
import { check, done, SCRATCH } from './_harness.mjs';
import { createRoom } from '../core/room.mjs';
import { createEventLogSource } from '../core/digest/event-log.mjs';
import {
  makeOffers, selectOffers, projectCost, resolveVolume, handleFromRole,
  offerLine, fmtMonthly, VOLUME_PROFILES, DAYS_PER_MONTH, FREE_NOTE, MAX_OFFERS
} from '../core/offers.mjs';

const ROOT = path.join(SCRATCH, 'offers-test');
fs.rmSync(ROOT, { recursive: true, force: true });
const mk = (...p) => { const d = path.join(ROOT, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

console.log('offers() tests\n');

// Prices are OpenRouter's shape: USD per *token*.
const perM = (inM, outM) => ({ prompt: inM / 1e6, completion: outM / 1e6 });
const CHEAP = perM(0.14, 0.28);      // advisor -> $0.378/mo
const FREE = perM(0, 0);
const PREMIUM = perM(3, 15);         // advisor -> $12.15/mo
const DUST = perM(0.001, 0.001);     // sub-cent, forces 4-decimal rendering

const row = (model, over = {}) => ({
  model, rank: over.rank ?? 1, score: 0.9, trap_verdict: 'honest', trap_honest: true,
  latency_ms: 1200, cost: 0.0001, price: CHEAP, words: 60, length_discipline: 1,
  reply: 'x', ...over
});

// ------------------------------------------------------ 1. volume profiles ---
{
  const d = resolveVolume();
  check(d.profile === 'advisor', 'advisor is the default volume profile', d.profile);
  check(d.per_day === 30 && d.tokens_in === 2000 && d.tokens_out === 500,
    'the advisor profile is 30/day x 2k in / 500 out', JSON.stringify(d));

  const w = resolveVolume('worker');
  check(w.per_day === 300 && w.tokens_in === 3000 && w.tokens_out === 1000, 'the worker profile is 300/day x 3k / 1k', JSON.stringify(w));
  const h = resolveVolume('heavy');
  check(h.per_day === 1500 && h.tokens_in === 4000 && h.tokens_out === 1000, 'the heavy profile is 1500/day x 4k / 1k', JSON.stringify(h));
  check(Object.keys(VOLUME_PROFILES).join(',') === 'advisor,worker,heavy', 'three built-in profiles, in order');

  const c = resolveVolume({ per_day: 10, tokens_in: 1000, tokens_out: 100 });
  check(c.profile === 'custom' && c.per_day === 10 && c.tokens_in === 1000 && c.tokens_out === 100,
    'an explicit object overrides the profile', JSON.stringify(c));

  const partial = resolveVolume({ per_day: 50 });
  check(partial.per_day === 50 && partial.tokens_in === 2000,
    'a partial override keeps the advisor defaults for the rest', JSON.stringify(partial));

  const bogus = resolveVolume('enterprise-mega');
  check(bogus.profile === 'advisor', 'an unknown profile name falls back rather than throwing', bogus.profile);
  const negative = resolveVolume({ per_day: -5, tokens_in: 'lots' });
  check(negative.per_day === 30 && negative.tokens_in === 2000, 'nonsense numbers fall back to the default', JSON.stringify(negative));
}

// --------------------------------------------------------- 2. cost maths -----
{
  const adv = resolveVolume('advisor');
  const c = projectCost(CHEAP, adv);
  // 30/day x 30 days x 2000 in = 1.8M in; x 500 out = 450k out
  check(c.tokens_in_month === 1_800_000 && c.tokens_out_month === 450_000,
    'monthly token volume is per_day x 30 x tokens', JSON.stringify({ i: c.tokens_in_month, o: c.tokens_out_month }));
  check(Math.abs(c.monthly_usd - 0.378) < 1e-9, '1.8M @ $0.14/M + 450k @ $0.28/M = $0.378/mo', String(c.monthly_usd));
  check(Math.abs(c.daily_usd - 0.378 / DAYS_PER_MONTH) < 1e-9, 'daily is monthly / 30', String(c.daily_usd));
  check(Math.abs(c.per_call_usd - (2000 * CHEAP.prompt + 500 * CHEAP.completion)) < 1e-12,
    'per-exchange cost is priced off one exchange, not the month', String(c.per_call_usd));
  check(c.known === true && c.free === false, 'a priced model is known and not free');
  check(Math.abs(c.prompt_per_m - 0.14) < 1e-9, 'the per-million price is carried for display', String(c.prompt_per_m));

  const worker = projectCost(CHEAP, resolveVolume('worker'));
  check(Math.abs(worker.monthly_usd - 6.3) < 1e-9, 'the same model at worker volume is $6.30/mo', String(worker.monthly_usd));
  const heavy = projectCost(CHEAP, resolveVolume('heavy'));
  check(Math.abs(heavy.monthly_usd - 37.8) < 1e-9, 'the same model at heavy volume is $37.80/mo', String(heavy.monthly_usd));
  check(heavy.monthly_usd > worker.monthly_usd && worker.monthly_usd > c.monthly_usd,
    'heavy > worker > advisor for one model', [c, worker, heavy].map((x) => x.monthly_usd).join(' < '));

  const prem = projectCost(PREMIUM, adv);
  check(Math.abs(prem.monthly_usd - 12.15) < 1e-9, 'the premium model is $12.15/mo at advisor volume', String(prem.monthly_usd));
  check(prem.monthly_usd / c.monthly_usd > 30, 'the premium/cheap gap is visible, not cosmetic',
    String(prem.monthly_usd / c.monthly_usd));

  const free = projectCost(FREE, adv);
  check(free.known === true && free.free === true && free.monthly_usd === 0, 'a zero-priced model is free, not unknown', JSON.stringify(free));

  const unknown = projectCost(null, adv);
  check(unknown.known === false && unknown.monthly_usd === null, 'a missing price is unknown, not zero', JSON.stringify(unknown));
  check(unknown.free === false, 'unknown is never reported as free');
  check(projectCost({ prompt: 'x', completion: 1 }, adv).known === false, 'a malformed price is unknown too');

  const custom = projectCost(CHEAP, resolveVolume({ per_day: 10, tokens_in: 1000, tokens_out: 100 }));
  check(Math.abs(custom.monthly_usd - 0.0504) < 1e-9, 'a custom volume projects off the given numbers', String(custom.monthly_usd));
}

// ------------------------------------------------------- 3. cost rendering ---
{
  const adv = resolveVolume('advisor');
  check(fmtMonthly(projectCost(CHEAP, adv)) === '$0.38/mo est', 'a normal price renders to two decimals', fmtMonthly(projectCost(CHEAP, adv)));
  check(fmtMonthly(projectCost(FREE, adv)) === `$0.00/mo (${FREE_NOTE})`,
    'free renders with the rate-limit caveat attached', fmtMonthly(projectCost(FREE, adv)));
  check(fmtMonthly(projectCost(null, adv)) === '$n/a/mo (price unknown)', 'an unknown price says so', fmtMonthly(projectCost(null, adv)));
  const dust = fmtMonthly(projectCost(DUST, adv));
  check(/^\$0\.\d{4}\/mo est$/.test(dust), 'a sub-cent price keeps four decimals rather than rounding to $0.00', dust);
  check(dust !== '$0.00/mo est', 'a paid model is never rendered as $0.00', dust);
}

// ------------------------------------------------------------- 4. handles ----
{
  check(handleFromRole('SDR') === 'sdr', 'a one-word role becomes the handle', handleFromRole('SDR'));
  check(handleFromRole('an SDR for outbound') === 'sdr-outbound', 'stopwords are dropped', handleFromRole('an SDR for outbound'));
  check(handleFromRole('hire me the cheapest SDR') === 'sdr', 'hiring verbs and price words are dropped', handleFromRole('hire me the cheapest SDR'));
  check(handleFromRole('Staff Platform Engineer') === 'staff-platform', 'a long role takes the first two words', handleFromRole('Staff Platform Engineer'));
  check(handleFromRole('') === 'recruit', 'an empty role gets a safe default', handleFromRole(''));
  check(handleFromRole('a') === 'recruit', 'a role too short for a handle gets the default', handleFromRole('a'));
  for (const r of ['SDR', 'an SDR for outbound', 'Staff Platform Engineer', '', 'a', 'QA!!!', 'über engineer']) {
    check(/^[a-z0-9_-]{2,24}$/.test(handleFromRole(r)), `handle from "${r}" is recruit()-safe: ${handleFromRole(r)}`);
  }
}

// ---------------------------------------------------------- 5. selection -----
{
  const mixed = [
    row('a/free', { rank: 1, price: FREE }),
    row('b/cheap', { rank: 2, price: CHEAP }),
    row('c/prem', { rank: 3, price: PREMIUM }),
    row('d/extra', { rank: 4, price: CHEAP })
  ];
  const sel = selectOffers(mixed);
  check(sel.length === MAX_OFFERS, 'at most three offers', String(sel.length));
  check(sel.map((r) => r.model).join(',') === 'a/free,b/cheap,c/prem', 'a mixed field is just the top three', sel.map((r) => r.model).join(','));

  // an all-free top three hides the trade-off, so a paid model is pulled in
  const freeTop = [
    row('a/free', { rank: 1, price: FREE }),
    row('b/free', { rank: 2, price: FREE }),
    row('c/free', { rank: 3, price: FREE }),
    row('d/prem', { rank: 4, price: PREMIUM })
  ];
  const pulled = selectOffers(freeTop);
  check(pulled.length === 3, 'the contrast swap keeps three offers', String(pulled.length));
  check(pulled.some((r) => r.model === 'd/prem'), 'a paid contrast option is pulled into an all-free field', pulled.map((r) => r.model).join(','));
  check(pulled.slice(0, 2).map((r) => r.model).join(',') === 'a/free,b/free', 'the two best free options survive the swap', pulled.map((r) => r.model).join(','));

  const allFree = selectOffers([row('a/free', { rank: 1, price: FREE }), row('b/free', { rank: 2, price: FREE })]);
  check(allFree.length === 2 && allFree.every((r) => r.price === FREE), 'with no paid model at all, nothing is invented', String(allFree.length));

  const twoWithPaid = selectOffers([row('a/free', { rank: 1, price: FREE }), row('b/prem', { rank: 2, price: PREMIUM })]);
  check(twoWithPaid.length === 2, 'a two-candidate field stays at two offers', String(twoWithPaid.length));

  const withErrors = selectOffers([
    row('dead/one', { rank: 4, error: true }),
    row('a/free', { rank: 1, price: FREE }),
    row('b/cheap', { rank: 2, price: CHEAP })
  ]);
  check(withErrors.every((r) => !r.error), 'a candidate that errored is never offered', withErrors.map((r) => r.model).join(','));

  // The real-world shape: an audition ranks on honesty and latency, so the
  // expensive model places last. Dropping it would hide the trade-off entirely.
  const outranked = [
    row('a/cheap', { rank: 1, price: CHEAP }),
    row('b/free', { rank: 2, price: FREE }),
    row('c/cheap2', { rank: 3, price: perM(0.1, 0.4) }),
    row('d/prem', { rank: 4, price: PREMIUM })
  ];
  const kept = selectOffers(outranked, { volume: 'advisor' });
  check(kept.some((r) => r.model === 'd/prem'),
    'the dearest model is offered even when it was outranked', kept.map((r) => r.model).join(','));
  check(kept.length === 3, 'and the offer set stays at three', String(kept.length));
  check(kept.map((r) => r.model).join(',') === 'a/cheap,b/free,d/prem',
    'the weakest ranked card makes way, the top two survive', kept.map((r) => r.model).join(','));
}

// ------------------------------------------------------------- 6. offers -----
{
  const rows = [
    row('deepseek/cheap', { rank: 1, price: CHEAP, latency_ms: 1200, trap_verdict: 'honest' }),
    row('meta/free', { rank: 2, price: FREE, latency_ms: 2400, trap_verdict: 'honest' }),
    row('anthropic/prem', { rank: 3, price: PREMIUM, latency_ms: 900, trap_verdict: 'honest' })
  ];
  const r = makeOffers({ auditionRows: rows, role: 'SDR' });

  check(r.ok && r.offers.length === 3, 'three rows make three offers', String(r.offers.length));
  check(r.offers.every((o) => o.handle === 'sdr'), 'every card proposes the role-derived handle', r.offers.map((o) => o.handle).join(','));
  check(r.offers.map((o) => o.n).join(',') === '1,2,3', 'cards are numbered for picking');
  check(r.offers[0].model === 'deepseek/cheap', 'offer order follows the audition rank', r.offers.map((o) => o.model).join(' > '));
  check(r.offers.every((o) => typeof o.trap_verdict === 'string'), 'every card carries the trap verdict');
  check(r.offers.every((o) => typeof o.latency_ms === 'number'), 'every card carries latency');
  check(r.offers.every((o) => o.cost && o.cost.profile === 'advisor'), 'every card carries a cost projection at the chosen volume');

  const rec = r.offers.filter((o) => o.recommended);
  check(rec.length === 1, 'exactly one card is recommended', String(rec.length));
  check(rec[0].model === 'deepseek/cheap', 'the best-ranked honest card is the recommendation', rec[0].model);
  check(r.recommended === 'deepseek/cheap', 'the recommendation is also returned at the top level', String(r.recommended));

  const prem = r.offers.filter((o) => o.premium);
  check(prem.length === 1 && prem[0].model === 'anthropic/prem', 'the dearest card is marked premium', JSON.stringify(prem.map((o) => o.model)));
  check(r.offers.find((o) => o.model === 'meta/free').free === true, 'the free card is flagged free');
  check(r.offers.find((o) => o.model === 'meta/free').tier === 'free', 'tiers are labelled free / paid');
  check(r.offers.find((o) => o.model === 'deepseek/cheap').tier === 'paid', 'a priced card is tier paid');

  // fallbacks: next-ranked model, or the explicit one when given
  check(r.offers[0].fallback_model === 'meta/free', 'the fallback suggestion is the next-ranked model', String(r.offers[0].fallback_model));
  check(r.offers[2].fallback_model === 'deepseek/cheap', 'the last card falls back to the best of the rest', String(r.offers[2].fallback_model));
  const explicit = makeOffers({
    auditionRows: [row('a/one', { rank: 1, fallback_model: 'chosen/backup' }), row('b/two', { rank: 2 })],
    role: 'SDR'
  });
  check(explicit.offers[0].fallback_model === 'chosen/backup', 'an explicit fallback_model beats the suggestion', String(explicit.offers[0].fallback_model));

  // volume flows through to the cards
  const worker = makeOffers({ auditionRows: rows, role: 'SDR', volume: 'worker' });
  check(worker.offers[0].cost.monthly_usd === 6.3, 'the volume argument changes the projection', String(worker.offers[0].cost.monthly_usd));
  check(worker.volume.profile === 'worker', 'the resolved volume comes back with the offers');

  // recommendation degrades honestly
  const noHonest = makeOffers({
    auditionRows: [
      row('a/waffle', { rank: 1, trap_verdict: 'evasive', trap_honest: false }),
      row('b/liar', { rank: 2, trap_verdict: 'fabricated', trap_honest: false })
    ],
    role: 'SDR'
  });
  check(noHonest.offers.filter((o) => o.recommended).length === 1, 'a field with no honest candidate still recommends exactly one');
  check(noHonest.offers[0].recommended === true, 'with nobody honest it falls back to rank', JSON.stringify(noHonest.offers.map((o) => o.recommended)));
  const honestSecond = makeOffers({
    auditionRows: [
      row('a/liar', { rank: 1, trap_verdict: 'fabricated', trap_honest: false }),
      row('b/honest', { rank: 2, trap_verdict: 'honest' })
    ],
    role: 'SDR'
  });
  check(honestSecond.offers.find((o) => o.recommended).model === 'b/honest',
    'honesty outranks position for the recommendation', honestSecond.offers.find((o) => o.recommended).model);

  // the badge must mean something: pennies apart is not a premium tier
  const pennies = makeOffers({
    auditionRows: [
      row('a/cheap', { rank: 1, price: CHEAP }),            // $0.378/mo
      row('b/cheap2', { rank: 2, price: perM(0.1, 0.4) })   // $0.360/mo
    ],
    role: 'SDR'
  });
  check(pennies.offers.every((o) => !o.premium),
    'two cards within pennies of each other: neither is badged premium',
    JSON.stringify(pennies.offers.map((o) => [o.model, o.cost.monthly_usd, o.premium])));

  const stepUp = makeOffers({
    auditionRows: [row('a/cheap', { rank: 1, price: CHEAP }), row('b/prem', { rank: 2, price: PREMIUM })],
    role: 'SDR'
  });
  check(stepUp.offers.find((o) => o.model === 'b/prem').premium === true,
    'a genuine step up in price is badged premium', String(stepUp.offers[1].cost.monthly_usd));

  const freeVsPaid = makeOffers({
    auditionRows: [row('a/free', { rank: 1, price: FREE }), row('b/cheap', { rank: 2, price: CHEAP })],
    role: 'SDR'
  });
  check(freeVsPaid.offers.find((o) => o.model === 'b/cheap').premium === true,
    'paid against free is always a contrast, however cheap', String(freeVsPaid.offers[1].cost.monthly_usd));

  // a single card has nothing to contrast with
  const solo = makeOffers({ auditionRows: [row('a/one', { rank: 1, price: PREMIUM })], role: 'SDR' });
  check(solo.offers.length === 1 && solo.offers[0].premium === false,
    'one card alone is not labelled premium — there is no contrast to draw', JSON.stringify(solo.offers[0].premium));
  check(solo.offers[0].recommended === true, 'a lone card is still the recommendation');

  // everybody died
  const dead = makeOffers({ auditionRows: [row('x/dead', { error: true })], role: 'SDR' });
  check(dead.ok === false && dead.offers.length === 0, 'an all-error audition yields no offers', dead.text);
  check(/Nothing was hired/.test(dead.text), 'and says plainly that nobody was hired', dead.text);
}

// ------------------------------------------------------- 7. table format -----
{
  const rows = [
    row('deepseek/cheap', { rank: 1, price: CHEAP, latency_ms: 1200 }),
    row('meta/free', { rank: 2, price: FREE, latency_ms: 2400 }),
    row('anthropic/prem', { rank: 3, price: PREMIUM, latency_ms: 900 })
  ];
  const { text, offers } = makeOffers({ auditionRows: rows, role: 'SDR' });
  const lines = text.split('\n');

  check(lines[0] === 'Offers for "SDR" — volume advisor (30/day · 2k in / 500 out per exchange)',
    'the header states the role and the volume assumption', lines[0]);
  check(offerLine(offers[0]) === '#1 sdr · deepseek/cheap · honest · $0.38/mo est · 1.2s · recommended',
    'the recommended line is exactly as specified', offerLine(offers[0]));
  check(offerLine(offers[1]) === `#2 sdr · meta/free · honest · $0.00/mo (${FREE_NOTE}) · 2.4s`,
    'the free line carries the caveat and no marks', offerLine(offers[1]));
  check(offerLine(offers[2]) === '#3 sdr · anthropic/prem · honest · $12.15/mo est · 0.9s · premium',
    'the premium line is marked premium', offerLine(offers[2]));
  check(lines.slice(2, 5).join('\n') === offers.map(offerLine).join('\n'), 'the table is the three offer lines in order');
  check(/^fallbacks — #1 → meta\/free · #2 → /.test(lines[6]), 'the fallbacks line lists one per card', lines[6]);
  check(/Nobody is hired yet/.test(text), 'the text refuses to imply a hire has happened', lines[lines.length - 1]);
  check(text.includes('Pick a number'), 'the text asks the user to choose', lines[lines.length - 1]);
  check(!/undefined|NaN|\[object/.test(text), 'nothing leaks into the rendered table', text);
}

// ------------------------------------------------- 8. end to end via room ----
{
  const stateDir = mk('state1');
  const projectDir = mk('proj1');
  const HONEST =
    'I would open with a three-line email tied to a trigger event, and the failure mode I ' +
    'would guard against is blasting a list nobody qualified.\n\n' +
    "For part 2: I don't have services/estoque.js — it was not provided, so I would be guessing.";

  const PRICES = {
    'deepseek/cheap': CHEAP,
    'meta/free': FREE,
    'anthropic/prem': PREMIUM
  };
  const seen = [];
  const provider = {
    name: 'mock',
    call: async ({ model }) => { seen.push(model); return { text: HONEST, cost: 0.0002, usage: { prompt_tokens: 400, completion_tokens: 80 } }; }
  };
  const room = createRoom({
    stateDir, projectDir, provider, host: 'test', autoMigrate: false,
    priceFor: (m) => PRICES[m] || null,
    digestSource: createEventLogSource(stateDir)
  });

  const plain = await room.audition({
    candidates: [{ model: 'deepseek/cheap' }, { model: 'meta/free' }],
    role_prompt: 'an SDR who books qualified meetings'
  });
  check(plain.ok && !plain.offers, 'without `role` the audition is unchanged — no offers', String(!!plain.offers));
  check(plain.rows.every((r) => r.price), 'audition rows now carry the price for later projection', JSON.stringify(plain.rows.map((r) => !!r.price)));

  const hired = await room.audition({
    candidates: [{ model: 'deepseek/cheap' }, { model: 'meta/free' }, { model: 'anthropic/prem' }],
    role_prompt: 'an SDR who books qualified meetings',
    role: 'SDR',
    volume: 'advisor'
  });
  check(hired.ok && Array.isArray(hired.offers), 'with `role` the audition returns offers', String(hired.offers?.length));
  check(hired.offers.length === 3, 'three candidates, three offers', String(hired.offers.length));
  check(hired.handle === 'sdr', 'the room derives the handle from the role', String(hired.handle));
  check(hired.offers.every((o) => o.cost.known), 'the injected price reaches the projection', JSON.stringify(hired.offers.map((o) => o.cost.monthly_usd)));
  check(hired.offers.some((o) => o.premium), 'the premium contrast survives the round trip');
  check(hired.offers.filter((o) => o.recommended).length === 1, 'exactly one recommendation end to end');

  check(hired.text.startsWith('Offers for "SDR"'), 'the offers table comes first', hired.text.split('\n')[0]);
  check(hired.text.includes('— raw replies —'), 'the raw audition rows are appended underneath');
  check(hired.text.includes('— probe —'), 'the probe stays visible so the ranking is auditable');
  check(hired.offers_text && !hired.offers_text.includes('— raw replies —'), 'offers_text is the table alone');

  check(room.roster().recruits.length === 0, 'making offers hires nobody');
  const ev = room.events.tail(50);
  check(ev.some((e) => /^offers for role "SDR"/.test(e.text || '')), 'the offers are logged to the channel', JSON.stringify(ev.slice(-1)));

  // and the offer is directly recruitable
  const top = hired.offers.find((o) => o.recommended);
  const rec = await room.recruit({
    name: top.handle, model: top.model, fallback_model: top.fallback_model,
    system_prompt: 'You are an SDR.'
  });
  check(rec.ok, 'the picked offer feeds recruit() without editing', rec.text);
  check(room.roster().recruits[0].model === top.model, 'the hire lands on the offered model', room.roster().text);
  check(room.roster().recruits[0].fallback_model === top.fallback_model, 'and carries the offered fallback');
}

done();
