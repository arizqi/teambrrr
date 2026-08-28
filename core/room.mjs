// room-core: host-agnostic shared agent room.
//
//   import { createRoom } from '.../core/room.mjs';
//   const room = createRoom({ host: 'hermes' });
//   await room.ask({ name: 'reviewer', message: 'thoughts?' });
//
// Every host (Claude Code MCP, Codex MCP, hermes-agent, Slack) drives the same
// object; only the digest source and the host tag differ.
import {
  createStore, migrateLegacy, DEFAULT_STATE_DIR, NAME_RE,
  revisionOf, updatedAtOf, stripInternal
} from './state.mjs';
import { defaultProvider, loadModels, priceOf, providerName, callWithRetry } from './provider.mjs';
import {
  discoverLocalModels, localContention, localCandidates, isLocalModel, parseLocalModel
} from './local-models.mjs';
import { createAutoSource } from './digest/auto.mjs';
import { MAX_DIGEST_CHARS, NO_DIGEST } from './digest/util.mjs';
import { runAudition } from './audition.mjs';
import { createCallBudget, estimateCallCost, isBudgetExhausted, maxCallsFromEnv } from './budget.mjs';
import { autonomyOf, describeAutonomy, normalizeAutonomy, AUTONOMY_MENU, DEFAULT_AUTONOMY } from './autonomy.mjs';
import { DEFAULT_JUDGE_MODELS } from './judges.mjs';
import { makeOffers } from './offers.mjs';
import { createExecutionBridge } from './execution.mjs';
import { evaluateRolePack, loadRolePack } from './role-packs.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILTIN_ROLE_PACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'role-packs');

const ROOM_RULES =
  'You are a member of a shared working room. Below is the recent channel ' +
  'transcript; the user and Claude (the chair) can see your reply. Be concise, ' +
  'specific, and sign nothing.';

// Fixes observed persona bleed when one message fans out to several recruits.
const SOLO_RULE =
  'Answer only as yourself; if a message addresses multiple people, respond ' +
  'only to the part addressed to you.';

// A recruit starts cold: it knows its persona and the last few thousand chars of
// channel, and nothing about why any of it matters. Two things fix that, and
// both ride on every call.
//
//   ONBOARDING BRIEF  — written once at hire time by the chair, from everything
//                       the chair knows and the recruit cannot see. Versioned.
//   PINNED ROOM CONTEXT — standing decisions, added as they are taken, budgeted
//                       so the block can never grow into a second system prompt.
//
// Each of those is a NAMED, FENCED block. The names are not decoration: a model
// reading four undifferentiated system messages has to infer which one wins
// when they disagree, and it usually infers "the most recent", which is the
// transcript — the least authoritative thing in the stack. So the pin block
// says outright that it takes precedence, and the transcript block says
// outright that it is background. Focused items first, ambient context last.
export const BRIEF_HEADER = '=== ONBOARDING BRIEF ===';
export const PINS_HEADER = '=== PINNED (PRIORITY — these decisions take precedence) ===';
export const TRANSCRIPT_HEADER = '=== CHANNEL TRANSCRIPT (background) ===';
export const PIN_BUDGET_CHARS = 2000;
export const BRIEF_COMPACT_WORDS = 800;
// How many channel events may pass before a brief is worth recompacting. Well
// under the point where the brief is wrong, and well over the point where
// recompacting is just churn.
export const BRIEF_STALE_EVENTS = 50;

const HISTORY_TURNS = 10;
const ERR_CHARS = 300;
const MAX_ROUNDS = 5;

const fmtCost = (c) => (typeof c === 'number' && Number.isFinite(c) ? `$${c.toFixed(4)}` : '$n/a');
const block = (name, model, cost, reply) => `[${name} · ${model} · ${fmtCost(cost)}]\n${reply}`;
const strip = (s) => String(s).replace(/^@/, '');
const roundBar = (n) => `— round ${n} —`;

// One pin per line. `by` is shown because "who decided this" is half the value
// of a standing decision.
export const pinLine = (p) => `- ${String(p.text).trim()}${p.by ? ` — ${p.by}` : ''}`;
export const renderPins = (list) => list.map(pinLine).join('\n');
export const pinsUsed = (list) => list.reduce((n, p) => n + String(p.text || '').trim().length, 0);

export function createRoom({
  stateDir = process.env.ROOM_STATE_DIR || DEFAULT_STATE_DIR,
  projectDir = process.cwd(),
  digestSource,
  provider,
  host = process.env.ROOM_HOST || 'unknown',
  budget = Number(process.env.PERSONA_RECRUITER_BUDGET_USD || '1.00'),
  maxCalls = maxCallsFromEnv(),
  judgeProvider,
  judgeModels = DEFAULT_JUDGE_MODELS,
  priceFor,
  executionBridge,
  localDiscovery,
  localContentionFn,
  rolePackDir = process.env.ROOM_ROLE_PACK_DIR || BUILTIN_ROLE_PACK_DIR,
  maxDigestChars = MAX_DIGEST_CHARS,
  retryDelayMs = 2000,
  autoMigrate = true
} = {}) {
  const store = createStore({ stateDir, projectDir });
  store.ensure();
  if (autoMigrate) { try { migrateLegacy({ projectDir, stateDir }); } catch {} }

  const digest = digestSource || createAutoSource({ stateDir, projectDir, host: process.env.ROOM_HOST });
  const prov = () => provider || defaultProvider();
  const execution = executionBridge || createExecutionBridge({
    stateDir,
    appendRoomEvent: (event) => store.appendEvent(event)
  });

  const models = ({ allowFetch = true } = {}) =>
    loadModels(store.modelsCachePath(), { allowFetch });

  // --- the budget ------------------------------------------------------------
  // ONE instance for this room process. Every provider call site takes a ticket
  // from it before calling, which is what makes a parallel fan-out land inside
  // the cap instead of one batch past it. The dollar side reads the persisted
  // ledger so the cap survives a restart; the call side is per process, because
  // "how many calls has this session made" is the question a runaway loop
  // makes you want to ask.
  const callBudget = createCallBudget({
    maxUsd: budget,
    maxCalls,
    spent: () => Number(store.readSpend().total || 0),
    record: (entry) => store.appendSpendEntry(entry),
    hint: `Raise PERSONA_RECRUITER_BUDGET_USD or clear ${store.stateDir}/spend.json.`
  });

  // The estimate the budget reserves before a call. A known price gives a real
  // number; an unknown price on a provider that can actually charge gives null,
  // which serialises that call rather than guessing. A mock provider spends
  // nothing by construction, so it reserves nothing and stays parallel.
  const reserveFor = ({ messages, params, price }) => {
    if (price) return estimateCallCost({ messages, params, price });
    return prov().name === 'mock' ? 0 : null;
  };

  // Wrap a provider so every call it makes is ticketed and attributed. Retries
  // inside callWithRetry come back through here, so a model that fails twice
  // costs two calls against the ceiling — which is the truth.
  // `onSpend` commits the real cost to the ledger BEFORE the reservation is
  // released. The ordering is load-bearing: a queued call wakes the instant the
  // reservation drops, and if the money it just cost has not landed in
  // spend.json yet, that queued call reads a stale total and reserves capacity
  // that is already gone.
  function budgeted(base, { who, why, estimate = reserveFor, wait = false, onSpend } = {}) {
    return {
      ...base,
      name: base.name,
      call: async (req) => {
        const label = typeof who === 'function' ? who(req) : who;
        const ticket = await callBudget.consume(label, why, {
          estimate: typeof estimate === 'function' ? estimate(req) : estimate,
          wait
        });
        let cost = 0;
        let failed = null;
        let ok = false;
        try {
          const r = await base.call(req);
          cost = typeof r?.cost === 'number' ? r.cost : 0;
          ok = true;
          return r;
        } catch (e) {
          failed = String(e?.message || e).slice(0, 200);
          throw e;
        } finally {
          if (ok && onSpend) { try { onSpend(cost, req); } catch {} }
          ticket.settle(cost, { model: req?.model || null, ...(failed ? { error: failed } : {}) });
        }
      }
    };
  }

  // --- local hosts -----------------------------------------------------------
  // Models running on this machine. Injectable so the tests never touch a
  // socket, and so a host adapter can point the room at a remote GPU box.
  const discoverLocal = localDiscovery || ((opts) => discoverLocalModels({ stateDir, ...opts }));
  const checkContention = localContentionFn || ((opts) => localContention({ stateDir, ...opts }));

  // Never throws and never blocks a decision: a machine with no local stack is
  // the ordinary case, and the answer is an empty field, not an error.
  async function localModels() {
    try { return await discoverLocal({}); }
    catch (e) {
      return {
        ok: false, hosts: [], models: [], running: [], down: [],
        text: `Local discovery failed: ${String(e?.message || e).slice(0, ERR_CHARS)}`
      };
    }
  }

  async function contentionFor(model) {
    try { return (await checkContention({ model })).warning; }
    catch { return null; }
  }

  // The catalog is the only source of truth for whether a model id exists. Both
  // recruit() and update_persona() go through here, so a typo fails at the point
  // of change rather than at the next ask().
  async function checkModels({ model, fallback_model } = {}) {
    // A local id is checked against the machine, not the catalog. A host that
    // is down is NOT a validation failure: hiring somebody before starting
    // their server is a legitimate order of operations, so it becomes a note.
    let localNote = '';
    if (isLocalModel(model)) {
      const found = await checkLocalModel(model);
      if (!found.ok) return found;
      localNote = found.note || '';
    }
    const remote = [model, fallback_model].filter((m) => m && !isLocalModel(m));
    if (isLocalModel(fallback_model)) {
      const found = await checkLocalModel(fallback_model);
      if (!found.ok) return found;
    }
    if (!remote.length) return { ok: true, priceNote: `${localNote} — $0 (local)` };
    if (prov().name === 'mock') return { ok: true, priceNote: `${localNote} — mock provider, model not validated` };
    const loaded = await models();
    if (!loaded) return { ok: true, priceNote: `${localNote} — model not validated (catalog unavailable)` };
    if (model && !isLocalModel(model) && !loaded.models[model]) {
      return { ok: false, error: `unknown OpenRouter model "${model}" (catalog from ${loaded.source})` };
    }
    if (fallback_model && !isLocalModel(fallback_model) && !loaded.models[fallback_model]) {
      return { ok: false, error: `unknown fallback_model "${fallback_model}" (catalog from ${loaded.source})` };
    }
    const p = model && !isLocalModel(model) ? priceOf(loaded.models, model) : null;
    return {
      ok: true,
      priceNote: localNote + (p ? ` — $${(p.prompt * 1e6).toFixed(2)}/M in, $${(p.completion * 1e6).toFixed(2)}/M out` : '')
    };
  }

  // Three outcomes, deliberately: installed (fine), host up but no such model
  // (a typo, and the one case worth refusing), host down (fine, with a note).
  async function checkLocalModel(id) {
    const parsed = parseLocalModel(id);
    if (!parsed) return { ok: false, error: `malformed local model id "${id}" — expected local/<host>/<model>` };
    const d = await localModels();
    const host = d.hosts.find((h) => h.host === parsed.host);
    if (!host) {
      return { ok: false, error: `unknown local host "${parsed.host}" — known hosts: ${d.hosts.map((h) => h.host).join(', ') || 'none'}` };
    }
    if (!host.running) {
      return { ok: true, note: ` — ${parsed.host} is not running (${host.reason || 'not running'}); start it with: ${host.start_command}` };
    }
    if (!host.models.some((m) => m.model === parsed.model || m.id === id)) {
      return {
        ok: false,
        error: `local host "${parsed.host}" is running but has no model "${parsed.model}". Installed: ` +
          (host.models.map((m) => m.model).join(', ') || 'none')
      };
    }
    return { ok: true, note: '' };
  }

  // --- prompt authoring quality ----------------------------------------------
  // The chair rates its own draft before it hires anybody: role fit,
  // specificity, refusal/escalation clarity, output-format clarity. The overall
  // is the MINIMUM, not the mean, for the same reason the audition composite is
  // geometric — a prompt with one blank dimension is a prompt with a hole in it,
  // and averaging hides exactly the hole you needed to see. Below 9 the skill
  // asks for one revision pass at the weakest dimension.
  //
  // Stored, not enforced: the gate lives in the chair's instructions, and this
  // is the record of whether it was actually run.
  const RATING_DIMENSIONS = ['role_fit', 'specificity', 'refusal_clarity', 'format_clarity'];
  const RATING_GATE = 9;

  // Returns null (absent), undefined (invalid), or the normalised record.
  function normalizeAuthoringRating(input) {
    if (input === undefined || input === null) return null;
    if (typeof input !== 'object' || Array.isArray(input)) return undefined;
    const scores = {};
    for (const d of RATING_DIMENSIONS) {
      const n = Number(input[d]);
      if (!Number.isFinite(n) || n < 1 || n > 10) return undefined;
      scores[d] = n;
    }
    const overall = Math.min(...RATING_DIMENSIONS.map((d) => scores[d]));
    const weakest = RATING_DIMENSIONS.reduce((a, b) => (scores[b] < scores[a] ? b : a));
    return {
      ...scores,
      overall,
      weakest,
      revised: input.revised === true,
      gate: RATING_GATE,
      passes_gate: overall >= RATING_GATE,
      ...(typeof input.notes === 'string' && input.notes.trim() ? { notes: input.notes.trim() } : {}),
      rated_at: new Date().toISOString()
    };
  }

  const ratingLine = (r) => (r
    ? `authoring rating: ${r.overall}/10 overall (min of ${RATING_DIMENSIONS.map((d) => `${d} ${r[d]}`).join(', ')})` +
      `${r.passes_gate ? '' : ` — below the ${RATING_GATE}/10 gate; weakest is ${r.weakest}`}` +
      `${r.revised ? ' · revised once' : ''}`
    : null);

  // --- recruit ---------------------------------------------------------------
  async function recruit({
    name, model, system_prompt, tags, params, fallback_model, briefing, watch,
    autonomy, authoring_rating
  }) {
    if (!NAME_RE.test(name || '')) {
      return fail(`invalid name "${name}" — must match ^[a-z0-9_-]{2,24}$`);
    }
    if (store.readPersona(name)) {
      return fail(`recruit "${name}" already exists — dismiss() first to replace`);
    }

    // Autonomy is refused rather than defaulted when it is a typo: silently
    // filing "L4" as advise-only would be a safety decision made by a regex.
    const level = normalizeAutonomy(autonomy);
    if (level === undefined) return fail(`invalid autonomy "${autonomy}" — one of ${AUTONOMY_MENU}`);

    const rating = normalizeAuthoringRating(authoring_rating);
    if (rating === undefined) {
      return fail('authoring_rating must be {role_fit, specificity, refusal_clarity, format_clarity} scored 1-10');
    }

    const chk = await checkModels({ model, fallback_model });
    if (!chk.ok) return fail(chk.error);
    const priceNote = chk.priceNote;

    const now = new Date().toISOString();
    const persona = {
      name, model, system_prompt,
      tags: tags || [], params: params || {},
      autonomy: level || DEFAULT_AUTONOMY,
      created_at: now, updated_at: now, revision: 1
    };
    if (fallback_model) persona.fallback_model = fallback_model;
    if (watch === true) persona.watch = true;
    if (rating) persona.authoring_rating = rating;
    const root = store.writePersona(name, persona);

    // The brief has to be written after the persona: writeBriefing resolves the
    // owning root through rootFor(), which only answers once persona.json exists.
    const brief = typeof briefing === 'string' && briefing.trim() ? briefing : null;
    // Deliberately no event: hiring is bookkeeping, and the channel digest is
    // for what the room said, not for who joined it.
    if (brief) store.writeBriefing(name, brief);

    const fb = fallback_model ? ` (fallback: ${fallback_model})` : '';
    const briefNote = brief
      ? ` Onboarding brief stored (rev 1) — it rides on every call.`
      : ` No onboarding brief: they start cold. Write one with brief_update({name:"${name}", briefing}).`;
    const watchNote = watch === true ? ' Watching: they review each of your turns at Stop.' : '';
    // Advisory, after the fact: the hire is already recorded, because whether
    // two models fit on one GPU is a scheduling problem, not a hiring one.
    const warning = isLocalModel(model) ? await contentionFor(model) : null;
    const fallbackNote = isLocalModel(model)
      ? fallback_model
        ? ` If ${model.split('/')[1]} is down they fall back to ${fallback_model}.`
        : ` No fallback_model: if their local server is down, calls report that rather than going remote.`
      : '';
    const autonomyNote = ` Autonomy ${describeAutonomy(persona.autonomy)}` +
      (level ? '.' : ' (the default — set `autonomy` at hire time if this seat may act).');
    const ratingNote = rating
      ? ` Prompt self-rating ${rating.overall}/10 (lowest: ${rating.weakest}).`
      : '';
    return {
      ok: true, name, model, root, briefing: brief, watch: watch === true,
      autonomy: persona.autonomy, authoring_rating: rating || null,
      local: isLocalModel(model), contention_warning: warning || null,
      text: `Recruited @${name} on ${model}${fb}${priceNote}. Address them with @${name} or ask({name:"${name}", ...}).` +
            `${briefNote}${watchNote}${autonomyNote}${ratingNote}${fallbackNote}${warning ? `\n\n${warning}` : ''}`
    };
  }

  // --- warm context assembly -------------------------------------------------
  // Each block is built independently and independently guarded. A recruit
  // whose pin board is corrupt on disk should still get its brief; a brief that
  // fails to read should still leave the transcript intact. Before this, one
  // throwing read took the whole call down and the chair saw "cannot read
  // property of null" where it expected an answer.
  function assembleContext({ name, persona, digestText, message }) {
    const messages = [];
    const skipped = [];
    const blockOrder = [
      // 1. Who they are. Never optional.
      ['persona', () => ({
        role: 'system',
        content: `${persona.system_prompt}\n\n${ROOM_RULES}\n\n${SOLO_RULE}\n\n${autonomyRuleFor(persona)}`
      })],
      // 2. What they were hired knowing.
      ['briefing', () => {
        const briefing = store.readBriefing(name);
        if (!briefing) return null;
        return { role: 'system', content: `${BRIEF_HEADER}\n${briefing.trim()}`, __briefing: true };
      }],
      // 3. Standing decisions, explicitly ranked above the transcript.
      ['pins', () => {
        const pinned = store.readPins();
        if (!pinned.length) return null;
        return { role: 'system', content: `${PINS_HEADER}\n${renderPins(pinned)}`, __pins: true };
      }],
      // 4. What has been happening, labelled as background.
      ['digest', () => ({
        role: 'system',
        content: `${TRANSCRIPT_HEADER}\n(most recent last; the pinned block above wins where they conflict)\n${digestText}`,
        __digest: true
      })]
    ];

    for (const [label, build] of blockOrder) {
      try {
        const block = build();
        if (block) messages.push(block);
      } catch (e) {
        skipped.push(`${label}: ${String(e?.message || e).slice(0, 120)}`);
      }
    }

    // 5. Their own memory, then 6. the question.
    try {
      for (const h of store.readHistory(name, HISTORY_TURNS)) {
        messages.push({ role: 'user', content: h.q });
        messages.push({ role: 'assistant', content: h.a });
      }
    } catch (e) { skipped.push(`history: ${String(e?.message || e).slice(0, 120)}`); }
    messages.push({ role: 'user', content: message });

    return { messages, skipped };
  }

  const autonomyRuleFor = (persona) => `AUTONOMY ${describeAutonomy(autonomyOf(persona))}.`;

  // --- the shared call path (ask, discuss) -----------------------------------
  async function askOne(name, message, digestText) {
    const persona = store.readPersona(name);
    if (!persona) throw new Error(`no recruit named "${name}" — run recruit() first`);

    // Order matters and is asserted by the tests: who you are, what you were
    // hired to know, what the room has standing, what just happened, what you
    // have said before, and only then the question.
    const { messages, skipped } = assembleContext({ name, persona, digestText, message });
    if (skipped.length) {
      store.appendEvent({
        host, author: 'chair', role: 'error',
        text: `context block(s) skipped for @${name}: ${skipped.join('; ')}`
      });
    }

    let price = null;
    if (prov().name !== 'mock') {
      const loaded = await models();
      price = priceOf(loaded?.models, persona.model);
    }

    const result = await callWithRetry({
      provider: budgeted(prov(), { who: name, why: 'ask' }),
      name: persona.name,
      model: persona.model,
      fallback_model: persona.fallback_model,
      messages, params: persona.params, price, retryDelayMs
    });
    const usedModel = result.model || persona.model;

    store.appendHistory(name, {
      ts: new Date().toISOString(), model: usedModel, provider: prov().name,
      q: message, a: result.text, cost: result.cost, usage: result.usage || null
    });
    store.addSpend(name, result.cost || 0);
    return { name, model: usedModel, cost: result.cost, reply: result.text };
  }

  // One recruit, one turn. Never throws: a failure becomes an error block so one
  // bad model can't take down a fan-out or a discussion round.
  async function turn({ name, message, digestText, askHost, extra = {} }) {
    try {
      const r = await askOne(name, message, digestText);
      store.appendEvent({ host: askHost, author: name, role: 'assistant', text: r.reply, ...extra });
      return { ...r, ...extra };
    } catch (e) {
      // A ceiling reached mid-batch is reported exactly like a 429: in this
      // recruit's own error block, naming the ceiling, without taking the rest
      // of the fan-out down with it.
      const msg = (budgetText(e) || String(e?.message || e)).slice(0, ERR_CHARS);
      store.appendEvent({ host: askHost, author: name, role: 'error', text: msg, ...extra });
      return {
        name, model: 'error', cost: null, reply: msg, error: true,
        ...(isBudgetExhausted(e) ? { budget_exhausted: true } : {}), ...extra
      };
    }
  }

  // Returns a fail() when either ceiling is spent, otherwise null. This is the
  // cheap preflight; the binding decision is made per call inside consume().
  function overBudget() {
    const e = callBudget.exhausted();
    return e ? fail(e.message) : null;
  }

  // Every provider call site funnels its failures through here so a
  // BudgetExhausted lands in the same `[name · error]` block a 429 would, with
  // the ceiling named rather than a stack trace.
  const budgetText = (e) => (isBudgetExhausted(e) ? `budget: ${e.message}` : null);

  async function buildDigest() {
    try { return await digest.build({ projectDir, maxChars: maxDigestChars }); }
    catch { return NO_DIGEST; }
  }

  async function ask({ name, names, message, per, host: askHost = host } = {}) {
    const targets = (names && names.length ? names : name ? [name] : []).map(strip);
    if (!targets.length) return fail('give either name or names');

    const capped = overBudget();
    if (capped) return capped;

    const msgFor = (t) => (per && typeof per[t] === 'string' ? per[t] : message);
    if (targets.some((t) => typeof msgFor(t) !== 'string' || !msgFor(t).length)) {
      return fail('every target needs a message: pass `message`, or cover all names in `per`');
    }

    const digestText = await buildDigest();

    const blocks = await Promise.all(targets.map((t) => {
      const q = msgFor(t);
      store.appendEvent({ host: askHost, author: 'chair', role: 'user', text: `@${t} ${q}` });
      return turn({ name: t, message: q, digestText, askHost });
    }));

    return {
      ok: true,
      blocks,
      text: blocks.map((b) => block(b.name, b.model, b.cost, b.reply)).join('\n\n')
    };
  }

  // --- discuss ---------------------------------------------------------------
  // Round-robin between recruits, server-side. Round 1 is each recruit's opening
  // position on the topic; every later round hands each of them the previous
  // round's replies, attributed by name, and asks them to push back or refine.
  //
  // The digest is built once, before round 1: later rounds already carry the
  // replies verbatim, so rebuilding would just duplicate them.
  function roundPrompt({ topic, round, rounds, targets, previous }) {
    const roster = targets.map((t) => `@${t}`).join(', ');
    if (round === 1) {
      return `ROOM TOPIC: ${topic}\n\n` +
        `This is round 1 of ${rounds} in a discussion between ${roster}. ` +
        `Give your own position on the topic — concrete, specific, in your own voice. ` +
        `Do not speak for anyone else.`;
    }
    return `ROOM TOPIC: ${topic}\n\n` +
      `ROUND ${round - 1} REPLIES:\n${previous}\n\n` +
      `This is round ${round} of ${rounds}. Respond to what your colleagues just said: ` +
      `say where you agree, refine your own position, or disagree and say exactly why. ` +
      `Address them by name. Do not repeat your earlier points verbatim.`;
  }

  async function discuss({ names, topic, rounds = 2, digest: useDigest = true, host: askHost = host } = {}) {
    const targets = [...new Set((names || []).map(strip))];
    if (targets.length < 2) return fail('discuss needs at least two names');
    if (typeof topic !== 'string' || !topic.trim()) return fail('discuss needs a topic');

    const missing = targets.filter((t) => !store.readPersona(t));
    if (missing.length) return fail(`no recruit named ${missing.map((m) => `"${m}"`).join(', ')} — run recruit() first`);

    const n = Math.max(1, Math.min(MAX_ROUNDS, Math.floor(Number(rounds)) || 2));
    const capped = overBudget();
    if (capped) return capped;

    const digestText = useDigest ? await buildDigest() : NO_DIGEST;

    const blocks = [];
    const sections = [];
    let previous = null;
    let stoppedAt = null;

    for (let round = 1; round <= n; round++) {
      if (round > 1) {
        const spent = overBudget();
        if (spent) { stoppedAt = round; break; }
      }
      const message = roundPrompt({ topic, round, rounds: n, targets, previous });
      store.appendEvent({ host: askHost, author: 'chair', role: 'user', text: `${roundBar(round)} ${topic}`, round });

      const got = await Promise.all(targets.map((t) =>
        turn({ name: t, message, digestText, askHost, extra: { round } })
      ));

      blocks.push(...got);
      sections.push(`${roundBar(round)}\n\n${got.map((b) => block(b.name, b.model, b.cost, b.reply)).join('\n\n')}`);

      // Only replies that actually landed feed the next round; a recruit that
      // errored simply contributes nothing and is asked again next round.
      const landed = got.filter((b) => !b.error);
      if (!landed.length) { stoppedAt = round + 1; break; }
      previous = landed.map((b) => `@${b.name}: ${b.reply}`).join('\n\n');
    }

    const note = stoppedAt
      ? `\n\n(discussion stopped before round ${stoppedAt}: ${overBudget() ? 'spend cap reached' : 'every recruit errored'})`
      : '';

    return {
      ok: true,
      rounds: n,
      names: targets,
      blocks,
      text: sections.join('\n\n') + note
    };
  }

  // --- audition --------------------------------------------------------------
  // One cheap probe per candidate model, scored mechanically. Never recruits
  // anybody: it hands back a ranked table so the chair (or the user) chooses.
  //
  // Pass `role` (and optionally `volume`) to get the hiring view: the same rows,
  // rendered first as 2-3 offer cards with a monthly cost projection, so the
  // user picks a price rather than a leaderboard position.
  async function audition({
    candidates, role_prompt, probe, role, volume, judges = null, autonomy,
    include_local = false, local_only = false, host: askHost = host
  } = {}) {
    const wantsLocal = include_local || local_only;
    let discovery = null;
    let given = Array.isArray(candidates) ? candidates : [];
    if (local_only) given = given.filter((c) => isLocalModel(c?.model));
    if (wantsLocal) {
      discovery = await localModels();
      const already = new Set(given.map((c) => c?.model));
      candidates = [...given, ...localCandidates(discovery.models).filter((c) => !already.has(c.model))];
    } else {
      candidates = given;
    }

    if (!Array.isArray(candidates) || !candidates.length) {
      return fail(wantsLocal
        ? `No candidates. ${discovery?.text || 'No local models found.'}`
        : 'audition needs candidates: [{model, fallback_model?}]');
    }
    if (candidates.some((c) => !c || typeof c.model !== 'string' || !c.model.trim())) {
      return fail('every candidate needs a model id');
    }
    if (typeof role_prompt !== 'string' || !role_prompt.trim()) {
      return fail('audition needs a role_prompt — the role the candidates are trying out for');
    }
    const capped = overBudget();
    if (capped) return capped;

    let loaded = null;
    if (prov().name !== 'mock') {
      loaded = await models();
      if (loaded) {
        // Local ids are not in the OpenRouter catalog and never will be.
        const unknown = [...new Set(candidates.flatMap((c) => [c.model, c.fallback_model]).filter(Boolean))]
          .filter((m) => !isLocalModel(m) && !loaded.models[m]);
        if (unknown.length) {
          return fail(`unknown OpenRouter model(s): ${unknown.join(', ')} (catalog from ${loaded.source})`);
        }
      }
    }

    // The panel is a second provider, deliberately: cheap models from other
    // families, budgeted and attributed separately so `spend` can answer "what
    // did the judging cost" without unpicking the probes.
    const judgePanelProvider = judges
      ? budgeted(judgeProvider || prov(), { who: (req) => `judge:${req?.model || '?'}`, why: 'audition-judge' })
      : null;

    const res = await runAudition({
      candidates, role_prompt, probe,
      provider: budgeted(prov(), { who: (req) => `audition:${req?.model || '?'}`, why: 'audition' }),
      // Local models are priced at zero, not unpriced: the row then flows
      // through the same ledger and cost arithmetic as a paid one.
      priceFor: (m) => (isLocalModel(m)
        ? { prompt: 0, completion: 0 }
        : (priceFor ? priceFor(m) : priceOf(loaded?.models, m))),
      judges,
      judgeModels,
      judgeCall: judgePanelProvider
        ? ({ model, messages }) => judgePanelProvider.call({ name: 'judge', model, messages, params: {}, price: null })
        : null,
      retryDelayMs
    });

    store.appendEvent({
      host: askHost, author: 'chair', role: 'user',
      text: `audition (${candidates.map((c) => c.model).join(', ')}) for role: ${role_prompt.slice(0, 200)}`
    });
    for (const r of res.rows) {
      if (!r.error) store.addSpend('audition', r.cost || 0);
      store.appendEvent({
        host: askHost, author: `audition:${r.model}`,
        role: r.error ? 'error' : 'assistant', text: r.reply
      });
    }
    // The panel is part of the audition's price, and hiding it in the probe
    // total would make the judges look free. They are not.
    const judgeCost = res.rows.reduce(
      (n, r) => n + (r.judge_scores || []).reduce((m, s) => m + (Number(s.cost) || 0), 0), 0);
    if (res.judges?.length) store.addSpend('audition:judges', judgeCost);

    // Discovery is evidence too: which hosts answered, and what to run if one
    // did not, belongs in the transcript rather than in a swallowed exception.
    const localText = discovery ? `${discovery.text}\n\n` : '';
    const localWarning = res.rows.some((r) => r.local) ? await contentionFor(null) : null;

    if (!role) {
      return {
        ...res,
        local_hosts: discovery?.hosts || null,
        contention_warning: localWarning,
        text: `${localText}${res.text}${localWarning ? `\n\n${localWarning}` : ''}`
      };
    }

    // Hiring view: offers first, the audition evidence underneath. The rows are
    // kept verbatim so the chair can still show its working when asked.
    const offered = makeOffers({
      auditionRows: res.rows, role, volume, local_warning: localWarning,
      autonomy: normalizeAutonomy(autonomy) || DEFAULT_AUTONOMY
    });
    store.appendEvent({
      host: askHost, author: 'chair', role: 'user',
      text: `offers for role "${role}": ${offered.offers.map((o) => o.model).join(', ') || 'none'}`
    });
    return {
      ...res,
      role,
      offers: offered.offers,
      volume: offered.volume,
      handle: offered.handle,
      recommended: offered.recommended,
      offers_text: offered.text,
      local_hosts: discovery?.hosts || null,
      contention_warning: localWarning,
      text: `${localText}${offered.text}\n\n${res.text}`
    };
  }

  // --- role-pack evaluation --------------------------------------------------
  // Audition remains the fast one-probe path. A role pack is the evidence path:
  // multiple realistic cases, repeated trials, explicit fatal criteria, and a
  // reproducible pack version. It still hires nobody.
  async function evaluateRole({
    role_pack, candidates, trials, max_parallel = 4, offers = true, autonomy,
    include_local = false, local_only = false, host: askHost = host
  } = {}) {
    try {
      if (typeof role_pack !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(role_pack)) {
        return fail('evaluate_role needs a role_pack id such as "sdr-outbound"');
      }
      const wantsLocal = include_local || local_only;
      let discovery = null;
      if (wantsLocal) {
        let given = Array.isArray(candidates) ? candidates : [];
        if (local_only) given = given.filter((c) => isLocalModel(c?.model));
        discovery = await localModels();
        const already = new Set(given.map((c) => c?.model));
        candidates = [...given, ...localCandidates(discovery.models).filter((c) => !already.has(c.model))];
      }
      if (!Array.isArray(candidates) || !candidates.length) {
        return fail(wantsLocal
          ? `No candidates. ${discovery?.text || 'No local models found.'}`
          : 'evaluate_role needs candidates: [{model, fallback_model?}]');
      }
      const capped = overBudget();
      if (capped) return capped;

      const pack = loadRolePack(path.join(rolePackDir, `${role_pack}.json`), { root: rolePackDir });
      let loaded = null;
      if (prov().name !== 'mock') {
        loaded = await models();
        if (loaded) {
          const unknown = [...new Set(candidates.flatMap((c) => [c?.model, c?.fallback_model]).filter(Boolean))]
            .filter((m) => !isLocalModel(m) && !loaded.models[m]);
          if (unknown.length) return fail(`unknown OpenRouter model(s): ${unknown.join(', ')} (catalog from ${loaded.source})`);
          const tooSmall = candidates.filter((c) => {
            if (isLocalModel(c.model)) return false; // context comes from the host, not the catalog
            const have = Number(loaded.models[c.model]?.context_length || 0);
            return have > 0 && have < Number(pack.candidate_requirements?.min_context_tokens || 0);
          });
          if (tooSmall.length) {
            return fail(`candidate context window below role-pack minimum ${pack.candidate_requirements.min_context_tokens}: ` +
              tooSmall.map((c) => c.model).join(', '));
          }
        }
      }

      const priced = candidates.map((c) => ({
        ...c,
        price: c.price || (isLocalModel(c.model) ? { prompt: 0, completion: 0 } : priceOf(loaded?.models, c.model))
      }));
      // Role packs can fan out dozens of trials. The reservation logic that used
      // to live here now lives in the shared CallBudget, so a role evaluation,
      // an audition and an ask all draw on one ceiling and land in one
      // attribution log. The behaviour it had is preserved exactly: estimated
      // capacity is reserved before each call, unknown-price calls serialise
      // and require at least a cent of room, and queued trials wake as
      // reservations settle.
      const estimateFor = (request) => estimateCallCost({
        messages: request.messages,
        params: request.params,
        price: request.price,
        defaultMaxTokens: pack.default_volume?.tokens_out || 1000
      });
      const evalProvider = budgeted(prov(), {
        who: `evaluation:${pack.id}`, why: `role-pack:${pack.id}`,
        estimate: estimateFor, wait: true,
        onSpend: (cost) => store.addSpend(`evaluation:${pack.id}`, cost)
      });
      const budgetedCall = (request) => callWithRetry({ ...request, provider: evalProvider });
      const result = await evaluateRolePack({
        pack,
        candidates: priced,
        trials: trials ?? pack.trial_count,
        maxParallel: max_parallel,
        retryDelayMs,
        call: budgetedCall
      });
      store.appendEvent({
        host: askHost, author: 'chair', role: 'user',
        text: `role-pack ${pack.id}@${pack.version} evaluated: ${result.rows.map((r) => `${r.model}=${r.score}`).join(', ')}`
      });

      const evidenceText = [
        `Role evaluation: ${pack.name} (${pack.id}@${pack.version}) · ${result.trial_count} trial(s) per case`,
        '',
        ...result.rows.map((r) =>
          `#${r.rank} ${r.model} · score ${(r.score * 100).toFixed(1)} · pass ${(r.pass_rate * 100).toFixed(0)}% · ` +
          `consistency ${(r.consistency * 100).toFixed(0)}% · ${r.eligible ? 'eligible' : r.fatal_failure ? 'fatal failure' : r.pending_manual ? 'manual review' : 'not eligible'} · ` +
          `${(r.latency_ms / 1000).toFixed(1)}s avg · ` +
          `${r.tokens_per_sec ? `${r.tokens_per_sec} tok/s · ` : ''}` +
          `eval cost ${isLocalModel(r.model) ? '$0 (local)' : fmtCost(r.cost)}`
        ),
        '',
        'No candidate was hired. Raw case/trial evidence is available in the structured result.'
      ].join('\n');

      const localText = discovery ? `${discovery.text}\n\n` : '';
      const localWarning = result.rows.some((r) => isLocalModel(r.model)) ? await contentionFor(null) : null;

      if (!offers) {
        return {
          ...result, pack,
          local_hosts: discovery?.hosts || null,
          contention_warning: localWarning,
          text: `${localText}${evidenceText}${localWarning ? `\n\n${localWarning}` : ''}`
        };
      }
      const offerRows = result.rows.map((r) => ({
        ...r,
        local: isLocalModel(r.model),
        host: parseLocalModel(r.model)?.host || null,
        verdict: r.eligible ? 'role-pass' : r.fatal_failure ? 'fatal-fail' : r.pending_manual ? 'manual-review' : 'role-fail',
        // Offers are admission decisions, not merely a prettier leaderboard.
        // Keep failed candidates in the evidence table, but never turn a fatal,
        // manual-pending, or otherwise ineligible result into a selectable hire.
        error: r.eligible ? null : r.evidence.every((e) => e.error)
          ? 'every trial errored'
          : r.fatal_failure
            ? 'failed a fatal role criterion'
            : r.pending_manual
              ? 'manual review required'
              : 'did not meet role thresholds'
      }));
      const offered = makeOffers({
        rows: offerRows,
        role: pack.name,
        volume: pack.default_volume,
        handle: pack.id,
        local_warning: localWarning,
        autonomy: normalizeAutonomy(autonomy) || DEFAULT_AUTONOMY
      });
      return {
        ...result,
        pack,
        offers: offered.offers,
        recommended: offered.recommended,
        volume: offered.volume,
        offers_text: offered.text,
        local_hosts: discovery?.hosts || null,
        contention_warning: localWarning,
        text: `${localText}${offered.text}\n\n${evidenceText}`
      };
    } catch (error) {
      return fail(String(error?.message || error));
    }
  }

  // --- live execution continuity --------------------------------------------
  // The room owns identity and the task ledger; Hermes/OpenClaw own tools and
  // runtime approvals. These chair-facing wrappers never execute anything.
  async function assignTask({ name, title, input, metadata, room_id, task_id, idempotency_key } = {}) {
    const n = strip(name || '');
    const persona = store.readPersona(n);
    if (!persona) return fail(`no recruit named "${n}" — recruit() first`);
    if (typeof title !== 'string' || !title.trim()) return fail('assign_task needs a title');
    try {
      const result = await execution.createTask({
        id: task_id,
        idempotencyKey: idempotency_key,
        agent: { id: `room-recruit:${n}`, name: n, model: persona.model },
        title: title.trim(), input: input ?? null, metadata: metadata || {}, room_id: room_id || null
      });
      return {
        ok: true, ...result,
        text: `${result.idempotent ? 'Reused' : 'Assigned'} task ${result.task.id} to @${n}: ${result.task.title} · status ${result.task.status} · version ${result.task.version}`
      };
    } catch (error) { return fail(`${error.code ? `${error.code}: ` : ''}${error.message || error}`); }
  }

  function taskStatus({ task_id, name, status } = {}) {
    try {
      if (task_id) {
        const task = execution.getTask(task_id);
        if (!task) return fail(`task ${task_id} not found`);
        return { ok: true, task, text: renderTask(task) };
      }
      const n = name ? strip(name) : null;
      const tasks = execution.listTasks({
        status: status || undefined,
        agentId: n ? `room-recruit:${n}` : undefined
      });
      return {
        ok: true, tasks,
        text: tasks.length ? tasks.map(renderTask).join('\n') : 'No matching execution tasks.'
      };
    } catch (error) { return fail(`${error.code ? `${error.code}: ` : ''}${error.message || error}`); }
  }

  async function decideTask({ task_id, approval_id, decision, by = 'user', expected_version, reason } = {}) {
    try {
      const result = decision === 'approve'
        ? await execution.approveTask({ taskId: task_id, approvalId: approval_id, by, expectedVersion: expected_version })
        : decision === 'reject'
          ? await execution.rejectTask({ taskId: task_id, approvalId: approval_id, by, reason, expectedVersion: expected_version, idempotencyKey: `reject:${approval_id}:${by}` })
          : null;
      if (!result) return fail('task_decide needs decision "approve" or "reject"');
      return { ok: true, ...result, text: `${decision === 'approve' ? 'Approved' : 'Rejected'} task ${task_id} by ${by} · status ${result.task.status} · version ${result.task.version}` };
    } catch (error) { return fail(`${error.code ? `${error.code}: ` : ''}${error.message || error}`); }
  }

  async function cancelTask({ task_id, reason, by = 'user', expected_version, idempotency_key } = {}) {
    try {
      const result = await execution.cancelTask({
        taskId: task_id, reason, by, expectedVersion: expected_version,
        idempotencyKey: idempotency_key
      });
      return { ok: true, ...result, text: `Canceled task ${task_id}${reason ? `: ${reason}` : ''}` };
    } catch (error) { return fail(`${error.code ? `${error.code}: ` : ''}${error.message || error}`); }
  }

  const renderTask = (task) =>
    `${task.id} · @${task.agent.name} · ${task.status} · v${task.version} · ${task.title}` +
    (task.progress?.message ? ` · ${task.progress.message}` : '') +
    (task.approval?.status === 'pending' ? ` · approval:${task.approval.id}` : '');

  // --- roster ----------------------------------------------------------------
  function roster() {
    const spend = store.readSpend();
    const rs = store.listPersonas();
    if (!rs.length) {
      return { ok: true, recruits: [], spend, text: 'No recruits yet. Use recruit({name, model, system_prompt}).' };
    }
    const rows = rs.map((r) => {
      const s = spend.byRecruit[r.name] || { calls: 0, spend: 0 };
      const scope = r.__scope === 'project' ? ' · project' : '';
      const fb = r.fallback_model ? ` · fallback:${r.fallback_model}` : '';
      return `@${r.name} · ${r.model}${fb} · ${autonomyOf(r)} · tags:[${(r.tags || []).join(', ')}] · ` +
             `calls:${s.calls} · spend:$${(s.spend || 0).toFixed(4)}${scope}`;
    });
    rows.push(
      `— session total: $${(spend.total || 0).toFixed(4)} of $${budget.toFixed(2)} cap · ` +
      `${callBudget.calls()} of ${callBudget.maxCalls} calls · ` +
      `provider: ${prov().name} · state: ${store.stateDir}${store.hasOverlay() ? ` (+overlay ${store.overlay})` : ''}`
    );
    return { ok: true, recruits: rs, spend, text: rows.join('\n') };
  }

  // --- spend -----------------------------------------------------------------
  // The roster answers "how much is left". This answers "where did it go" —
  // per recruit, per reason, from the attribution log the budget writes on
  // every settled call. A cost you cannot attribute is a cost you cannot cut.
  function spendReport({ limit = 0 } = {}) {
    const spend = store.readSpend();
    const log = store.readSpendLog(limit);
    const snap = callBudget.snapshot();

    const byWho = new Map();
    for (const e of log) {
      const who = String(e.who || 'unknown');
      const row = byWho.get(who) || { who, calls: 0, cost: 0, why: new Map(), errors: 0 };
      row.calls += 1;
      row.cost += Number(e.cost) || 0;
      if (e.error) row.errors += 1;
      row.why.set(e.why, (row.why.get(e.why) || 0) + 1);
      byWho.set(who, row);
    }
    // A recruit that spent before this process started has ledger totals but no
    // log lines; show them rather than pretending the money never moved.
    for (const [who, r] of Object.entries(spend.byRecruit || {})) {
      if (byWho.has(who)) continue;
      byWho.set(who, { who, calls: r.calls || 0, cost: r.spend || 0, why: new Map([['(before this session)', r.calls || 0]]), errors: 0 });
    }

    const rows = [...byWho.values()].sort((a, b) => (b.cost - a.cost) || (b.calls - a.calls));
    const attribution = rows.map((r) => ({
      who: r.who, calls: r.calls, cost: Number(r.cost.toFixed(6)), errors: r.errors,
      why: Object.fromEntries(r.why)
    }));

    const lines = rows.length
      ? rows.map((r) =>
          `${r.who} · ${r.calls} call${r.calls === 1 ? '' : 's'} · $${r.cost.toFixed(4)} · ` +
          `${[...r.why.entries()].map(([w, n]) => `${w} ${n}`).join(', ')}` +
          (r.errors ? ` · ${r.errors} errored` : ''))
      : ['(nothing spent yet)'];

    return {
      ok: true,
      totals: {
        spent: Number(spend.total || 0), cap: snap.cap, remaining_usd: snap.remaining_usd,
        calls: snap.calls, max_calls: snap.max_calls, remaining_calls: snap.remaining_calls
      },
      attribution,
      ledger: store.spendLogPath(),
      text: [
        `spend — $${Number(spend.total || 0).toFixed(4)} of $${snap.cap.toFixed(2)} cap ` +
        `($${snap.remaining_usd.toFixed(4)} left) · ${snap.calls} of ${snap.max_calls} calls this session ` +
        `(${snap.remaining_calls} left)`,
        '',
        ...lines,
        '',
        `— attribution log: ${store.spendLogPath()}`
      ].join('\n')
    };
  }

  // --- persona lifecycle -----------------------------------------------------
  // A hire is a first draft. The prompt you wrote before you saw the recruit
  // work is rarely the prompt you want after, so the persona is versioned:
  // every change snapshots the superseded copy under revisions/<n>.json and
  // bumps the revision. The chain is append-only — a rollback writes a *new*
  // revision carrying old content, so "what were they told, and when" survives
  // somebody changing their mind twice. Memory (history.jsonl) is never touched
  // by any of this: rewriting the brief does not erase the correspondence.

  // Revisions on disk are the superseded ones (1..current-1); current lives in
  // persona.json, so it has to be added back to get the full chain.
  function chainOf(name, current) {
    const cur = revisionOf(current);
    return [...new Set([...store.listRevisions(name), cur])].sort((a, b) => a - b);
  }

  const revList = (chain, cur) =>
    [...chain].reverse().map((r) => (r === cur ? `rev ${r} (current)` : `rev ${r}`)).join(' · ');

  function renderPersona({ name, persona, shown, current, chain, briefing, briefRev, staleness }) {
    const p = persona;
    const head = shown === current
      ? `@${name} · rev ${shown} (current)`
      : `@${name} · rev ${shown} (historical; current is rev ${current})`;
    const when = updatedAtOf(p);
    const lines = [
      `${head}${when ? ` · updated ${when}` : ''}`,
      `model: ${p.model}${p.fallback_model ? ` · fallback: ${p.fallback_model}` : ''}`,
      `tags: [${(p.tags || []).join(', ')}] · params: ${JSON.stringify(p.params || {})}` +
        (p.watch ? ' · watch: on' : ''),
      `autonomy: ${describeAutonomy(autonomyOf(p))}`
    ];
    const rated = ratingLine(p.authoring_rating);
    if (rated) lines.push(rated);
    if (p.rolled_back_from) lines.push(`this revision was rolled back from rev ${p.rolled_back_from}`);
    lines.push(`revisions: ${revList(chain, current)}`);
    lines.push(briefing
      ? `briefing: rev ${briefRev}${briefRev > 1 ? ` (${briefRev - 1} superseded)` : ' (original)'}` +
        (staleness ? ` · ${staleness.events_since} events since it was last compacted` +
          (staleness.stale ? ` — stale, run brief_compact({name:"${name}"})` : '') : '')
      : 'briefing: none — they started cold; brief_update({name, briefing}) fixes that');
    // Never truncated: the whole point of showing a prompt is reading it.
    lines.push('', `— system prompt (rev ${shown}) —`, p.system_prompt ?? '');
    if (briefing) lines.push('', `— onboarding brief (rev ${briefRev}) —`, briefing.trim());
    return lines.join('\n');
  }

  function showPersona({ name, revision } = {}) {
    const n = strip(name || '');
    const current = store.readPersona(n);
    if (!current) return fail(`no recruit named "${n}"`);

    const cur = revisionOf(current);
    const chain = chainOf(n, current);

    let persona = stripInternal(current);
    let shown = cur;
    if (revision !== undefined && revision !== null && revision !== '') {
      const want = Number(revision);
      if (!Number.isInteger(want) || !chain.includes(want)) {
        return fail(`no revision ${revision} for @${n} — have ${chain.join(', ')}`);
      }
      if (want !== cur) {
        const old = store.readRevision(n, want);
        if (!old) return fail(`revision ${want} of @${n} is missing from disk`);
        persona = old;
        shown = want;
      }
    }

    const briefing = store.readBriefing(n);
    const briefRev = store.briefingRevision(n);

    const staleness = briefing ? briefStaleness(n) : null;

    return {
      ok: true, name: n, revision: shown, current: cur, revisions: chain, persona,
      autonomy: autonomyOf(persona), authoring_rating: persona.authoring_rating || null,
      briefing, briefing_revision: briefing ? briefRev : 0, brief_staleness: staleness,
      text: renderPersona({ name: n, persona, shown, current: cur, chain, briefing, briefRev, staleness })
    };
  }

  async function updatePersona({
    name, system_prompt, tags, params, model, fallback_model, watch, autonomy, authoring_rating
  } = {}) {
    const n = strip(name || '');
    const current = store.readPersona(n);
    // No implicit create: a typo'd name must not silently spawn a new recruit
    // with a half-specified persona.
    if (!current) return fail(`no recruit named "${n}" — recruit() first; update_persona never creates`);

    const changes = {};
    if (typeof system_prompt === 'string' && system_prompt.trim()) changes.system_prompt = system_prompt;
    if (Array.isArray(tags)) changes.tags = tags;
    if (params && typeof params === 'object' && !Array.isArray(params)) changes.params = params;
    if (typeof model === 'string' && model.trim()) changes.model = model;
    if (typeof fallback_model === 'string') changes.fallback_model = fallback_model; // '' clears it
    if (typeof watch === 'boolean') changes.watch = watch;
    if (autonomy !== undefined && autonomy !== null && autonomy !== '') {
      const level = normalizeAutonomy(autonomy);
      if (level === undefined) return fail(`invalid autonomy "${autonomy}" — one of ${AUTONOMY_MENU}`);
      changes.autonomy = level;
    }
    if (authoring_rating !== undefined && authoring_rating !== null) {
      const rating = normalizeAuthoringRating(authoring_rating);
      if (rating === undefined) {
        return fail('authoring_rating must be {role_fit, specificity, refusal_clarity, format_clarity} scored 1-10');
      }
      changes.authoring_rating = rating;
    }
    const fields = Object.keys(changes);
    if (!fields.length) {
      return fail('update_persona needs at least one of: system_prompt, tags, params, model, fallback_model, watch, autonomy, authoring_rating');
    }

    if (changes.model || changes.fallback_model) {
      const chk = await checkModels({ model: changes.model, fallback_model: changes.fallback_model || undefined });
      if (!chk.ok) return fail(chk.error);
    }

    const from = revisionOf(current);
    store.snapshotPersona(n);

    const next = { ...stripInternal(current), ...changes, revision: from + 1, updated_at: new Date().toISOString() };
    if (changes.fallback_model === '') delete next.fallback_model;
    if (changes.watch === false) delete next.watch;
    delete next.rolled_back_from;
    store.writePersona(n, next);

    store.appendEvent({
      host, author: 'chair', role: 'user',
      text: `persona updated rev ${next.revision}: @${n} (${fields.join(', ')})`
    });

    return {
      ok: true, name: n, revision: next.revision, from, changed: fields, persona: next,
      text: `Updated @${n} to rev ${next.revision} (was rev ${from}); changed: ${fields.join(', ')}. ` +
            `rev ${from} kept at ${store.rootFor(n)}/recruits/${n}/revisions/${from}.json. ` +
            `Memory is untouched — they keep every exchange so far.`
    };
  }

  function rollbackPersona({ name, revision } = {}) {
    const n = strip(name || '');
    const current = store.readPersona(n);
    if (!current) return fail(`no recruit named "${n}"`);

    const cur = revisionOf(current);
    const chain = chainOf(n, current);
    const want = Number(revision);
    if (!Number.isInteger(want) || !chain.includes(want)) {
      return fail(`no revision ${revision} for @${n} — have ${chain.join(', ')}`);
    }
    if (want === cur) return fail(`@${n} is already at rev ${cur} — nothing to roll back to`);

    const target = store.readRevision(n, want);
    if (!target) return fail(`revision ${want} of @${n} is missing from disk`);

    store.snapshotPersona(n);
    // Forward, not backward: rev cur+1 carries rev `want`'s content. The chain
    // is never rewritten, so the discarded revision stays readable.
    const next = {
      ...stripInternal(target), name: n,
      revision: cur + 1, updated_at: new Date().toISOString(), rolled_back_from: want
    };
    store.writePersona(n, next);

    store.appendEvent({
      host, author: 'chair', role: 'user',
      text: `persona updated rev ${next.revision}: @${n} rolled back to rev ${want}`
    });

    return {
      ok: true, name: n, revision: next.revision, from: cur, restored: want, persona: next,
      text: `Rolled @${n} back to the contents of rev ${want}, written as rev ${next.revision} ` +
            `(rev ${cur} is kept, not overwritten). Memory is untouched.`
    };
  }

  // --- onboarding briefings --------------------------------------------------
  // Same contract as the persona: replace wholesale, snapshot the superseded
  // copy, never rewrite the chain. A brief goes stale faster than a persona
  // does — it is a description of the project at a moment — so "re-onboard
  // @name" is a routine move, not a repair.
  function briefUpdate({ name, briefing } = {}) {
    const n = strip(name || '');
    if (!store.readPersona(n)) {
      return fail(`no recruit named "${n}" — recruit() first; brief_update never creates`);
    }
    if (typeof briefing !== 'string' || !briefing.trim()) {
      return fail('brief_update needs a `briefing` — the full replacement text, not a patch');
    }

    const had = store.readBriefing(n);
    const from = store.snapshotBriefing(n);          // null when there was none
    store.writeBriefing(n, briefing);
    const rev = store.briefingRevision(n);
    // A brief just written is current by definition, so the staleness clock
    // restarts here whether or not brief_compact was what prompted the rewrite.
    try { store.writeCompaction(n, { events_at: store.eventCount(), at: new Date().toISOString() }); } catch {}

    store.appendEvent({
      host, author: 'chair', role: 'user',
      text: `briefing updated rev ${rev}: @${n} (${briefing.length} chars)`
    });

    return {
      ok: true, name: n, revision: rev, from, briefing,
      text: had
        ? `Re-briefed @${n} — brief rev ${rev} (was rev ${from}, kept at ` +
          `${store.rootFor(n)}/recruits/${n}/briefings/${from}.md). It rides on every call from now on. ` +
          `Persona and memory are untouched.`
        : `Briefed @${n} — brief rev ${rev}, their first. It rides on every call from now on.`
    };
  }

  // --- rolling compacted brief -----------------------------------------------
  // A brief is written once, at hire time, and then the room moves on without
  // it. Two hundred events later it is describing a project that no longer
  // exists, and it is still riding on every call — the recruit is now being
  // actively misinformed, at a cost, on every question.
  //
  // Recompacting is a rewrite, and a rewrite needs judgement about what is
  // superseded, which is exactly what a chair has and a tool does not. So this
  // tool makes no provider call of its own. It gathers the material — the
  // current brief, and the channel since the last compaction — and hands it
  // back with the instruction. The chair writes the new brief and calls
  // brief_update. The tool is the filing clerk, not the author.

  const compactionOf = (name) => store.readCompaction(name) || { events_at: 0, at: null };

  function briefStaleness(name) {
    const mark = compactionOf(name);
    const total = store.eventCount();
    const since = Math.max(0, total - Number(mark.events_at || 0));
    return {
      events_since: since,
      events_total: total,
      last_compacted_at: mark.at || null,
      threshold: BRIEF_STALE_EVENTS,
      stale: since > BRIEF_STALE_EVENTS
    };
  }

  // What of the channel is this recruit's business: things they said, things
  // said to them, and the chair's decisions, which are everybody's business.
  const relevantTo = (name) => (e) => {
    const author = String(e.author || '');
    if (author === name || author === `audition:${name}`) return true;
    if (author === 'chair' || e.role === 'user') return true;
    return new RegExp(`@${name}\\b`).test(String(e.text || ''));
  };

  function briefCompact({ name, max_words = BRIEF_COMPACT_WORDS, mark = true } = {}) {
    const n = strip(name || '');
    if (!store.readPersona(n)) return fail(`no recruit named "${n}" — recruit() first`);
    const current = store.readBriefing(n);
    if (!current) {
      return fail(
        `@${n} has no onboarding brief to compact — write their first one with brief_update({name:"${n}", briefing})`
      );
    }

    const state = briefStaleness(n);
    const since = store.eventsFrom(state.events_total - state.events_since).filter(relevantTo(n));
    const rendered = since.length
      ? since.map((e) => `[${e.ts || '?'}] ${e.author || '?'}${e.role === 'error' ? ' (error)' : ''}: ${String(e.text || '').slice(0, 400)}`).join('\n')
      : '(nothing in the channel concerned them since the last compaction)';

    const instruction = [
      `Rewrite @${n}'s onboarding brief. You are the author; this tool called no model.`,
      '',
      `Rules:`,
      `1. ${max_words} words maximum. Shorter is better; a brief nobody can hold in their head is not a brief.`,
      `2. DROP anything the events below supersede — a decision that was reversed, a state that has moved on,`,
      `   a codename that was renamed. Superseded facts are worse than missing ones: they are believed.`,
      `3. KEEP the five sections: project and goal, current state, decisions taken (and why, in a clause),`,
      `   glossary, and what this seat is for.`,
      `4. Do not invent. If the events leave something unclear, say it is unclear.`,
      `5. Write the replacement in full — brief_update replaces wholesale, it does not patch.`,
      '',
      `When the draft is ready: brief_update({name: "${n}", briefing: <the full text>}).`
    ].join('\n');

    if (mark) {
      store.writeCompaction(n, { events_at: state.events_total, at: new Date().toISOString() });
    }

    return {
      ok: true,
      name: n,
      max_words,
      briefing: current,
      events_since: state.events_since,
      events_considered: since.length,
      stale: state.stale,
      instruction,
      material: { briefing: current, events: since },
      text: [
        instruction,
        '',
        `=== CURRENT BRIEF (rev ${store.briefingRevision(n)}, ${current.trim().split(/\s+/).length} words) ===`,
        current.trim(),
        '',
        `=== CHANNEL SINCE LAST COMPACTION (${since.length} of ${state.events_since} events concern @${n}) ===`,
        rendered
      ].join('\n')
    };
  }

  function showBriefing({ name, revision } = {}) {
    const n = strip(name || '');
    if (!store.readPersona(n)) return fail(`no recruit named "${n}"`);
    const cur = store.briefingRevision(n);
    if (revision !== undefined && revision !== null && revision !== '') {
      const want = Number(revision);
      const text = store.readBriefingRevision(n, want);
      if (text === null) return fail(`no briefing revision ${revision} for @${n} — current is rev ${cur}`);
      return { ok: true, name: n, revision: want, current: cur, briefing: text, text };
    }
    const text = store.readBriefing(n);
    if (!text) return fail(`@${n} has no onboarding brief — write one with brief_update({name, briefing})`);
    return { ok: true, name: n, revision: cur, current: cur, briefing: text, text };
  }

  // --- pins ------------------------------------------------------------------
  // Standing room context. Deliberately small: a pin board that grows without
  // limit is a second system prompt nobody reads, paid for on every call, so
  // the budget refuses rather than silently truncating.
  function pinsList() {
    const list = store.readPins();
    const used = pinsUsed(list);
    if (!list.length) {
      return {
        ok: true, pins: [], used: 0, budget: PIN_BUDGET_CHARS,
        text: `No pins. pin({text}) adds standing context every recruit sees (budget ${PIN_BUDGET_CHARS} chars).`
      };
    }
    const rows = list.map((p) =>
      `${p.id} · ${p.__scope}${p.by ? ` · ${p.by}` : ''} · ${String(p.text).trim()}`
    );
    rows.push(`— ${list.length} pin(s), ${used}/${PIN_BUDGET_CHARS} chars used`);
    return { ok: true, pins: list, used, budget: PIN_BUDGET_CHARS, text: rows.join('\n') };
  }

  function pin({ text, by, scope = 'global' } = {}) {
    if (typeof text !== 'string' || !text.trim()) return fail('pin needs `text`');
    const clean = text.trim();
    const existing = store.readPins();
    const used = pinsUsed(existing);
    if (used + clean.length > PIN_BUDGET_CHARS) {
      return fail(
        `pin refused: ${used} of ${PIN_BUDGET_CHARS} chars already pinned and this one is ${clean.length} more ` +
        `(${used + clean.length} total). Every recruit pays for the pin board on every call. ` +
        `Unpin something with unpin({id}) — see pins() — or shorten this pin to ` +
        `${Math.max(0, PIN_BUDGET_CHARS - used)} chars or fewer.`
      );
    }

    const root = store.pinRootFor(scope);
    const mine = store.readPinsIn(root);
    const id = `p${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 900 + 100)}`;
    const entry = { id, ts: new Date().toISOString(), by: by || 'chair', text: clean };
    store.writePinsIn(root, [...mine, entry]);

    store.appendEvent({ host, author: 'chair', role: 'user', text: `pinned (${id}): ${clean}` });
    const left = PIN_BUDGET_CHARS - (used + clean.length);
    return {
      ok: true, id, pin: entry, used: used + clean.length, budget: PIN_BUDGET_CHARS,
      text: `Pinned ${id}${scope === 'project' ? ' (project)' : ''}. ` +
            `Every recruit now sees it under "${PINS_HEADER}" — ${used + clean.length}/${PIN_BUDGET_CHARS} chars used, ${left} left.`
    };
  }

  function unpin({ id } = {}) {
    if (typeof id !== 'string' || !id.trim()) return fail('unpin needs an `id` — see pins()');
    for (const root of store.pinRoots()) {
      const mine = store.readPinsIn(root);
      const hit = mine.find((p) => p.id === id);
      if (!hit) continue;
      store.writePinsIn(root, mine.filter((p) => p.id !== id));
      store.appendEvent({ host, author: 'chair', role: 'user', text: `unpinned (${id}): ${hit.text}` });
      const used = pinsUsed(store.readPins());
      return {
        ok: true, id, removed: hit, used, budget: PIN_BUDGET_CHARS,
        text: `Unpinned ${id} ("${String(hit.text).slice(0, 60)}"). ${used}/${PIN_BUDGET_CHARS} chars used.`
      };
    }
    return fail(`no pin with id "${id}" — run pins() to see them`);
  }

  // --- dismiss ---------------------------------------------------------------
  function dismiss({ name }) {
    const n = strip(name);
    if (!store.readPersona(n)) return fail(`no recruit named "${n}"`);
    const dest = store.archive(n);
    return { ok: true, archived: dest, text: `Dismissed @${n}. Archived at ${dest}` };
  }

  // --- events ----------------------------------------------------------------
  const events = {
    append: (e) => store.appendEvent({ host, ...e }),
    tail: (n) => store.tailEvents(n),
    path: () => `${store.stateDir}/events.jsonl`
  };

  return {
    recruit, ask, discuss, audition, evaluateRole, localModels, roster, dismiss, events,
    showPersona, updatePersona, rollbackPersona,
    briefUpdate, showBriefing, briefCompact, briefStaleness,
    pin, unpin, pins: pinsList,
    assignTask, taskStatus, decideTask, cancelTask, execution,
    spend: spendReport,
    budget,
    callBudget,
    maxCalls: callBudget.maxCalls,
    overBudget: () => !!overBudget(),
    host, stateDir: store.stateDir, projectDir,
    digestSource: digest,
    provider: () => prov().name,
    store
  };
}

const fail = (text) => ({ ok: false, error: text, text });

export { providerName, NAME_RE, DEFAULT_STATE_DIR };
export default { createRoom };
