# persona-recruiter

A Slack-like room for your agent sessions: recruit named personas backed by
OpenRouter models, then address them mid-conversation with `@name`. The host's
agent stays the chair; recruits are reachable only through explicit room tools.
The same surface covers conversation (`ask`, `discuss`), evidence-based hiring
(`audition`, `evaluate_role`), durable work (`assign_task`, `tasks`, approvals),
and execution-host handoff. Each recruit receives
a digest of the shared channel — conversation *and* an excerpt of what came back
from each tool call — so they answer as if they were in the room.

The roster is **global** — one team, reachable from every host, with shared
history and one spend cap.

## Architecture

```
                 hosts                          adapters              core
  ┌──────────────────────────┐        ┌──────────────────────┐   ┌─────────────┐
  │ Claude Code  (skill+hook)│──MCP──▶│ server/index.mjs     │──▶│             │
  │ Codex CLI    (AGENTS.md) │──MCP──▶│ (same stdio server)  │   │  room.mjs   │
  │ hermes-agent             │────────│ import { createRoom }│──▶│  ┌────────┐ │
  │ Slack (Socket Mode)      │────────│ adapters/slack/bot   │   │  │provider│ │
  │ cron / …                 │────────│ execution workers    │   │  │ state  │ │
  └──────────────────────────┘        └──────────────────────┘   │  │ digest │ │
                                                                 │  │eval/task│ │
   digest sources (auto-picked)                                  │  └────────┘ │
     claude-code  ~/.claude/projects/<slug>/*.jsonl              └──────┬──────┘
     codex        ~/.codex/sessions/**/rollout-*.jsonl                  │
     event-log    <state>/events.jsonl  ← room's own channel     ┌──────▼──────┐
                                                                 │   ~/.room   │
                                                                 │  recruits/  │
                                                                 │  events.jsonl│
                                                                 │  spend.json │
                                                                 │  execution/ │
                                                                 └─────────────┘
```

`core/` is plain ESM with no dependencies; only the MCP adapter needs the SDK.

## Hosts

| Host        | Wiring                                        | @mention routing         | Digest source | Status |
|-------------|-----------------------------------------------|--------------------------|---------------|--------|
| Claude Code | `.mcp.json` + three hooks + skill              | hook injects the routing | `claude-code` | live   |
| Codex CLI   | `~/.codex/config.toml` + `AGENTS.md` snippet  | the model watches for it | `codex`       | live   |
| hermes/OpenClaw | direct import via `adapters/execution` + optional Hermes profile export | runtime subscribes/claims tasks | `event-log` | live control-plane foundation: durable tasks, leases, progress, approvals and results; the execution host still owns tools and policy. See [`docs/EXECUTION_BRIDGE.md`](docs/EXECUTION_BRIDGE.md). |
| Slack       | `adapters/slack/bot.mjs` (Socket Mode, Bolt)  | adapter parses `@name`   | `event-log`   | **app creation pending** — adapter written and tested against a fake transport; the Slack app in the manifest has never been submitted, so the live socket is unproven. See [`adapters/slack/README.md`](adapters/slack/README.md). |

Override the pick with `ROOM_HOST=claude-code|codex|event-log`.

## What a recruit sees

Every `ask` and every `discuss` round hands the model the same six things, in
this order:

```
1  system   persona system prompt + room rules + the answer-only-as-yourself rule
2  system   ONBOARDING BRIEF (authored by the chair at hire time):     ← if they have one
3  system   PINNED ROOM CONTEXT:                                       ← if anything is pinned
4  system   CHANNEL TRANSCRIPT (most recent last):
5  user/assistant × 10   their own history with the room
6  user     the message
```

Blocks 2 and 3 are what make a recruit start **warm**. A model hired into a
running project and handed only a persona will answer a generic version of the
question; the brief tells it what the project is and what has already been
decided, and the pin board tells it what is still standing.

`audition` is deliberately outside this path — it probes a model, not a
colleague, so it gets neither.

### Onboarding briefs

```js
await room.recruit({ name, model, system_prompt, briefing: '...' });
room.briefUpdate({ name, briefing: '...' });   // re-onboard: rev 2, old kept
```

The brief is written by the hiring agent from everything it knows and the recruit
cannot see: project and goal, current state, decisions already taken, a glossary
of local codenames, and what the seat is for. It lives at
`recruits/<name>/briefing.md` and is versioned exactly like the persona —
`brief_update` snapshots the superseded copy to `briefings/<n>.md` and never
rewrites the chain. Memory is untouched by a re-brief.

A brief describes the project *at a moment*, so it goes stale faster than a
persona does. "Re-onboard @name" is routine maintenance, not a repair.

### Pins

```js
room.pin({ text: 'We ship Postgres, not Dynamo.', by: 'ashar' });
room.pins();                       // ids, scopes, budget used
room.unpin({ id });
```

Standing room context — decisions with a long half life, pinned once instead of
repeated to each recruit in turn. Global pins live in `<state>/pins.json`; a
project may add its own in `<project>/.room/pins.json`, and the two **stack**
(unlike recruits, where a project entry shadows the global one).

The board is capped at **2000 characters across every scope**, and `pin` refuses
past the cap rather than truncating: every recruit pays for the board on every
call, so a pin board that can grow without limit is a second system prompt nobody
agreed to. The refusal names both ways out — unpin something, or shorten this.

### The channel digest

The digest is the last ~6000 chars of the channel. Since artifacts live in tool
results — a stack trace, a failing assertion, a diff — each tool call
contributes its `[tool: name]` marker *and* an excerpt of what it returned:

```
CLAUDE: [tool: Bash]
  ⤷ result: TypeError: Cannot read properties of undefined (reading 'tenantId')
          at resolveTenant (/srv/app/services/estoque.js:118:24)… (+212 more chars)
```

Excerpts are capped at 400 chars each and at 40% of the window in total, so the
conversation is never crowded out; over budget, the oldest excerpts are dropped
first while their markers stay. Binary and base64 payloads are skipped.

## Recruits talking to each other

```js
await room.discuss({ names: ['alice', 'bob'], topic: 'shard the orders table?', rounds: 2 });
```

Round 1 is each recruit's opening position; every later round hands each of them
the previous round's replies, attributed by name, and asks them to push back or
refine. Returns the usual `[name · model · $cost]` blocks grouped under
`— round N —` separators, plus `blocks: [{name, model, cost, reply, round}]`.
One call per recruit per round, so a 3x3 is nine calls. A recruit that errors in
one round does not stop the others, and the cap stops the discussion between
rounds rather than mid-fan-out.

## Hiring by audition

```js
await room.audition({
  candidates: [{ model: 'a/one' }, { model: 'b/two', fallback_model: 'b/backup' }],
  role_prompt: 'a sceptical SRE who has seen this fail before'
});
```

One cheap probe per candidate, four in parallel, scored mechanically. The probe's
second half is a missing-context trap — *"also fix the bug in
services/estoque.js"*, a file that does not exist — which sorts the models that
say **"I don't have that file"** from the ones that invent a patch for it. Ranked
`honest` > `evasive` > `FABRICATED`, then by length discipline, latency and cost.

It hires nobody: you get a table and the raw replies, then call `recruit`.

### Role-specific evaluation packs

For recurring jobs, `evaluate_role` replaces the single generic probe with a
versioned evaluation pack: representative cases, repeated trials, explicit
failure criteria, and retained evidence.

```js
await room.evaluateRole({
  role_pack: 'sdr-outbound',
  candidates: [{ model: 'a/cheap' }, { model: 'b/balanced' }, { model: 'c/premium' }]
});
```

The repository includes SDR outbound, code-review, and security-review packs.
Scores use a weighted geometric mean, so a fatal weakness cannot be hidden by a
great score elsewhere. Results include variance, pass rate, latency, cost, and
the underlying trial evidence, followed by up to three selectable offers drawn
only from eligible candidates. Failed candidates stay visible in the evidence
but cannot be offered. Nobody is hired automatically. See
[`docs/ROLE_PACKS.md`](docs/ROLE_PACKS.md).

#### Budget limitation

The local `evaluateRole` reservation is a safety guard, not an atomic hard
spend ceiling. Reservations are scoped to one invocation/process and are based
on estimated cost. Concurrent processes can race on the shared ledger, and a
provider receipt can exceed an estimate; either case can exceed the remaining
local cap. Use provider or organization spending limits for production
protection. The enterprise roadmap tracks the required fix: atomically reserve
worst-case cost before dispatch and settle against provider receipts.

### Offers — what it costs to hire them

An audition ranks models. It does not answer the question the user asked, which
is *what will this cost me*. Pass a `role` and the same rows come back as 2-3
selectable cards with a monthly projection:

```js
await room.audition({ candidates, role_prompt, role: 'SDR', volume: 'advisor' });
```

```
Offers for "SDR" — volume advisor (30/day · 2k in / 500 out per exchange)

#1 sdr · deepseek/deepseek-chat · honest · $0.38/mo est · 1.2s · recommended
#2 sdr · meta-llama/llama-3.3-70b-instruct:free · honest · $0.00/mo (free tier — rate limits apply) · 2.4s
#3 sdr · anthropic/claude-3.7-sonnet · honest · $12.15/mo est · 0.9s · premium

fallbacks — #1 → meta-llama/... · #2 → google/... · #3 → deepseek/...
Nobody is hired yet. Pick a number and I will recruit them on that model.
```

Volume profiles are `advisor` (30/day · 2k in / 500 out — the default),
`worker` (300/day · 3k / 1k) and `heavy` (1500/day · 4k / 1k), or pass
`{per_day, tokens_in, tokens_out}`. Free models are never rendered as a bare
`$0.00` — the rate-limit caveat rides along, which is also why every card
carries a `fallback_model` (the next-ranked model, unless the candidate named
its own).

Two rules keep the cards honest. The **dearest model in the field is always
offered**, even when the audition outranked it — an audition scores honesty and
latency, so a $12/mo frontier model routinely places fourth behind three cheap
ones, and dropping it hides the trade-off the user is trying to make. And
`premium` is badged only on a real step up (2x the cheapest card, or paid
against free), so it never lands on $0.38-vs-$0.36.

`recommended` is the best-ranked card that was **honest** on the trap, not
simply rank 1. It is a suggestion; the user picks.

## Editing a recruit

The prompt you wrote before you saw someone work is rarely the prompt you want
afterwards, so the persona is editable — and therefore versioned.

```js
room.showPersona({ name: 'sdr' });                       // full prompt, never truncated
room.showPersona({ name: 'sdr', revision: 1 });          // what it used to say
await room.updatePersona({ name: 'sdr', system_prompt: '...' });   // -> rev 2
room.rollbackPersona({ name: 'sdr', revision: 1 });      // -> rev 3, carrying rev 1
```

Two invariants do the work:

**The chain is append-only.** An update snapshots the superseded persona to
`revisions/<n>.json` before writing. A rollback moves *forward* — it writes a new
revision carrying old content — so the revision you walked away from is still
there and you can walk back to it. Nothing is ever overwritten, so "what were
they told, and when" survives changing your mind twice.

**Memory is not collateral damage.** `history.jsonl` is untouched by every one of
these. Rewriting the brief does not erase the correspondence: the recruit keeps
every exchange across a rewrite, a rebind and a rollback.

`update_persona` is a partial update — fields you do not name are left alone —
and it never creates: a typo'd name is refused rather than quietly spawning a
half-specified recruit. `model` and `fallback_model` are validated against the
OpenRouter catalog exactly as `recruit` does, so a typo fails at the edit rather
than at the next `ask`. Personas written before revisions existed read as
revision 1 rather than crashing.

## Claude Code harness hooks

A room you have to remember to use is a room you forget to use. Three hooks in
`hooks/` make it present without being asked; register them in
`.claude/settings.json`:

```json
{ "hooks": {
  "SessionStart":     [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node …/hooks/session-start.mjs" }] }],
  "UserPromptSubmit": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node …/hooks/user-prompt-submit.mjs" }] }],
  "Stop":             [{                 "hooks": [{ "type": "command", "command": "node …/hooks/stop.mjs" }] }]
} }
```

| Hook | What it does |
|------|--------------|
| `session-start.mjs` | Before the first prompt, injects `additionalContext`: "Room active", one roster line per recruit (`name · model · tags`), and the pin board. **Silent when there are no recruits** — an empty room costs an empty session nothing. |
| `user-prompt-submit.mjs` | Writes the session pointer the digest depends on; routes `@mentions` to the `ask` tool; appends `[room] recruits: a, b · pins: N`; re-injects the pin board **only when it changed** since the last injection (hash tracked in `<cwd>/.room/session.json`); delivers and clears the watch inbox. |
| `stop.mjs` | Asks every recruit with `watch: true` to review the turn that just ended. Honours `stop_hook_active` before anything that could spend, skips entirely over the budget cap, and **never blocks**. |

All three exit 0 unconditionally: a hook that throws is a hook that breaks the
user's prompt.

### Watchers, and why the comment arrives one turn late

`recruit({..., watch: true})` puts a recruit on watch. At Stop they are shown the
chair's last turn and asked for a material concern in ≤80 words, or the single
word `PASS`; anything that is not a PASS is appended to
`<cwd>/.room/watch-inbox.md`, and the `UserPromptSubmit` hook injects and clears
it on the next prompt — delivered exactly once.

The detour through a file is deliberate. Per the
[hooks docs](https://code.claude.com/docs/en/hooks), only `UserPromptSubmit`,
`UserPromptExpansion` and `SessionStart` have their stdout added as context Claude
can see, and the only decision control documented for `Stop` is
`{decision: "block", reason}` — which forces Claude to keep working. That is the
wrong shape for an advisory note, so the inbox is the delivery path and this hook
writes nothing to stdout at all.

It costs one call per watcher per turn. `update_persona({name, watch: false})`
turns it off.

## Durable work and execution hosts

Conversation and execution are separate on purpose. The chair assigns a task;
a Hermes, OpenClaw, or other worker claims it under the recruit's stable
identity, reports progress, pauses for approvals, and returns a durable receipt.

```js
const assigned = await room.assignTask({
  name: 'sdr',
  title: 'Draft outreach for the approved account list',
  input: { instructions: 'Create drafts only. Do not send.' },
  idempotency_key: 'campaign-42:draft'
});

room.taskStatus({ task_id: assigned.task.id });
// After tasks() shows a pending approval requested by the worker:
room.decideTask({
  task_id: assigned.task.id,
  approval_id: 'approval_id_from_task_status',
  decision: 'approve',
  reason: 'Drafts only.'
});
room.cancelTask({
  task_id: assigned.task.id,
  reason: 'Campaign paused.',
  idempotency_key: 'campaign-42:cancel'
});
```

The room is the control plane, not a shell. It never executes model output or
widens the worker's runtime permissions. Direct-import workers subscribe, claim
leases, heartbeat, request approval, and complete or fail tasks through
`adapters/execution`. See [`docs/EXECUTION_BRIDGE.md`](docs/EXECUTION_BRIDGE.md).

### Other hosts

Hooks are Claude Code only. **Codex** gets the etiquette in `AGENTS.md`
(`adapters/codex/agents-snippet.md`) — the model watches for `@name` itself.
**hermes** harnesses the room by direct import in its engine loop: call
`room.pins()` and `room.showPersona()` when building a turn, and drive watchers
from the loop rather than from a Stop event, since there isn't one. Both still
get briefs and pins, because those live in core and ride on every provider call
regardless of host.

## State

Global `~/.room/` (override: `ROOM_STATE_DIR`):

```
recruits/<name>/{persona.json,history.jsonl}   .dismissed/
recruits/<name>/revisions/<n>.json             ← superseded personas
recruits/<name>/briefing.md                    ← current onboarding brief
recruits/<name>/briefings/<n>.md               ← superseded briefs
pins.json    ← standing room context (project overlay STACKS, not shadows)
spend.json   models-cache.json   events.jsonl
```

Per session, in the project: `<cwd>/.room/session.json` (transcript pointer plus
the hash of the pin board last injected) and `<cwd>/.room/watch-inbox.md`
(undelivered watcher comments).

A project can shadow a recruit by name by defining it in `<project>/.room/`.
Legacy `<project>/.claude/recruits/` is migrated on first run (files are copied,
never moved, and a `.migrated` marker prevents a repeat).

## Use it from hermes

```js
import { createRoom } from './persona-recruiter/core/room.mjs';
import { createEventLogSource } from './persona-recruiter/core/digest/event-log.mjs';

const room = createRoom({ host: 'hermes', digestSource: createEventLogSource(process.env.ROOM_STATE_DIR) });
room.events.append({ author: 'user', role: 'user', text: 'ship the migration today?' });
const { text, blocks } = await room.ask({ name: 'reviewer', message: 'ship the migration today?' });
```

`createRoom({ stateDir, projectDir, digestSource, provider, priceFor, host, budget, retryDelayMs, executionBridge, rolePackDir })`
returns `{ recruit, ask, discuss, audition, roster, dismiss, events,
showPersona, updatePersona, rollbackPersona, briefUpdate, showBriefing,
pin, unpin, pins, overBudget, evaluateRole, assignTask, taskStatus,
decideTask, cancelTask, execution }`. Every call returns
`{ ok, text, ... }`; `ask` and `discuss` also return
`blocks: [{name, model, cost, reply}]`, `audition` returns `rows` (plus `offers`
when given a `role`), `evaluateRole` returns repeated-trial evidence plus offers,
and the persona calls return `persona` and `revisions`.

## Set up Codex

```sh
node persona-recruiter/adapters/codex/setup.mjs        # --dry-run to preview
```

Idempotent, backs up `config.toml`, and never touches other `[mcp_servers.*]`
entries. Then paste `adapters/codex/agents-snippet.md` into your `AGENTS.md`.

## Run / test

```sh
npm test                                  # mock providers, no network
```

`smoke` drives the MCP adapter over stdio; `hooks` spawns each of the three
harness hooks as its own process with fixture stdin; `core`, `digest`,
`discuss`, `audition`, `offers`, `role-packs`, `execution`, `room-extensions`,
`persona`, `context`, `hermes` and `slack`
exercise the library directly. Every test injects its own provider and its own
`stateDir`, so no test calls OpenRouter or touches `~/.room` — and `hermes` runs
against a fixture hermes-home in scratch, never the live install.

`context` asserts the exact message layout a recruit receives (persona, brief,
pins, digest, history, message) rather than just that the files were written:
the failure worth catching is a refactor that quietly moves the brief after the
transcript.

Real use: `export OPENROUTER_API_KEY=sk-or-...` (or drop the key in
`~/.claude/.openrouter_key` — GUI hosts don't inherit shell env). Unset means the
mock provider. `PERSONA_RECRUITER_BUDGET_USD` configures the local spend budget
(default 1.00); see the budget limitation above before treating it as a strict
production ceiling.
Recruits on free-tier models should carry a `fallback_model`: on a 429 or 5xx the
room retries once, then once more on the fallback.

Deps live in `server/`; the top-level `node_modules` symlink points at them. The
Slack adapter's `@slack/bolt` is declared in `adapters/slack/package.json` and
installed there only, so the MCP server stays dependency-light.
Restart Claude Code / reload MCP after changing the wiring.
