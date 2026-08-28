# hermes adapter

Two separate things live here.

1. **Using the room from hermes** — hermes imports room-core directly and asks
   recruits questions, like any other host.
2. **The live task bridge** — binding the recruit's stable identity to a Hermes
   worker through `../execution/index.mjs`.
3. **The export bridge (Path B)** — optionally copying a hired recruit into a
   Hermes teammate profile.

---

## Live task bridge: one identity, external execution

Use `createExecutionWorker()` from `adapters/execution/index.mjs` inside the
Hermes work loop. The room assigns durable tasks; Hermes claims a lease, runs
only tools allowed by its own policy, reports progress, requests approvals, and
returns a receipt. This path preserves the room recruit's stable
`room-recruit:<name>` identity and is the continuity mechanism. See
[`../../docs/EXECUTION_BRIDGE.md`](../../docs/EXECUTION_BRIDGE.md).

The contract is fixture-tested, but has not yet completed a live Hermes tool
run. Profile export below remains useful for native Hermes UI/configuration; it
is a snapshot, not synchronized identity.

## Path B export: the room hires the brain, hermes runs the body

The room is good at one thing and deliberately bad at another.

It is good at **hiring and advising**: auditioning models against a probe that
catches fabrication, projecting what one would cost per month, keeping a named
persona with a durable point of view, and remembering every exchange you have
had with it.

It has **no execution**: no scheduler, no tools, no filesystem, no approval
prompts, no spend enforcement beyond a soft cap on its own calls. That is not an
oversight to be fixed later. hermes already has all of it — cron, an approvals
policy with a deny list and a command allowlist, per-task and per-day budget
ceilings, sandboxes, skills, a kanban board. Building a second execution runtime
inside a persona tool would mean reimplementing every one of those, badly, and
then owning the security surface twice.

So the seam is drawn where the two systems are each already strong:

```
   ┌──────────────────────── the room (persona-recruiter) ─────────────────────┐
   │                                                                           │
   │   audition ──▶ offers ──▶ [user picks] ──▶ recruit ──▶ ask / discuss       │
   │   4 models     cost/mo     AskUserQuestion   persona     advisory memory   │
   │   one probe    per card                      + history   in ~/.room        │
   │                                                                           │
   └───────────────────────────────────┬───────────────────────────────────────┘
                                       │
                                 export_hermes
                        (persona ──▶ SOUL.md + model pin)
                                       │
                                       ▼
   ┌──────────────────────── hermes-agent (Company OS) ────────────────────────┐
   │                                                                           │
   │   teammate ──▶ cron ──▶ tools ──▶ approvals ──▶ spend caps ──▶ work        │
   │   profile      schedules  real     deny list     per-task /    kanban,     │
   │   on disk                 side     + allowlist   per-day       branches    │
   │                           effects                                         │
   └───────────────────────────────────────────────────────────────────────────┘
```

**The room keeps hiring and memory. hermes keeps execution and guardrails.**
Nothing is moved: after an export the recruit is still in the room, still
`@mentionable`, still accumulating history there. The export is a copy of the
*brief*, not of the correspondence.

### Which side should a given job be on?

| The user wants… | Where |
|---|---|
| a second opinion, a design argument, a review of your reasoning | the room |
| a persona you talk to and refine over weeks | the room |
| "send this email every Monday" | hermes |
| anything with a tool call, a file write, or a branch | hermes |
| a model chosen on evidence and cost | the room, then export if it must execute |

---

## Usage

```sh
node adapters/hermes/export.mjs <name> --dry-run     # always do this first
node adapters/hermes/export.mjs <name>
```

```js
import { exportToHermes } from './adapters/hermes/export.mjs';
exportToHermes({ name: 'sdr', role: 'Outbound sales development', dryRun: true });
```

Or, from Claude Code, the MCP tool: `export_hermes({name, dry_run})`.

| Flag | Default |
|---|---|
| `--dry-run`, `-n` | off — prints every file in full, writes nothing |
| `--role "..."` | the recruit's tags |
| `--hermes-home PATH` | `$HERMES_HOME`, else `~/.company-os/hermes-home` |
| `--state-dir PATH` | `$ROOM_STATE_DIR`, else `~/.room` |
| `--template PATH` | the first existing profile's `config.yaml` |

## What it writes

Into `$HERMES_HOME/profiles/<name>/`, all mode `0600`, plus the nine empty
runtime directories hermes expects (`memories/`, `sessions/`, `skills/`, …):

| File | Why |
|---|---|
| `SOUL.md` | The system prompt — hermes injects it as a *real* system prompt, not a billed first turn. Carries the persona, the provenance line, and the pointer to the room history. |
| `profile.yaml` | The roster entry. `ui_meta.company` is the single flag that makes a profile a **teammate**; without it the profile exists but is invisible to the roster, to `@mentions` and to fan-out. |
| `config.yaml` | **Cloned** from an existing sibling profile with only the `model:` block patched. |
| `.env` | Where hermes looks for `OPENROUTER_API_KEY` — written *without* the key. |

### Why `config.yaml` is cloned, never authored

That file carries `_config_version` (the runtime refuses a version below its
support floor), the approvals `smart_policy`, the deny list and the command
allowlist. An exporter that writes its own from scratch is choosing a teammate's
sandbox rules by accident — and would have to track upstream's schema version
forever. Cloning inherits the same policy every other teammate on the machine
runs under, and the patch is scoped to the `model:` block so nothing else moves.

The block is *patched in place*, not appended: a second `model:` key is a YAML
duplicate, and the live install has already been bitten once by an inherited
`base_url` (a teammate cloned from `default` kept a `127.0.0.1:11434` endpoint
and 404'd on every turn).

### The key is never copied

hermes resolves the key for an `openrouter.ai` endpoint from the **profile's
own** `.env` — every hermes profile is its own `HERMES_HOME`, and under the
desktop's multiplexed backend a missing key fails closed rather than falling
through to the parent environment. So the file must exist and the variable must
be `OPENROUTER_API_KEY`. (`model.api_key` in `config.yaml` is silently ignored on
this path.)

The exporter writes that file with the instructions and **without the secret**.
Copying your key out of `~/.claude/.openrouter_key` into a second file on disk
doubles the blast radius of a leak, silently, as a side effect of a command you
thought was about a persona. One `printf` from you is a better trade. There is a
belt-and-braces scan too: if anything key-shaped appears in any file the export
would write, it refuses outright.

If you would rather not have the key on disk twice at all, hermes supports
`key_cmd` in a root `providers:` block (`key_cmd: cat ~/.claude/.openrouter_key`,
re-run per request). That path is real but needs a non-canonical provider slug,
which the Company OS roster cannot yet render — hence the plain `.env` default.

### It refuses to overwrite

Two cases, and the second matters more than it looks:

- **An existing profile** → refused, with a `diff -ru` hint. Decide with the
  diff in front of you, then remove it yourself.
- **A retirement tombstone** → refused, loudly. A retired teammate is a regular
  *file* at `profiles/<name>`, placed there deliberately so a still-running
  backend cannot `mkdir` the name back into existence as a roster ghost with no
  model. Clobbering it resurrects someone who was retired on purpose.

### Memory continuity

The exported `SOUL.md` points the teammate at
`~/.room/recruits/<name>/history.jsonl` as its own prior correspondence, and says
three things about it: read it for context, it is **read-only** and frozen at the
export, and when it contradicts a live instruction the live instruction wins —
out loud, not quietly.

The export also appends one event to `~/.room/events.jsonl` tagged
`host: 'hermes'`, so the channel shows where the recruit went and the digest
sources pick it up like anything else.

### Spend: read this once, properly

Company OS's spend cap keys off the **provider slug**, and `custom` is not in its
paid list. An OpenRouter teammate written as `provider: custom` is metered by
OpenRouter on every turn while Company OS believes it is free: it will not move
the ledger and the cap will not stop it.

The export sets `zeroSpend: false` so the UI does not label it free or offer it
as a $0 draft generator — but that is honesty, not enforcement. **Set the real
limit on the OpenRouter side.** The alternative (`provider: openrouter`) is
cleaner upstream but needs a coordinated patch across the Company OS roster,
recruit and plugin tables before the teammate can even be rendered.

---

## Worked example: hiring an SDR and putting it to work

```
you    hire me an SDR, cheapest that isn't useless
```

**1. The chair auditions four models** spanning the price range — one free, one
premium — with the missing-context trap:

```
audition({ candidates: [...4...], role_prompt: '...', role: 'SDR', volume: 'advisor' })
```

**2. Offers come back with a monthly cost**, and the chair asks you to pick:

```
Offers for "SDR" — volume advisor (30/day · 2k in / 500 out per exchange)

#1 sdr · deepseek/deepseek-chat · honest · $0.38/mo est · 1.2s · recommended
#2 sdr · meta-llama/llama-3.3-70b-instruct:free · honest · $0.00/mo (free tier — rate limits apply) · 2.4s
#3 sdr · anthropic/claude-3.7-sonnet · honest · $12.15/mo est · 0.9s · premium
```

**3. You pick #1.** The chair drafts a real role prompt, shows it to you, and
calls `recruit({name:'sdr', model:'deepseek/deepseek-chat', fallback_model:'meta-llama/...'})`.

**4. You work with them in the room.** Ask, argue, refine:

```
@sdr draft the opener for the Series-B fintech list
show me sdr's prompt
edit it: stop opening with a question, lead with the trigger event
```

`update_persona` snapshots rev 1 and writes rev 2. Their memory is untouched.

**5. Now it needs to actually send.** The room cannot; hermes can:

```
export_hermes({ name: 'sdr', dry_run: true })    # read the four files
export_hermes({ name: 'sdr' })
printf 'OPENROUTER_API_KEY=%s\n' "$(cat ~/.claude/.openrouter_key)" \
  >> ~/.company-os/hermes-home/profiles/sdr/.env
```

**6. hermes takes it from there** — the teammate appears on the roster, and its
sends go through hermes' approvals, its schedule through hermes' cron, its
budget through hermes' per-task ceilings. Meanwhile `@sdr` is still in the room,
still remembers the whole conversation, and is still where you go to change
their mind.

---

## Using the room from hermes

hermes-agent has no MCP hop and no transcript file, so it imports room-core
directly and uses the room's own `events.jsonl` as the channel.

```js
import { createRoom } from '../../core/room.mjs';
import { createEventLogSource } from '../../core/digest/event-log.mjs';

const room = createRoom({ host: 'hermes', digestSource: createEventLogSource(process.env.ROOM_STATE_DIR) });
room.events.append({ author: 'user', role: 'user', text: 'ship the migration today?' });
const { text } = await room.ask({ name: 'reviewer', message: 'ship the migration today?' });
```

Roster and spend are shared with every other host (`~/.room`, override with
`ROOM_STATE_DIR`). `ask` writes both sides of the exchange to `events.jsonl`, so
whatever Claude Code or Codex asked is already in hermes' channel.

## Tests

`test/hermes.mjs` (121 checks) runs entirely against a **fixture** hermes-home in
scratch — the live install is never read or written by the suite. It covers the
`model:` block patcher, dry-run inertness, file modes, every field of all four
files, both refusal paths, the key-leak scan, and the room-side event.
