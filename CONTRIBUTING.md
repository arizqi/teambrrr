# Contributing to persona-recruiter

Thank you for helping build an open collaboration layer for portable AI colleagues.

## Before you start

- Read the [architecture](docs/ARCHITECTURE.md) and [threat model](docs/THREAT_MODEL.md).
- Search existing issues before opening a new one.
- For significant protocol, persistence, security, or adapter changes, open a design issue before writing code.
- Keep changes host-neutral when the behavior belongs in `core/`; adapters should translate host events rather than duplicate room logic.

## Local setup

Requirements: Node.js 20 or 22 and npm.

```sh
npm install
npm test
```

The test suite is offline. Do not use a real OpenRouter key in tests. Tests that exercise state must use a temporary `ROOM_STATE_DIR` and must not write to the developer's real `~/.room`.

## Pull requests

1. Keep the change narrowly scoped.
2. Add or update tests for observable behavior.
3. Run `npm test` on a clean checkout.
4. Update documentation and `CHANGELOG.md` when the public surface changes.
5. Explain security, compatibility, migration, and cost implications in the pull request.
6. Never commit transcripts, room state, API keys, credentials, customer data, or generated `node_modules`.

By submitting a contribution, you agree that it is licensed under the repository's [Apache License 2.0](LICENSE). A separate contributor license agreement is not currently required.

## Design principles

- The host assistant is the chair; named recruits remain independently attributable.
- Model providers are replaceable. Persona identity and history belong to the user.
- Context transfer must be visible, bounded, and eventually policy-controlled.
- Conversation and execution are separate trust boundaries. Tool execution requires an execution runtime and its approval policy.
- No operation should silently hire an agent, spend money, widen permissions, or overwrite revision history.
- Cross-host behavior needs adapter contract tests.

## Reporting security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

