# Hosts, wiring and state

Everything about *plugging a hired teammate in warm*: what they receive on each
call, how each host is wired, how local models are discovered, and what is
written where. [`HIRING.md`](HIRING.md) covers how they were hired in the first
place.

## What a teammate sees

Every `ask` and every `discuss` round hands the model the same six things, in
this order:

```
1  system   persona system prompt + room rules + solo rule + their autonomy rule
2  system   ONBOARDING BRIEF:                                 ← if they have one
3  system   PINNED ROOM CONTEXT:                              ← if anything is pinned
4  system   CHANNEL TRANSCRIPT (most recent last):
5  user/assistant × 10   their own history with the room
6  user     the message
```

Blocks 2 and 3 are what make a teammate start **warm**. A model hired into a
running project and handed only a persona will answer a generic version of the
question; the brief tells it what the project is and what has already been
decided, and the pin board tells it what is still standing.

Each block is **named and fenced**, and the names are not decoration. A model
reading four undifferentiated system messages has to infer which one wins when
they disagree, and it usually infers "the most recent" — which is the
transcript, the least authoritative thing in the stack. So the pin block says
outright that it takes precedence and the transcript block says outright that it
is background. Focused items first, ambient context last.

Each block is also built and guarded **independently**: a corrupt pin board on
disk should still leave the brief intact, and a brief that fails to read should
still leave the transcript. Before that, one throwing read took the whole call
down and the chair saw a null-property error where it expected an answer.

`audition` is deliberately outside this path — it probes a model, not a
colleague, so it gets none of it.

### The channel digest

The digest is the last ~6000 chars of the channel. Since the artifacts worth
seeing live in tool results — a stack trace, a failing assertion, a diff — each
tool call contributes its `[tool: name]` marker *and* an excerpt of what it
returned:

```
CLAUDE: [tool: Bash]
  ⤷ result: TypeError: Cannot read properties of undefined (reading 'tenantId')
          at resolveTenant (/srv/app/services/estoque.js:118:24)… (+212 more chars)
```

Excerpts are capped at 400 chars each and at 40% of the window in total, so the
conversation is never crowded out; over budget, the oldest excerpts are dropped
first while their markers stay. Binary and base64 payloads are skipped.

Digest sources are picked automatically from the host, and can be overridden
with `ROOM_HOST=claude-code|codex|event-log`:

| source | reads |
|---|---|
| `claude-code` | `~/.claude/projects/<slug>/*.jsonl` |
| `codex` | `~/.codex/sessions/**/rollout-*.jsonl` |
| `event-log` | `<state>/events.jsonl` — the room's own channel |

### Pins

```js
room.pin({ text: 'We ship Postgres, not Dynamo.', by: 'ashar' });
room.pins();                       // ids, scopes, budget used
room.unpin({ id });
```

Standing room context — decisions with a long half life, pinned once instead of
repeated to each teammate in turn. Global pins live in `<state>/pins.json`; a
project may add its own in `<project>/.room/pins.json`, and the two **stack**
(unlike recruits, where a project entry shadows the global one).

The board is capped at **2000 characters across every scope**, and `pin` refuses
past the cap rather than truncating: every teammate pays for the board on every
call, so a board that can grow without limit is a second system prompt nobody
agreed to. The refusal names both ways out — unpin something, or shorten this.

### Teammates talking to each other

```js
await room.discuss({ names: ['alice', 'bob'], topic: 'shard the orders table?', rounds: 2 });
```

Round 1 is each teammate's opening position; every later round hands each of
them the previous round's replies, attributed by name, and asks them to push
back or refine. Returns the usual `[name · model · $cost]` blocks grouped under
`— round N —` separators, plus `blocks: [{name, model, cost, reply, round}]`.
One call per teammate per round, so a 3×3 is nine calls. A teammate that errors
in one round does not stop the others, and the budget stops the discussion
between rounds rather than mid-fan-out.

## Claude Code

A room you have to remember to use is a room you forget to use. From the project
you want to wire:

```sh
node /path/to/teambrrr/adapters/claude/setup.mjs      # --dry-run to preview
```

Idempotent. It creates or updates `.mcp.json` and `.claude/settings.json`,
preserving unrelated MCP servers, settings and hooks, and registers the TeamBrrr
MCP server plus `SessionStart`, `UserPromptSubmit` and `Stop`. Legacy
`persona-recruiter` entries and owned hook paths are migrated in place so the
server and hooks are never registered twice. Restart Claude Code or reload MCP
after changing the wiring.

The installer deliberately does **not** touch skills — it owns only the MCP
entry and its three hook paths. Copy `skills/room/` into `~/.claude/skills/` (or
`<project>/.claude/skills/`) yourself to load the chair's recruiting etiquette.

| Hook | What it does |
|------|--------------|
| `session-start.mjs` | Before the first prompt, injects `additionalContext`: "Room active", one roster line per teammate (`name · model · tags`), and the pin board. **Silent when there are no recruits** — an empty room costs an empty session nothing. |
| `user-prompt-submit.mjs` | Writes the session pointer the digest depends on; routes `@mentions` to the `ask` tool; appends `[room] recruits: a, b · pins: N`; re-injects the pin board **only when it changed** since the last injection (hash tracked in `<cwd>/.room/session.json`); delivers and clears the watch inbox. |
| `stop.mjs` | Asks every teammate with `watch: true` to review the turn that just ended. Honours `stop_hook_active` before anything that could spend, skips entirely over the budget cap, and **never blocks**. |

All three exit 0 unconditionally: a hook that throws is a hook that breaks the
user's prompt.

### Watchers, and why the comment arrives one turn late

`recruit({..., watch: true})` puts a teammate on watch. At Stop they are shown
the chair's last turn and asked for a material concern in ≤80 words, or the
single word `PASS`; anything that is not a PASS is appended to
`<cwd>/.room/watch-inbox.md`, and the `UserPromptSubmit` hook injects and clears
it on the next prompt — delivered exactly once.

The detour through a file is deliberate. Per the
[hooks docs](https://code.claude.com/docs/en/hooks), only `UserPromptSubmit`,
`UserPromptExpansion` and `SessionStart` have their stdout added as context
Claude can see, and the only decision control documented for `Stop` is
`{decision: "block", reason}` — which forces Claude to keep working. That is the
wrong shape for an advisory note, so the inbox is the delivery path and the Stop
hook writes nothing to stdout at all.

It costs one call per watcher per turn. `update_persona({name, watch: false})`
turns it off.

## Codex

```sh
node adapters/codex/setup.mjs                 # --dry-run to preview
```

Idempotent, backs up `config.toml`, and never touches other `[mcp_servers.*]`
entries. New installations use `[mcp_servers.teambrrr]`; an existing legacy
`[mcp_servers.persona-recruiter]` entry stays valid and is not duplicated. Then
paste `adapters/codex/agents-snippet.md` into your `AGENTS.md` — hooks are
Claude Code only, so the Codex model watches for `@name` itself.

## hermes / OpenClaw

hermes has no MCP hop and no transcript file, so it imports the core directly
and uses the room's own `events.jsonl` as the channel:

```js
import { createRoom } from './core/room.mjs';
import { createEventLogSource } from './core/digest/event-log.mjs';

const room = createRoom({ host: 'hermes', digestSource: createEventLogSource(process.env.ROOM_STATE_DIR) });
room.events.append({ author: 'user', role: 'user', text: 'ship the migration today?' });
const { text, blocks } = await room.ask({ name: 'reviewer', message: 'ship the migration today?' });
```

Call `room.pins()` and `room.showPersona()` when building a turn, and drive
watchers from the engine loop rather than from a Stop event, since there isn't
one. Briefs and pins ride on every provider call regardless of host, because
they live in the core.

Conversation and execution stay separate on purpose. The chair assigns a durable
task; a hermes or OpenClaw worker claims it under the teammate's stable
`room-recruit:<name>` identity, reports progress, pauses for approvals, and
returns a receipt. The room is the control plane, not a shell: it never executes
model output and never widens the worker's runtime permissions. See
[`EXECUTION_BRIDGE.md`](EXECUTION_BRIDGE.md) and
[`../adapters/hermes/README.md`](../adapters/hermes/README.md).

`export_hermes` is a separate, optional path: a profile snapshot (SOUL.md,
profile.yaml, config.yaml, .env) so a teammate can execute under hermes' own
guardrails. It is not live continuity, it refuses to overwrite an existing
profile or a retirement tombstone, and it never copies your API key.

## Slack

`adapters/slack/bot.mjs` runs the room in a channel over Socket Mode. It never
reads channel history — the room's own event log is the memory — posts one reply
per teammate with `username` + `icon_emoji` overrides, threads correctly, and
never answers itself. **The adapter is written and tested against a fake
transport; the Slack app in the manifest has never been submitted, so the live
socket path is unproven.** Setup, scopes and the manifest are in
[`../adapters/slack/README.md`](../adapters/slack/README.md).

## Local models

Models running on your own machine are candidates like any other — discovered,
auditioned, ranked, offered and hired by the same code as an OpenRouter model.
The only differences are the namespace and the price. Two hosts are built in,
both OpenAI-compatible and neither needing an API key:

| Host | Default endpoint | Catalogue | Resident check | Start it with |
|---|---|---|---|---|
| `ollama` | `http://127.0.0.1:11434` | `/api/tags` | `/api/ps` | `ollama serve` |
| `llama-server` | `http://127.0.0.1:8080` | `/v1/models` | up == loaded | your llama.cpp start script |

Model ids are namespaced `local/<host>/<model>`, so an id is self-describing
everywhere it travels — persona files, the spend ledger, offer cards, the
transcript. Override the endpoints with `ROOM_OLLAMA_URL` /
`ROOM_LLAMA_SERVER_URL`, or in `<state>/config.json`, which can also add hosts
of your own (any OpenAI-compatible server; `/v1/models` and
`/v1/chat/completions` are all that is required):

```json
{ "local_hosts": { "gpu-box": { "base_url": "http://10.0.0.9:9000", "start_command": "ssh gpu-box start" } } }
```

`include_local` adds the discovered field to the candidates you named;
`local_only` drops everything else. Both work on `audition` and `evaluate_role`.
Embedding-only models are never put in front of a role, and `local_models`
reports the hosts without probing anything.

**When the server is down.** Not running is the ordinary state of a local host,
not an error. Discovery says so and names the command that would fix it. You may
hire against a host that is not running — the teammate persists like any other,
and the hire text says the server is down. What happens on a call then depends
on one thing: a local teammate hired **with** a `fallback_model` falls back to
it, and one hired without reports the server-down message rather than silently
spending money remotely.

**GPU contention.** Only one big model runs well at a time on a single GPU;
measured here, decode collapses from ~80 tok/s to ~2.4 tok/s under contention.
Before a local probe or hire the room asks each host what it currently holds
and, if a second heavyweight would contend, attaches a warning to the offer or
the hire. It is advisory and always will be — the room never unloads, evicts or
kills anything on your machine.

**Spend.** A local call costs exactly `0` — as a number, not as an absent price
— and goes through the same ledger as a paid one, so "free" is something you can
audit rather than something the accounting quietly skips.

## State

Global `~/.room/` (override: `ROOM_STATE_DIR`):

```
recruits/<name>/{persona.json,history.jsonl}   .dismissed/
recruits/<name>/revisions/<n>.json             ← superseded personas
recruits/<name>/briefing.md                    ← current onboarding brief
recruits/<name>/briefings/<n>.md               ← superseded briefs
pins.json          ← standing room context (project overlay STACKS, not shadows)
spend.json         ← the persisted ledger the dollar cap reads
spend-log.jsonl    ← per-call attribution: {who, why, cost, ts}
events.jsonl       models-cache.json
execution/         ← durable tasks: tasks/<id>.json, events.jsonl, index.json
config.json        ← optional: { "local_hosts": { "<host>": { "base_url": … } } }
```

Per session, in the project: `<cwd>/.room/session.json` (transcript pointer plus
the hash of the pin board last injected) and `<cwd>/.room/watch-inbox.md`
(undelivered watcher comments).

A project can shadow a teammate by name by defining it in `<project>/.room/`.
Legacy `<project>/.claude/recruits/` is migrated on first run — files are
copied, never moved, and a `.migrated` marker prevents a repeat.

The roster, spend ledger and event log are **global to the state directory**.
There are no room or tenant identifiers yet: this is right for one trusted user,
not for separate teams or unrelated Slack channels. See
[`ENTERPRISE_ROADMAP.md`](ENTERPRISE_ROADMAP.md).

## Environment

| Variable | Default | What it does |
|---|---|---|
| `OPENROUTER_API_KEY` | — | The key. Falls back to `~/.claude/.openrouter_key`, since GUI hosts do not inherit shell env. Unset ⇒ the deterministic mock provider. |
| `PERSONA_RECRUITER_BUDGET_USD` | `1.00` | Dollar ceiling, read fresh from `spend.json` so it survives a restart. |
| `PERSONA_RECRUITER_BUDGET_CALLS` | `200` | Call ceiling per room process. |
| `PERSONA_RECRUITER_PROVIDER` | — | Set to `mock` to force the offline provider. |
| `ROOM_STATE_DIR` | `~/.room` | Where the roster, ledger and event log live. |
| `ROOM_HOST` | per adapter | Overrides the digest source pick. |
| `ROOM_OLLAMA_URL` / `ROOM_LLAMA_SERVER_URL` | see above | Local host endpoints. |
| `ROOM_ROLE_PACK_DIR` | bundled `role-packs/` | Where `evaluate_role` looks for packs. |
| `PERSONA_RECRUITER_CWD` | `process.cwd()` | Project dir the MCP server treats as the overlay root. |

The `PERSONA_RECRUITER_*` names are intentionally unchanged by the rebrand;
renaming them would break GUI launches and existing deployments.

## Library surface

```js
createRoom({ stateDir, projectDir, digestSource, provider, priceFor, host,
             budget, maxCalls, judgeProvider, judgeModels, executionBridge,
             localDiscovery, localContentionFn, rolePackDir, maxDigestChars,
             retryDelayMs, autoMigrate })
```

Every one of those is injectable, which is what keeps the test suite hermetic:
a test supplies its own provider, its own judge provider, its own local
discovery and its own `stateDir`, and nothing reaches the network or `~/.room`.

returns `{ recruit, ask, discuss, audition, evaluateRole, localModels, roster,
dismiss, events, showPersona, updatePersona, rollbackPersona, briefUpdate,
showBriefing, briefCompact, briefStaleness, pin, unpin, pins, assignTask,
taskStatus, decideTask, cancelTask, execution, spend, budget, callBudget,
maxCalls, overBudget, host, stateDir, projectDir, digestSource, provider,
store }`.

Every call returns `{ ok, text, ... }`. `ask` and `discuss` also return
`blocks: [{name, model, cost, reply}]`; `audition` returns `rows` (plus `offers`
when given a `role`); `evaluateRole` returns repeated-trial evidence plus
offers; the persona calls return `persona` and `revisions`.

`core/` is plain ESM with no third-party runtime dependencies — only the MCP
adapter needs the SDK, and it lives in `server/`. The Slack adapter's
`@slack/bolt` is declared in `adapters/slack/package.json` and installed there
only, so the MCP server stays dependency-light.
