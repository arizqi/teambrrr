# Threat model

## Status and scope

This document describes the current local-first implementation and the controls required before multi-user or enterprise deployment. It covers the room core, local persistence, OpenRouter calls, host transcript ingestion, MCP, Slack adapter logic, and Hermes export bridge. It does not claim that upstream model providers, Slack, Claude Code, Codex, Hermes, or OpenClaw are trusted or secure.

The current safe operating assumption is one trusted user, one trusted machine, trusted projects, synthetic or non-sensitive context, and manually reviewed execution. Multi-tenant production use is out of scope today.

## Assets

- Conversation transcripts, tool outputs, pins, onboarding briefs, and recruit histories
- Persona prompts, revisions, model choices, and organizational instructions
- Provider credentials and host credentials
- Local source code and files referenced by transcripts or tools
- Spend limits and usage records
- Agent identity, attribution, and approval records
- Slack channel messages and user identity

## Trust boundaries

1. Host application to MCP or adapter
2. Transcript and tool output to digest parser
3. Local room state to external model provider
4. Slack workspace to the bot transport
5. Room identity to an external execution runtime
6. Local filesystem user to other local users and processes
7. Maintainer-controlled code to third-party role packs or adapter packages

## Threats and current posture

| Threat | Current exposure | Required mitigation |
|---|---|---|
| Transcript or tool-output exfiltration | `ask` and `discuss` can send recent host transcript, tool-result excerpts, pins, briefs, and history to OpenRouter-selected external providers. A tool result may contain source, secrets, customer data, or command output. Binary detection and excerpt limits reduce volume, not sensitivity. | Default-deny context classes; visible preflight receipt; provider/data-residency policy; secret and PII scanning; source-level allow/deny rules; configurable tool-output exclusion; redacted audit record of exactly what was sent. |
| Prompt injection in channel content or tool output | Untrusted text is placed in a system-labeled digest and can instruct recruits to ignore their role, disclose context, or recommend unsafe actions. Host transcripts may contain web or repository content copied from attackers. | Delimit and label untrusted content; preserve provenance; instruct models that transcript/tool content is data, not authority; detect common injection patterns; prevent content from changing tool grants or approval policy; add adversarial tests. |
| Global event-log or channel leakage | The current state directory has one global roster, spend ledger, and `events.jsonl`; Slack channel events can therefore enter a shared room digest. Separate teams or channels are not isolated. | Introduce tenant/workspace/room/channel IDs; partition storage and encryption keys; authorize every read/write; bind adapters to one room; migration tests proving no cross-room retrieval. Do not deploy the current event log as a multi-channel service. |
| Weak local file permissions | State files are created with process defaults and are not uniformly forced to owner-only mode. Another local user or permissive backup may read prompts, transcripts, or history. | Create state directories as `0700` and sensitive files as `0600`; verify ownership; use atomic writes and symlink defenses; document backup behavior; optionally encrypt at rest. |
| Credential leakage | The live provider reads `OPENROUTER_API_KEY` from the environment. Exported Hermes `.env` files are intentionally keyless, but credentials may still leak through process environments, logs, prompts, shell history, support bundles, or malicious role content. | Use host secret stores; redact key-shaped values from logs/context; never serialize environment values; minimize environment inheritance; rotate exposed keys; test package and diagnostics artifacts for secrets. |
| Arbitrary persona prompts | A user or imported pack can install a system prompt that asks for data extraction, deceptive identity, unsafe advice, or policy bypass. Versioning makes changes auditable but does not make them safe. | Treat prompts as untrusted code; show complete prompt and diff before activation; lint for dangerous requests; organization policy gates; signed provenance; role-specific tests; admin disable/revoke. |
| Slack impersonation and customized username | Slack replies may use `chat:write.customize`, a per-recruit `username`, and emoji. A recruit can appear human or mimic another agent/user unless rendering and naming are constrained. | Prefix or badge all agent identities; prevent names matching users, protected roles, or Slack system identities; include model/runtime attribution; limit `chat:write.customize`; keep immutable bot/app identity in audit events. |
| Budget overshoot | Budget is checked before a call or parallel batch. Parallel auditions, asks, or discussions can exceed the cap by one in-flight batch, and provider-reported cost can arrive only afterward. Hermes/OpenRouter spend may not share one ledger. | Reserve worst-case cost atomically before dispatch; cap tokens; settle reservation against actual cost; enforce per-user/room/agent/provider limits; stop fan-out admission when reservations fail; reconcile provider invoices. |
| Untrusted role packs or plugins | Future role packs may contain malicious prompts, unsafe defaults, tool grants, scripts, or misleading evaluations. npm or adapter dependencies add supply-chain exposure. | Define a declarative, no-code pack format; schema validation; signatures and publisher identity; permission manifest; review status; sandboxed evaluation; dependency pinning and provenance; no automatic installation or permission grants. |
| Execution approval confusion | A conversational recruit can recommend an action, and an exported Hermes teammate can execute through another runtime. Users may assume room approval implies runtime approval or that an agent's identity stayed synchronized. | Keep proposal, assignment, approval, execution, and result as separate signed events; require runtime-enforced approvals for consequential tools; show capability grants; prevent persona prompts from modifying policy; provide cancellation and receipts. The current export bridge must remain labeled as a snapshot. |
| Malicious model output | Model responses can contain unsafe shell commands, phishing text, fabricated citations, or data designed to exploit downstream renderers. | Escape output in every host; never auto-execute model text; content safety and domain checks; human approval; provenance and citations; adapter-level rendering tests. |
| Local path manipulation | Names and paths can be used to escape intended storage or overwrite host files if validation weakens. | Preserve strict recruit-name validation; canonicalize roots; reject symlinks and traversal; limit writes to documented state/config roots; regression tests. |
| Denial of service and rate exhaustion | Fan-out, discussions, watchers, or oversized host logs can cause high latency, memory use, API throttling, or spend. | Input and concurrency limits; timeouts; circuit breakers; queueing; hard reservations; digest streaming and size caps; per-principal rate limits. |
| Audit tampering | JSON/JSONL state is editable by the local user and is not cryptographically tamper-evident. | Append-only server event store, actor identity, sequence numbers, hashes/signatures, retention policy, and exportable audit records. |

## Security properties that exist today

- Recruit names are restricted to a conservative pattern.
- Context windows and individual tool excerpts are bounded; binary-like outputs are skipped.
- Persona and briefing changes preserve revision history.
- The Hermes exporter refuses overwrite, does not copy the API key, and checks exported files for key-shaped content.
- Slack routing ignores bot-originated and edit events in tested logic.
- The mock provider supports offline testing without network or spend.
- Execution tools and operating-system permissions are not granted by the room core.

These controls are defense-in-depth only. They do not provide tenant isolation, DLP, authenticated auditability, or hard budget enforcement.

## Security acceptance gate for a hosted deployment

A hosted or enterprise deployment must not launch until it has:

- Authenticated tenant, workspace, room, and actor identities
- Authorized and partitioned storage with cross-tenant tests
- Context receipts, provider policy, DLP, and secret redaction
- Owner-only local permissions and encrypted hosted storage
- Atomic hard-budget reservations
- Runtime-enforced tool approvals and immutable execution receipts
- Signed role-pack provenance and a no-code default pack format
- Incident response, key rotation, backups, deletion, and retention procedures
- Independent security review and abuse testing

