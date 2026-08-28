# Enterprise product roadmap

## Vision

Enable people to recruit durable, named AI colleagues into the tools where work already happens. A recruit should keep a recognizable role, reviewed prompt, model assignment, context, history, and permission envelope across Claude, ChatGPT, Codex, Slack, Teams, Hermes, OpenClaw, and future hosts.

The open-source project is the portable collaboration substrate. A future commercial product may operate that substrate securely for organizations.

## Future scenario 1: every employee recruits a cross-platform team

An enterprise with 20,000 employees enables an approved “Recruit an agent” action inside Slack, Teams, ChatGPT Desktop, Claude, and coding environments.

A product manager asks: “Hire a pricing analyst for this launch. Keep it under $15 per month and make sure it understands B2B SaaS.” The recruiting manager reads the authorized launch context, organization glossary, linked decisions, and model policy. It auditions approved models against a representative pricing task and an honesty trap. The employee sees three offers: a constrained free tier, a recommended economical model, and a premium model, each with expected cost, latency, fit, risks, and the exact proposed persona prompt.

After selection, `@pricing` joins the existing launch conversation already understanding the product, audience, launch date, current assumptions, and unresolved decisions. The employee later recruits `@research`, `@legal-reviewer`, `@launch-editor`, and `@forecasting`. Agents can debate in the room, but each sees only data permitted for its seat. The same roster appears when the employee moves from Slack to a desktop AI host.

For the organization, this becomes governed self-service capacity:

- IT selects providers, regions, model allowlists, and spend ceilings.
- Security and Legal classify context and tool grants by role.
- Managers publish proven roles into an internal catalog.
- Prompt, model, briefing, and permission changes are versioned and attributable.
- Employee access can be revoked without destroying organization-owned roles.
- Analytics connect cost to outcomes rather than rewarding token volume.

Success means a non-technical employee can recruit a useful, policy-compliant colleague in under a minute without knowing model IDs, prompts, or tool schemas.

## Future scenario 2: an ephemeral incident-response room

At 02:13, an alert opens a Slack incident channel. The on-call engineer writes: “Recruit the team this incident needs. Checkout latency is up 900%, and deploy `8f2a` landed six minutes before it began.”

The system proposes an incident commander, log investigator, database specialist, patch reviewer, and customer-communications lead. Each receives a shared incident brief but different context and tools. Slack remains the human war room; Codex or Claude opens the repository; a controlled execution runtime performs read-only diagnostics; the reviewer inspects a proposed patch; the communications agent drafts updates. Rollback, production writes, and publication require explicit human approval enforced by the execution runtime.

The shared event stream records every hypothesis, source, assignment, model response, approval, tool call, cost, and outcome. Agents acknowledge tasks, report progress, request missing authority, and can be cancelled. After recovery, the same evidence produces a postmortem draft and an evaluation of which recruits helped. The temporary roster is archived without losing provenance.

Success means the room creates an accountable temporary organization around an emergency while preserving human command, data boundaries, and reconstructable decisions.

## Future scenario 3: a one-person company recruits a revenue team

A founder asks from Slack: “Build the cheapest viable outbound team for selling our API to property managers.” The recruiting manager proposes seats for account research, SDR outreach, and reply qualification. For each seat it shows two or three model offers, a tailored and editable system prompt, expected monthly cost by workload, fallback behavior, and evidence from role-specific evaluations.

The researcher gathers public company signals with citations. The SDR drafts personalized sequences and refuses to invent trigger events. The qualifier categorizes replies and escalates pricing, security, legal, and high-intent conversations. The founder can ask why response rates changed, inspect or roll back a prompt, switch the SDR to a cheaper model without erasing its identity, or ask the SDR and researcher to debate five accounts.

An execution runtime connects approved agents to Apollo or Clay, HubSpot, email drafts, schedules, and reply monitoring. External sends require the founder's approval until a policy explicitly allows a narrow automation. The same durable team is available from Slack in the morning and a desktop AI host at night.

Success means one person can operate a small, observable AI-assisted department while owning the personas and retaining freedom to replace models and execution providers.

## Current foundation

The repository already provides a host-neutral room core, named recruits, bounded warm context, OpenRouter model validation, audition, selectable cost offers, versioned persona prompts and onboarding briefs, pins, discussions, watchers, MCP integration, tested Slack routing logic, and a Hermes export bridge.

Two local foundations are now integrated, but are not complete enterprise solutions:

### Live execution continuity — local foundation implemented

The room separates conversational identity from execution. Its direct-import execution layer now connects `createRoom()`, MCP, and a worker adapter around durable tasks, stable recruit identity, leases, progress, approval requests, cancellation, idempotent completion, receipts, and event subscriptions without executing tools itself. The contract is thoroughly fixture-tested, but no real Hermes/OpenClaw worker has yet completed a live tool run. The missing enterprise capability is runtime-enforced capability policy, synchronized memory receipts, multi-process transactional storage, authenticated workers, and proven reconnect behavior. Hermes file export remains an optional snapshot and must not be presented as continuity.

### Stronger role evaluations — local foundation implemented

Audition compares models on a bounded probe, missing-context honesty, length, latency, and cost. `evaluate_role` now uses declarative JSON packs with strict schema validation, bounded cases and repeated trials, deterministic evaluators, fatal criteria, geometric-mean scoring, consistency evidence, raw evidence, spend tracking, and selectable offers. Initial packs cover SDR outbound, code review, and security review; selection still never auto-hires. The missing enterprise capability is signed provenance, sandboxed admission, tool-use trials, calibrated model judges where mechanical checks are insufficient, organization thresholds, regression gates after prompt/model edits, and measured production outcomes.

The current local budget guard is deliberately not represented as an enterprise
hard limit: `evaluateRole` reservations are per invocation/process and
estimated. Concurrent processes can race on the shared ledger, and a provider
receipt can exceed its estimate. Provider or organization-level limits are still
required for production protection.

## Deferred enterprise gaps

### Agent Room Protocol and daemon

Define a versioned protocol for identity, rooms, membership, messages, context envelopes, tasks, approvals, capabilities, costs, presence, events, retries, and idempotency. Implement a local daemon with SQLite and authenticated HTTP/WebSocket/MCP interfaces. Adapters become clients rather than direct concurrent filesystem writers.

### Scope and isolation

Replace the single global roster/event log with tenant, workspace, project, room, channel, thread, and personal scopes. Give every agent a stable ID and room-specific handles. Prove that one Slack channel or project can never enter another room's context.

### Authentication, RBAC, and SSO

Add OIDC/SAML SSO, users, groups, service accounts, workspace membership, role-based and attribute-based policy, model allowlists, tool grants, delegated administration, suspension, and revocation. Separate permission to speak, inspect context, assign work, approve spend, and execute tools.

### Context provenance and DLP

Label every context fragment with source, author, room, sensitivity, timestamp, and retention policy. Add context preflight receipts, provider routing policy, secret/PII detection, redaction, data residency, prompt-injection defenses, citation support, artifact references, retrieval, contradiction handling, and “why did this agent see this?” inspection.

### Hard budgets and observability

The local foundation does not yet provide this guarantee: its reservations are
process-local and estimated, so concurrent invocations can race and an
underestimated provider receipt can exceed the remaining cap.

Atomically reserve worst-case cost before dispatch, settle against provider receipts, and enforce limits by user, team, room, agent, model, provider, and period. Trace latency, failures, fallback, cache use, and cost. Connect agent activity to business outcomes such as meetings booked, defects found, or incident duration.

### Real host coverage

Turn tested or conceptual adapters into supported integrations for Claude Code, Codex, Slack, ChatGPT Desktop, Teams, Hermes, and OpenClaw. Each adapter must pass contract tests for routing, attribution, threads, context ingestion, reconnect behavior, permissions, errors, costs, and restart continuity.

### User experience, administration, and marketplace

Build offer cards, roster and presence, prompt/brief editors with diff and rollback, permission review, room history, task board, approval inbox, spend meter, performance history, and admin policy console. Add an internal marketplace for reviewed role packs with publisher identity, signatures, compatibility, evaluation evidence, and revocation.

### High availability, retention, and compliance

Provide transactional storage, migrations, backups, regional deployment, encryption, key management, disaster recovery, deletion workflows, legal holds, configurable retention, audit export, accessibility, incident response, and evidence needed for SOC 2 and relevant privacy obligations. Compliance claims require independent assessment; roadmap completion alone is not certification.

## Open-source and commercial boundary

### Open-source core (Apache-2.0)

- Agent Room Protocol specifications and schemas
- Local daemon and SQLite store
- Host-neutral room, context, hiring, evaluation, and budget primitives
- Adapter SDK and conformance test kit
- First-party reference adapters
- Declarative role-pack and evaluation-pack formats
- Local CLI and reference management UI
- Import/export and self-hosting documentation

The open layer must remain sufficient to run a complete personal or self-hosted team without a commercial control plane. Model and execution providers remain replaceable.

### Potential commercial enterprise product

- Managed highly available control plane
- SSO, SCIM, centralized RBAC, policy distribution, and delegated administration
- Managed connectors and secret brokerage
- Organization analytics, chargeback, outcome reporting, and fleet operations
- Long-term audit retention, compliance exports, regional hosting, and support
- Curated private marketplace governance and enterprise role certification
- Migration, incident-response, and service-level support

Commercial features may operate the open protocol but should not make protocol compatibility, local execution, or export hostage to the hosted service.

## Phased milestones

### Phase 0 — open-source baseline

Goal: make the current local implementation safe to inspect, run, test, and contribute to.

Acceptance criteria:

- Apache-2.0 license and complete contributor, conduct, security, architecture, and threat-model documentation
- Root package metadata and reproducible offline test command
- CI passes on Node.js 20 and 22
- Secrets, transcripts, local state, logs, and dependencies excluded from source and npm packages
- Current host limitations are documented without claiming unsupported live behavior

### Phase 1 — protocol and local room daemon

Goal: one authoritative local room process shared by multiple hosts.

Acceptance criteria:

- Versioned protocol schemas for rooms, identities, events, tasks, approvals, capabilities, context receipts, and costs
- SQLite persistence with atomic writes, migrations, backup, and crash recovery
- Authenticated local clients with idempotent command handling and ordered subscriptions
- Claude Code/Codex MCP and Slack adapters use the daemon rather than shared files
- Concurrent adapter and cross-room isolation tests pass

### Phase 2 — synchronized execution and role evaluation

Goal: make recruits dependable workers rather than disconnected chat personas.

Acceptance criteria:

- One agent identity can attach an execution runtime without duplicating memory or prompt state
- Task lifecycle supports assign, accept, progress, approval, cancel, fail, and complete with receipts
- Runtime policy—not a persona prompt—enforces tool and approval boundaries
- Declarative signed role/evaluation pack format with no-code default
- Each published role passes repeated representative, adversarial, refusal, and tool-use evaluations within cost/latency thresholds
- Prompt or model changes trigger regression evaluation before promotion

### Phase 3 — multi-user governance and host parity

Goal: a secure organizational pilot across daily work surfaces.

Acceptance criteria:

- SSO, users/groups, room membership, RBAC, model/tool allowlists, and revocation
- Tenant/workspace/room storage partitioning with automated negative isolation tests
- Context provenance, DLP, provider/data-residency controls, and inspectable context receipts
- Atomic hard budgets and organization-level observability
- Supported Slack plus at least two desktop AI hosts and one execution runtime pass adapter conformance
- Pilot users can recruit, edit, collaborate with, and retire agents without administrator assistance

### Phase 4 — enterprise operations and marketplace

Goal: operate reliably under enterprise security, scale, and governance expectations.

Acceptance criteria:

- High availability, tested restore, regional policy, encryption/key rotation, retention, deletion, and legal-hold workflows
- Immutable or tamper-evident audit exports linking context, model, approval, tool action, cost, and outcome
- Admin console, approval inbox, fleet health, chargeback, and outcome analytics
- Signed internal marketplace with review workflow, evaluation evidence, compatibility checks, and emergency revocation
- Independent threat-model review and penetration test completed; compliance evidence mapped without unsupported certification claims

## Product success measures

- Median time from request to active recruit under 60 seconds
- At least 80% first-offer acceptance during controlled pilots
- Zero invalid model IDs or missing prompts at activation
- Zero cross-room context disclosures in isolation testing and production incidents
- No execution without a valid runtime policy and required approval receipt
- Hard spend ceilings honored under concurrent fan-out
- Measurable improvement in role outcomes relative to cost and a human-only baseline
