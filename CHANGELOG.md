# Changelog

All notable changes will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project intends to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

Release comparison links will be added when the public repository URL exists.
