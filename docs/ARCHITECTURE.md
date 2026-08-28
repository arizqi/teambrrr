# Architecture

## Purpose

persona-recruiter is a local-first collaboration room for named AI recruits. A host assistant remains the chair while independently configured OpenRouter-backed recruits join the conversation through a shared core. It is a collaboration layer, not an autonomous execution sandbox.

## Current system

```text
Claude Code ─┐
Codex ───────┼─ MCP / host adapters ─ createRoom() ─ OpenRouter
Slack ───────┤                            │
Hermes ──────┘                            └─ local state and host digests
```

### Core

`core/room.mjs` owns the host-neutral API: recruitment, calls, discussion, audition, offers, persona revisions, onboarding briefs, pins, watcher status, dismissal, and event access. `core/provider.mjs` owns OpenRouter catalog and completion calls, retry/fallback behavior, pricing, and the mock provider. `core/state.mjs` owns local filesystem persistence. `core/digest/` converts supported host transcripts or the room event log into bounded context.

Two direct-import foundation modules sit alongside that API. `core/execution.mjs` records a durable task lifecycle with leases, progress, explicit approval states, cancellation, terminal receipts, idempotency, and a file-store subscription contract; it records work but deliberately executes no tools. `core/role-packs.mjs` validates declarative JSON role packs and runs bounded, repeated, mechanically evaluated trials through an injected model caller. Both are exposed through `createRoom()` and the MCP surface; the execution adapter also gives Hermes/OpenClaw-style runtimes a direct worker contract.

The core is plain ESM with no third-party runtime dependencies. Callers can inject a provider, digest source, state directory, project directory, host identifier, budget, pricing resolver, and retry delay.

### Context assembly

For `ask` and `discuss`, a recruit receives, in order:

1. Its versioned persona prompt plus room rules
2. Its optional versioned onboarding brief
3. Global and project pins
4. A bounded recent channel digest
5. Its own recent room history
6. The current message

Tool outputs are excerpted, binary-like content is omitted, and excerpts receive only a bounded share of the digest. `audition` does not receive room context because it evaluates a candidate model rather than addressing a hired colleague.

### Persistence

The default store is `~/.room`. Persona definitions, histories, revisions, brief revisions, spend, model cache, pins, dismissed archives, and one event log are ordinary local files. A project-local `.room` may shadow global recruits and add pins. This is intentionally simple and inspectable, but it is not a transactional multi-user database.

The current roster, spend ledger, and event log are global to the state directory. There are no first-class room or tenant identifiers. This boundary is important: current state is appropriate for one trusted user, not separate enterprise teams or unrelated Slack channels.

Spend enforcement has the same local boundary. `evaluateRole` reserves
estimated capacity only within one invocation/process before dispatching trials.
It does not atomically reserve against other processes sharing the ledger, and
an underestimated provider receipt can exceed the remaining local budget. The
current guard is useful for bounding ordinary in-process fan-out, but it is not
a production hard-dollar guarantee.

### Adapters

- **MCP:** `server/index.mjs` exposes room operations over stdio for Claude Code and Codex. The MCP process is an adapter, not the source of business logic.
- **Claude Code:** hooks discover the active transcript, inject mention-routing context, warm session context, and optional watcher feedback.
- **Codex:** a setup helper registers the same MCP server; an instruction snippet asks the host model to route mentions. Codex transcript parsing is read-only.
- **Slack:** `adapters/slack/bot.mjs` parses commands and mentions and renders attributed replies through Bolt transport. Pure routing logic is tested; a real Slack app and live Socket Mode path have not yet been validated.
- **Hermes:** `adapters/hermes/export.mjs` exports a recruit into a Hermes teammate profile. It does not synchronize later room history or persona changes, and it does not copy provider credentials.
- **Execution worker:** `adapters/execution/index.mjs` binds a stable recruit identity to the execution task control plane for direct-import runtimes such as Hermes or OpenClaw. The caller still owns tool execution and decides when to request approval.

### Hiring and evaluation foundation

Audition runs one bounded probe per candidate, records latency and estimated cost, and mechanically scores honesty against a missing-file trap, length discipline, latency, and cost. Offers translate results into two or three selectable model/cost choices. Persona prompts and onboarding briefs are inspectable, versioned, editable, and reversible.

The newer role-pack foundation adds repeated trials, deterministic criteria, weighted geometric aggregation, consistency evidence, strict schema/path limits, and initial SDR, code-review, and security-review examples. `evaluate_role` connects those results to current catalog validation, spend tracking, and selectable offers, while preserving explicit hiring. It remains short of enterprise certification: there is no signed provenance, sandboxed pack installation, model/tool capability verification, organization promotion gate, or longitudinal outcome measurement.

### Execution boundary

The room calls language models and manages conversational state. It does not itself run shell commands, send email, update CRMs, deploy code, or grant operating-system permissions. An execution host such as Hermes or another agent runtime owns tools, sandboxing, schedules, and approvals. The execution adapter now coordinates one stable recruit identity through assignment, lease, progress, approval, cancellation, and completion. No real Hermes/OpenClaw runtime has yet passed an end-to-end live tool run, so this is a tested local control-plane foundation rather than a production integration. Hermes profile export remains an optional snapshot, not the continuity mechanism.

## Invariants

- Hiring is explicit; audition and offers never auto-recruit.
- Persona and briefing revisions are append-only; rollback creates a newer revision.
- Persona edits do not erase history.
- Model IDs are validated when the live catalog is available.
- Provider credentials are read from the environment and are not written into exported profiles.
- Recruits are independently attributed by handle and model.
- Execution permissions remain outside the room core.
- Local evaluation budgets are advisory protections, not atomic global spend ceilings.

## Near-term architecture direction

The next system boundary is an Agent Room Protocol and a local daemon backed by SQLite. It should make rooms, memberships, event streams, tasks, approvals, context receipts, costs, presence, and idempotency explicit. Existing adapters can then become protocol clients instead of concurrent readers and writers of shared files. See the [enterprise roadmap](ENTERPRISE_ROADMAP.md).

## Related documents

- [Threat model](THREAT_MODEL.md)
- [Execution bridge](EXECUTION_BRIDGE.md)
- [Role packs](ROLE_PACKS.md)
- [Enterprise roadmap](ENTERPRISE_ROADMAP.md)
- [Contribution guide](../CONTRIBUTING.md)
