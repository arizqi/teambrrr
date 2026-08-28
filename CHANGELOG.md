# Changelog

All notable changes will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project intends to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Rebranded the project to **TeamBrrr** (`teambrrr`) with the tagline “Teams go brrr.”
- Made `teambrrr` the primary npm package, CLI, MCP identifier, and new Codex
  configuration key.
- Kept `persona-recruiter` as a CLI alias and preserved existing MCP config,
  `PERSONA_RECRUITER_*` environment variables, and `~/.room` state paths.
- Rewrote the README around recruiting on OpenRouter and moved the depth into
  `docs/HIRING.md` (audition, judges, offers, autonomy, persona lifecycle) and
  `docs/HOSTS.md` (context assembly, host wiring, local models, state, env).

### Added

- A shared `CallBudget` guarding every provider call site: the estimated cost is
  reserved before dispatch and settled afterwards, so a parallel fan-out can no
  longer overshoot the cap. Two ceilings apply — `PERSONA_RECRUITER_BUDGET_USD`
  (read fresh from the persisted ledger) and `PERSONA_RECRUITER_BUDGET_CALLS`
  (per room process, default 200).
- Per-call spend attribution to `<state>/spend-log.jsonl` and a `spend` MCP tool
  reporting calls and dollars per recruit and per reason against both ceilings.
- Audition scoring rebuilt around a weighted geometric mean with a fabrication
  veto, a three-outcome trap verdict, and separate latency and throughput
  weights.
- An optional heterogeneous judge panel for auditions: two or three cheap models
  from different vendors, each scoring one anchored rubric, with disagreement
  reported rather than averaged; the panel never overrides the mechanical trap.
- The autonomy ladder (`L0`–`L3`) as a property of the seat: set on `recruit`,
  changed with `update_persona`, shown on offer cards and the roster, injected
  into the teammate's system prompt, and written into the hermes export.
- A two-pass prompt-authoring gate: an `authoring_rating` on `recruit` and
  `update_persona` scored as the minimum of four dimensions, stored with the
  persona and printed by `show_persona`.
- Rolling brief maintenance: a `brief_compact` MCP tool that returns the current
  brief, the channel since the last compaction and the rewrite instruction
  without calling a model, plus brief-staleness reporting in `show_persona`.
- Warm plug-in context: named, fenced and independently guarded persona, brief,
  pin and transcript blocks, ordered so the authoritative blocks precede the
  ambient ones.
- Apache-2.0 licensing and open-source contribution, conduct, and security policies.
- Root npm package and workspace metadata.
- CI coverage for supported Node.js releases.
- Architecture, threat model, and enterprise product roadmap documentation.
- Durable execution-task control plane with stable recruit identities, leases,
  progress, approvals, cancellation, terminal receipts, and subscriptions.
- Direct-import execution worker adapter for Hermes, OpenClaw, and similar hosts.
- Versioned role-evaluation packs with repeated trials, fatal criteria,
  geometric scoring, retained evidence, and three reference roles.
- MCP and room APIs for role evaluation, task assignment, inspection, approval,
  and cancellation.
- Locally-running models as first-class recruits: discovery across Ollama and
  llama.cpp's `llama-server` (plus any OpenAI-compatible host configured in
  `<state>/config.json`), `local/<host>/<model>` ids, keyless calls recorded in
  the spend ledger at `$0`, `include_local` / `local_only` on `audition` and
  `evaluate_role`, and a `local_models` MCP tool.
- Measured decode throughput (tok/s) in audition ranking, the results table and
  offer cards; the existing speed weight now splits between wall-clock latency
  and measured rate, and is unchanged when no rate is reported.
- Advisory GPU-contention warnings on local offers and hires, and a documented
  server-down path: a local recruit falls back to a remote model only when it
  was hired with a `fallback_model`.

## [0.1.0] - 2026-08-26

### Added

- Host-neutral room core with global recruits, project overlays, shared history, pins, and event log.
- OpenRouter-backed recruit, ask, discuss, audition, offer, persona revision, briefing, watcher, and dismissal flows.
- MCP adapter for Claude Code and Codex.
- Claude Code session hooks and Codex setup helper.
- Tested Slack Socket Mode adapter logic and a Hermes profile export bridge.
- Offline test suite covering the current core and adapters.

Release comparison links will be added when the first release is tagged; the
repository has no version tags yet.
