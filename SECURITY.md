# Security policy

## Supported versions

Until the first stable release, security fixes are made on the latest `0.x` release and the default branch only.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature for this repository. If private reporting is unavailable, contact the repository owner privately through their GitHub profile and ask for a secure reporting channel. Do not include secrets, production transcripts, or personal data in the first message.

Please include:

- Affected version or commit
- Preconditions and impact
- Reproduction steps using synthetic data
- Suggested mitigation, if known

We aim to acknowledge reports within seven days and will coordinate disclosure after a fix is available. This is a best-effort open-source project, not a guaranteed service-level agreement.

## Operational warning

This project can send conversation excerpts, tool outputs, prompts, and pinned context to externally hosted model providers. Review [the threat model](docs/THREAT_MODEL.md) before using it with confidential data. The current local prototype does not provide tenant isolation, SSO, atomic hard-dollar reservations, or runtime-enforced capability policy. In particular, `evaluateRole` reservations are local to one invocation/process and estimated: concurrent processes can race, and an underestimated provider receipt can exceed the remaining local cap. Its execution identity and lifecycle are local control-plane primitives, not a production authorization boundary; use provider or organization spending limits until atomic worst-case reservation and receipt settlement exist.

Never put provider keys in persona prompts, onboarding briefs, pins, role packs, source files, or Slack messages. Supply credentials through the environment or the execution host's secret manager.
