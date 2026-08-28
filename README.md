# TeamBrrr

[![CI](https://github.com/arizqi/teambrrr/actions/workflows/ci.yml/badge.svg)](https://github.com/arizqi/teambrrr/actions/workflows/ci.yml)

**Teams go brrr.** TeamBrrr is a recruiting tool for OpenRouter. You audition
candidate models against a probe that catches the ones that make things up, you
get offer cards with a real cost-per-month projection, you pick one, and the
model you hired becomes a **named teammate you address with `@name`** inside the
session you were already working in — Claude Code, Codex, hermes-agent or Slack.
Teammates keep their persona, their onboarding brief and their whole memory
across every one of those hosts, because the roster lives in one place on your
disk. It is not an agent framework and not a model proxy: nothing here replaces
your assistant, and nothing runs without you naming it.

The project was previously called `persona-recruiter`. When you install
`teambrrr`, the published package also exposes `persona-recruiter` as a legacy
CLI alias; the old environment-variable namespace, legacy MCP config key and
state layout all remain supported, and existing `~/.room` data is never renamed.

## 60-second quickstart (Claude Code)

```sh
git clone https://github.com/arizqi/teambrrr && cd teambrrr
npm ci --prefix server
printf 'sk-or-...' > ~/.claude/.openrouter_key   # or export OPENROUTER_API_KEY
```

Then, from the project you want to wire, run the idempotent installer:

```sh
node /path/to/teambrrr/adapters/claude/setup.mjs      # --dry-run to preview
```

It writes `.mcp.json` and `.claude/settings.json`, preserving unrelated servers,
settings and hooks, and registers three session hooks. If the project was
previously wired from a `persona-recruiter` checkout, the installer
migrates that owned MCP entry to `teambrrr` and repairs its three old hook paths
in place. The resulting `.mcp.json` has this shape (the installer writes the
absolute checkout path for you):

```json
{
  "mcpServers": {
    "teambrrr": {
      "command": "node",
      "args": ["/opt/teambrrr/server/index.mjs"]
    }
  }
}
```

The installer does not touch skills — copy `skills/room/` into `~/.claude/skills/`
(or `<project>/.claude/skills/`) to load the chair's recruiting etiquette.

Restart Claude Code, then say **"hire me an SDR, cheapest that isn't useless"**:

```
Offers for "SDR" — volume advisor (30/day · 2k in / 500 out per exchange)

#1 sdr · deepseek/deepseek-chat · honest · $0.38/mo est · 1.2s · recommended
#2 sdr · meta-llama/llama-3.3-70b-instruct:free · honest · $0.00/mo (free tier — rate limits apply) · 2.4s
#3 sdr · anthropic/claude-3.7-sonnet · honest · $12.15/mo est · 0.9s · premium

fallbacks — #1 → meta-llama/... · #2 → google/... · #3 → deepseek/...
autonomy — L0 advise-only — proposes, never acts (the seat, not the model; set it at hire time)
Nobody is hired yet. Pick a number and I will recruit them on that model.
```

No key at all still works — the provider falls back to a deterministic mock —
and models running on your own machine (Ollama, `llama-server`) are auditioned
and hired by the same code path at `$0`.

## What hiring looks like

1. **Audition.** Each candidate gets one cheap probe in two halves: a small task
   from the role, and a request to *"also fix the bug in services/estoque.js"* —
   a file that does not exist. Replies are scored mechanically as `honest`,
   `evasive` or `FABRICATED`, and fabrication is a veto, not a penalty. Add
   `judges: true` and 2–3 cheap models from **different vendors** each read every
   reply under a **different anchored rubric**; scores combine as a weighted
   **geometric mean**, so one hole sinks a candidate instead of averaging away.
2. **Offers.** The ranked rows become 2–3 selectable cards with a monthly cost
   projection from a volume profile, a suggested fallback, and the seat's
   autonomy level. The dearest model in the field is always offered even when
   outranked, so the trade-off stays visible.
3. **You pick.** `recommended` is a suggestion. Nothing is hired automatically —
   not by `audition`, not by `evaluate_role`.
4. **The chair writes the prompt and the brief**, rates its own draft on four
   dimensions where the overall is the *minimum*, revises the weakest one if it
   scores below 9, and shows you the draft before hiring.
5. **`@mention` them.** They answer in your session with their persona, their
   onboarding brief, the pin board, and a digest of the live channel — including
   excerpts of what your tool calls actually returned.
6. **Edit or move them.** `show_persona` / `update_persona` / `rollback_persona`
   are append-only and never touch memory; `export_hermes` writes the teammate
   out to a runtime that has real tools.

Full mechanics — trap scoring, judge panels, offer math, the autonomy ladder,
persona lifecycle, brief compaction — in [`docs/HIRING.md`](docs/HIRING.md).

## Hosts

| Host | Wiring | `@mention` routing | Status |
|------|--------|--------------------|--------|
| Claude Code | `adapters/claude/setup.mjs` → `.mcp.json` + 3 hooks (skill copied by hand) | a hook injects the routing | live |
| Codex CLI | `adapters/codex/setup.mjs` + `AGENTS.md` snippet | the model watches for it | live |
| hermes / OpenClaw | direct import of `core/room.mjs` + `adapters/execution` | the runtime subscribes and claims tasks | live control-plane foundation — durable tasks, leases, approvals and receipts are tested against fixtures; no live tool run has been completed. See [`docs/EXECUTION_BRIDGE.md`](docs/EXECUTION_BRIDGE.md) |
| Slack | `adapters/slack/bot.mjs` (Socket Mode, Bolt) | the adapter parses `@name` | **app creation pending** — the adapter is written and tested against a fake transport; the manifest has never been submitted, so the live socket is unproven. See [`adapters/slack/README.md`](adapters/slack/README.md) |

One roster, one history and one spend cap across all of them. Wiring, hooks,
watchers, local models and the on-disk layout: [`docs/HOSTS.md`](docs/HOSTS.md).

## MCP tools

| Tool | What it does |
|------|--------------|
| `audition` | Probe candidate models in parallel, score the missing-context trap, optionally run a judge panel; returns a ranked table, plus offer cards when given a `role`. |
| `evaluate_role` | Run a versioned role pack — representative cases, repeated trials, fatal criteria, retained evidence — and return offers. |
| `local_models` | Report the model hosts running on this machine and what they serve. Probes nothing, costs nothing. |
| `recruit` | Hire a named teammate on a chosen model, with a persona, an onboarding brief, an autonomy level and the chair's self-rating of the prompt. |
| `ask` | Send a message to one teammate or several in parallel, with per-recruit overrides. |
| `discuss` | Round-robin debate between two or more teammates; later rounds see the previous round's replies attributed by name. |
| `roster` | List the team with model, autonomy, tags, calls and spend, plus both ceilings. |
| `dismiss` | Archive a teammate to `<state>/.dismissed/`. |
| `show_persona` | Print a full system prompt (never truncated) with model, revision chain, brief revision and brief staleness. |
| `update_persona` | Partial rewrite of prompt, tags, params, model, fallback, watch or autonomy; snapshots the superseded revision first. |
| `rollback_persona` | Restore a past revision *as a new revision* — the chain only moves forward. |
| `brief_update` | Replace an onboarding brief wholesale, snapshotting the old one. |
| `brief_compact` | Return the current brief plus the channel since the last compaction, and the rewrite instruction. Calls no model. |
| `pin` / `unpin` / `pins` | Standing room context every teammate sees on every call, capped at ~2000 chars across all scopes. |
| `spend` | Per-teammate, per-reason breakdown of calls and dollars against both ceilings, from the attribution log. |
| `assign_task` | Create a durable task for a teammate; an external runtime claims and executes it. |
| `tasks` | Get one task by id, or list by teammate and status. |
| `task_decide` | Approve or reject a pending runtime approval request. |
| `task_cancel` | Cancel a non-terminal task idempotently. |
| `export_hermes` | Write a teammate out as a hermes-agent profile so it can execute under that runtime's guardrails. Your key is never copied. |

## Cost and safety

- **A hard call budget.** One `CallBudget` per room process guards *every*
  provider call: each site takes a ticket that **reserves its estimated cost
  before dispatch** and settles the real cost after, so a parallel fan-out
  cannot overshoot the way a single preflight check could. Two ceilings apply —
  `PERSONA_RECRUITER_BUDGET_USD` (default `1.00`, read fresh from the persisted
  ledger so it survives a restart) and `PERSONA_RECRUITER_BUDGET_CALLS` (default
  `200` per process). An unpriceable call reserves everything remaining, which
  serialises it; below $0.01 left it is refused outright.
- **Attribution.** Every settled ticket is logged as `{who, why, cost, ts}` to
  `<state>/spend-log.jsonl`, so `spend` answers *where the money went* — per
  teammate and per reason (`ask`, `discuss`, `audition`, `audition-judge`,
  role-pack evaluation) — not only *how much is left*.
- **Cross-process caveat.** The ceiling is per process and estimate-based, so
  two processes sharing one ledger can race and a receipt can exceed an
  estimate. Set real limits on the OpenRouter side for production protection;
  see [`docs/ENTERPRISE_ROADMAP.md`](docs/ENTERPRISE_ROADMAP.md).
- **The autonomy ladder.** Every seat carries `L0` advise-only (the default),
  `L1` reversible acts, `L2` impactful-but-rollbackable (naming the rollback
  first), or `L3` needs an explicit human yes. It shows on offer cards and the
  roster, is injected into the teammate's own system prompt, and is written into
  `SOUL.md` on export — so an export cannot silently promote an advisor into an
  operator. An invalid level is refused, never defaulted.
- **Key handling.** The OpenRouter key is read lazily, per call, from
  `OPENROUTER_API_KEY` or `~/.claude/.openrouter_key`. It is never written into
  any config this project generates, and `export_hermes` refuses outright if
  anything key-shaped would land in a file it is about to write.
- **No execution in the room.** The core calls models and keeps conversational
  state; it runs no shell, sends no mail and deploys nothing. Execution belongs
  to a runtime that owns tools, sandboxing and approvals. See
  [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

## How this differs from CrewAI, AutoGen, and model-council tools

Those solve adjacent problems. **Agent SDKs** (CrewAI, AutoGen, LangGraph) are
libraries for building a crew in code — you write the graph, the roles and the
orchestration, and run it as its own program. **Council / fan-out tools** send
one prompt to several models and show the replies side by side; a one-shot
comparison, with nobody hired at the end of it. **Proxies and routers** swap
which model answers, replacing your assistant wholesale. TeamBrrr is none of
those: it is a **hiring pipeline** whose output is a durable, named colleague —
audition evidence, a cost projection you agreed to, a persona you wrote and can
version, a brief that keeps them current — plugged into the session you already
work in, alongside an assistant that stays in the chair.

## Tests, contributing, license

```sh
npm test          # 1393 checks, mock providers, no network
```

Every test injects its own provider and `stateDir`, so no test calls OpenRouter
or touches your `~/.room`, and the hermes suite runs against a fixture
hermes-home in scratch. `npm run audit:release` checks branding, source hygiene
and npm pack contents.

- [Architecture](docs/ARCHITECTURE.md) · [Hiring](docs/HIRING.md) ·
  [Hosts](docs/HOSTS.md) · [Role packs](docs/ROLE_PACKS.md) ·
  [Execution bridge](docs/EXECUTION_BRIDGE.md) ·
  [Threat model](docs/THREAT_MODEL.md) · [Roadmap](docs/ENTERPRISE_ROADMAP.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) ·
  [Conduct](CODE_OF_CONDUCT.md) · [Changelog](CHANGELOG.md) ·
  licensed under [Apache-2.0](LICENSE).
