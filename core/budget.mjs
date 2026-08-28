// CallBudget: one shared ceiling for everything the room spends.
//
// The room used to check "am I over the dollar cap?" once, at the top of ask()
// or discuss(), and then fan out N calls in parallel. That is a preflight, not a
// budget: a room sitting one cent under the cap could still dispatch a whole
// batch and land well past it — the overshoot-by-one-batch gap. It also had no
// opinion at all about how MANY calls were made, so a runaway loop of free
// models cost nothing and was therefore invisible.
//
// A CallBudget fixes both. There is exactly one instance per room process, and
// every provider call site must take a ticket BEFORE it calls:
//
//   const ticket = await budget.consume('alice', 'ask');   // throws BudgetExhausted
//   try { ...call... } finally { ticket.settle(actualCost); }
//
// consume() reserves the estimated cost up front, so a parallel batch cannot
// collectively exceed the cap; settle() releases the reservation, records the
// real cost, and wakes anything queued behind it. Two ceilings apply:
//
//   calls   — how many provider calls this process may make (default 200)
//   dollars — how much may be spent, read from the persisted ledger so the cap
//             survives a restart (default $1.00, PERSONA_RECRUITER_BUDGET_USD)
//
// Every settled ticket is written to an attribution log — {who, why, cost, ts} —
// which is what makes `spend` able to answer "where did the money go" rather
// than only "how much is left".

export const DEFAULT_MAX_CALLS = 200;
export const DEFAULT_MAX_USD = 1.00;

// A call whose price we cannot estimate reserves everything that is left, which
// serialises it: one unpriced call in flight at a time, and only while at least
// this much remains. That bounds a missing price to a single call instead of
// letting an entire parallel field run past the cap on a guess.
export const UNPRICED_FLOOR_USD = 0.01;

export class BudgetExhausted extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'BudgetExhausted';
    this.code = 'budget_exhausted';
    this.kind = detail.kind || 'usd';   // 'usd' | 'calls'
    Object.assign(this, detail);
  }
}

export const isBudgetExhausted = (e) => e instanceof BudgetExhausted || e?.code === 'budget_exhausted';

export function maxCallsFromEnv(env = process.env) {
  const n = Number(env.PERSONA_RECRUITER_BUDGET_CALLS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_CALLS;
}

export function maxUsdFromEnv(env = process.env) {
  const n = Number(env.PERSONA_RECRUITER_BUDGET_USD);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_USD;
}

// A deliberately conservative estimate: two characters per prompt token, and
// the full completion allowance assumed spent. Over-reserving costs nothing but
// a little parallelism; under-reserving costs money.
export function estimateCallCost({ messages, params, price, defaultMaxTokens = 1000 } = {}) {
  const input = Number(price?.prompt);
  const output = Number(price?.completion);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  if (input === 0 && output === 0) return 0;
  const chars = (messages || []).reduce((n, m) => n + String(m?.content || '').length, 0);
  const promptTokens = Math.ceil(chars / 2);
  const completionTokens = Math.max(1, Number(params?.max_tokens || defaultMaxTokens));
  return promptTokens * input + completionTokens * output;
}

export function createCallBudget({
  maxCalls = maxCallsFromEnv(),
  maxUsd = maxUsdFromEnv(),
  // The persisted total, read fresh on every check: the dollar ceiling is a
  // property of the ledger on disk, not of this process.
  spent = () => 0,
  // Where a settled ticket goes. Injected so tests never write to a real ~/.room.
  record = () => {},
  hint = '',
  unpricedFloorUsd = UNPRICED_FLOOR_USD,
  now = () => new Date().toISOString()
} = {}) {
  let calls = 0;
  let reserved = 0;
  const waiters = [];
  const wake = () => { while (waiters.length) waiters.shift()(); };

  const spentUsd = () => Number(spent() || 0);
  const remainingUsd = () => maxUsd - spentUsd() - reserved;
  const remainingCalls = () => Math.max(0, maxCalls - calls);

  const usdMessage = () =>
    `session spend cap reached: $${spentUsd().toFixed(4)} of $${maxUsd.toFixed(2)}.` +
    (hint ? ` ${hint}` : '');
  const callsMessage = () =>
    `session call ceiling reached: ${calls} of ${maxCalls} calls. ` +
    `Raise PERSONA_RECRUITER_BUDGET_CALLS, or start a new room process.`;

  // The cheap preflight the room asks before it even builds a request. Returns
  // null when there is room, or the error that would be thrown.
  function exhausted() {
    if (calls >= maxCalls) return new BudgetExhausted(callsMessage(), { kind: 'calls', calls, maxCalls });
    if (maxUsd - spentUsd() <= 0) {
      return new BudgetExhausted(usdMessage(), { kind: 'usd', spent: spentUsd(), cap: maxUsd });
    }
    return null;
  }

  // Take a ticket for one provider call.
  //
  //   estimate  a number  — reserve exactly that much (0 for a free or local model)
  //             null      — price unknown: reserve everything left, and refuse
  //                         outright below the unpriced floor
  //   wait      true      — queue behind other reservations instead of failing,
  //                         used by fan-outs that would rather run slowly than
  //                         drop trials
  async function consume(who, why, { estimate = 0, wait = false } = {}) {
    const who_ = String(who || 'unknown');
    const why_ = String(why || 'call');
    for (;;) {
      if (calls >= maxCalls) {
        throw new BudgetExhausted(callsMessage(), { kind: 'calls', who: who_, why: why_, calls, maxCalls });
      }
      const left = maxUsd - spentUsd();
      if (left <= 0) {
        throw new BudgetExhausted(usdMessage(), { kind: 'usd', who: who_, why: why_, spent: spentUsd(), cap: maxUsd });
      }
      const free = remainingUsd();
      if (estimate === null && left < unpricedFloorUsd) {
        throw new BudgetExhausted(
          `less than $${unpricedFloorUsd.toFixed(2)} remains and this model has no validated price; ` +
          `refusing an unreserved call`,
          { kind: 'usd', who: who_, why: why_, spent: spentUsd(), cap: maxUsd }
        );
      }
      // An unpriced call reserves everything the cap has left — not everything
      // currently free — so it can never run beside another unpriced one.
      const want = estimate === null ? left : Math.max(0, Number(estimate) || 0);
      if (want <= free) {
        calls += 1;
        reserved += want;
        return ticket(who_, why_, want);
      }
      // Nothing is in flight, so waiting cannot help: the call itself is too big.
      if (!wait || reserved <= 0) {
        throw new BudgetExhausted(
          `estimated call cost $${want.toFixed(4)} exceeds the remaining $${Math.max(free, 0).toFixed(4)} budget`,
          { kind: 'usd', who: who_, why: why_, spent: spentUsd(), cap: maxUsd }
        );
      }
      await new Promise((resolve) => waiters.push(resolve));
    }
  }

  function ticket(who, why, held) {
    let settled = false;
    return {
      who, why, reserved: held,
      settle(cost, extra = {}) {
        if (settled) return null;
        settled = true;
        reserved = Math.max(0, reserved - held);
        const entry = { ts: now(), who, why, cost: Number(cost) || 0, ...extra };
        try { record(entry); } catch {}
        wake();
        return entry;
      }
    };
  }

  return {
    consume,
    exhausted,
    maxCalls,
    maxUsd,
    unpricedFloorUsd,
    calls: () => calls,
    reserved: () => reserved,
    remainingUsd: () => Math.max(0, maxUsd - spentUsd()),
    remainingCalls,
    snapshot: () => ({
      calls, max_calls: maxCalls, spent: spentUsd(), cap: maxUsd,
      reserved, remaining_usd: Math.max(0, maxUsd - spentUsd()), remaining_calls: remainingCalls()
    })
  };
}

export default { createCallBudget, BudgetExhausted, estimateCallCost };
