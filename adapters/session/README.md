# TeamBrrr sessions

Start a named room from one existing agent conversation, then join it from another. The daemon starts automatically; no browser, participant files, ports, or replacement model sessions are needed.

## Use it in chat

In Codex:

> Start TeamBrrr room launch. My goal is X. Propose how you and Claude should divide the work.

In Claude Code:

> Join TeamBrrr room launch, read the messages, and reply here.

The agents call `room_start` / `room_join` using their actual session IDs. Codex can use its host-provided ID automatically; Claude supplies the ID of its current conversation. Peers' replies are shown with attribution inside your chats. Messages do not create authority beyond the user's instructions and each host's policies.

A room can include multiple Codex and Claude sessions. Rejoining the same session keeps its handle; an additional session gets a unique handle. Use the handles returned in the roster to address participants. Different room names have separate transcripts.

**Receiving still requires an active turn.** Ask an idle agent to “check TeamBrrr.” Automatic daemon startup is not automatic agent wake-up. Roles and goals can be discussed as messages; a structured goal scheduler and automatic subagent execution are not part of this adapter.

## One-time MCP setup

After installing the server dependencies, register a host-specific MCP entry. Neither entry is bound to a particular conversation:

```sh
codex mcp add teambrrr-session -- /absolute/node /absolute/teambrrr/server/session.mjs --host codex
claude mcp add --scope user teambrrr-session -- /absolute/node /absolute/teambrrr/server/session.mjs --host claude
```

If the existing session still exposes the old tools, restart/resume that same conversation so the host loads the new entry. Do not launch another process concurrently against the same host transcript. `--root DIRECTORY` optionally sets a shared room root; both hosts must use the same directory. The default is `~/.room/sessions` (or `TEAMBRRR_ROOMS_DIR`). Provider-backed recruits in the existing `~/.room` layout are unchanged.

| Tool | What it does |
| --- | --- |
| `room_start(name, session_id?, role?)` | Create or reopen a room, start its daemon, and enroll this actual session. |
| `room_join(name, session_id?, role?)` | Join an existing room; a typo is refused rather than silently creating a different room. |
| `room_list()` | List local rooms and participant handles. |
| `room_send(to, message, idempotency_key, reply_to?)` | Record a message addressed to a participant handle or `all`. |
| `room_read(after?)` | Return new events and addressed inbox messages, with a cursor. |
| `room_wait(after, seconds)` | Wait at most 25 seconds for events while the turn is active. |
| `room_ack(message_id)` | Record receipt, not agreement or approval. |

## Terminal commands

The package's `teambrrr` executable supports:

```sh
teambrrr start launch
teambrrr rooms
teambrrr join launch --host claude --session ACTUAL_SESSION_ID
```

`start` in an ordinary terminal creates the room without enrolling a model. Ask each agent to join it. When invoked from Codex's shell, start/join can use `CODEX_THREAD_ID` automatically. Use `--root DIRECTORY` to select a different room root. The no-argument `teambrrr` command and legacy `persona-recruiter` alias continue to start the original recruiting MCP server.

## Automatic daemon lifecycle

Rooms are persisted under the room root. Startup is serialized per room, and the daemon also retains its own exclusive writer lock. The launcher runs the daemon detached with a private local log. Every named MCP request checks that the room is reachable; if its old process is proven dead, it starts a replacement and reloads the connection file. The transcript and participant credentials survive. An alive but unresponsive process is not killed automatically.

If the launcher itself is killed while starting a room, `startup.lock` may remain. Inspect its recorded PID and remove it only after verifying that launcher is gone. This rare launcher failure differs from a daemon crash, which is recovered automatically on the next request. This is on-demand startup, not an installed login/boot service.

Local enrollment uses the room owner's private connection file. Agent message credentials cannot call the enrollment endpoint directly. This is a trusted, single-user local service: any process with the user's filesystem access can read the room credentials. Session IDs are explicitly supplied bindings, not cryptographic host attestations. No provider keys are used or copied. No message body is executed as code.

## MCP fallback for an already-running host

If the host has not refreshed its native tool inventory, this client still performs actual MCP initialize and tools/call over stdio:

```sh
node adapters/session/mcp-client.mjs --host codex --room launch --session ACTUAL_SESSION_ID --tool room_start
node adapters/session/mcp-client.mjs --host claude --room launch --session ACTUAL_SESSION_ID --tool room_read
```

Use `--args FILE.json` for tool arguments and `--root DIRECTORY` if needed. This is a protocol client fallback, not native tool hot-loading. It never substitutes another session's identity.

## Legacy fixed-room setup

Create a participants file with the exact host session IDs:

```json
{
  "human": { "label": "You", "role": "Director" },
  "codex": { "label": "Codex", "sessionId": "EXACT_CODEX_ID", "role": "Collaborator" },
  "claude": { "label": "Claude Code", "sessionId": "EXACT_CLAUDE_ID", "role": "Collaborator" }
}
```

```sh
node adapters/session/server.mjs /absolute/room-dir /absolute/participants.json
```

The server binds only `127.0.0.1` on an available port and writes private `human.json`, `codex.json`, and `claude.json` connection files into the room directory. Open the URL in `dashboard.json` to access the human panel. Its fragment is a room-scoped human credential: keep the URL and connection files local. Browser requests require the credential and same origin; scripts use participant bearer credentials. No provider keys or API spending are involved.

## Participate

```sh
node adapters/session/client.mjs /absolute/room-dir/codex.json read
node adapters/session/client.mjs /absolute/room-dir/codex.json send claude 'Hello' handshake-1
node adapters/session/client.mjs /absolute/room-dir/codex.json wait 1 20
node adapters/session/client.mjs /absolute/room-dir/codex.json ack MESSAGE_ID
node adapters/session/client.mjs /absolute/room-dir/codex.json send-file claude /absolute/message.txt reply-1 MESSAGE_ID
```

`read` and `wait` return a cursor. Persist the last processed cursor if reconnecting. `send` accepts an optional idempotency key and reply ID. Reuse the same key and body after an uncertain response; a changed body with the same key is refused. An acknowledgment means the agent explicitly called `ack`, not merely that a browser displayed the message. Session IDs are explicit bindings declared at setup, not host-attested identity. Session participants must check that the ID matches their current host before using the config.

Each event identifies its sender as `actor` (not `from`). Message events also have `id`, `seq`, `ts`, `to`, `text`, and `replyTo`. Filter incoming messages by `kind === 'message'`, `actor !== YOUR_ACTOR`, and `to === YOUR_ACTOR || to === 'all'`. Preserve the response cursor even if all returned events were your own messages or acknowledgments.

Human `pause` blocks new agent messages while still allowing human direction and acknowledgments. It **does not interrupt an agent's existing tool calls or cancel host work**. Use the host's Stop button for that. Recipient selection is addressing, not privacy: everyone in the room can read the complete bridge transcript.

## Persistence and scope

The daemon is the sole writer and atomically replaces a private JSON snapshot on each event. It refuses a second daemon for the same directory. After a crash, verify the PID in `server.lock` is no longer running before removing that stale lock and restarting. Tokens persist; connection files refresh with the new port. This initial store is for a small, trusted, single-user room; it rewrites the snapshot on each change. It is not a remote or multi-tenant authorization system: local processes with the same user's filesystem access can read all participant credentials.

Existing `core/room.mjs` provider-backed recruiting and `core/execution.mjs` task leasing remain separate. This milestone establishes actual session messaging. Dynamic role negotiation, shared goal/task UI, host-native subagent tracking, channel push, and Codex idle wake-up are subsequent work.

## Verification

```sh
node test/session-bridge.mjs
npm test
```

The focused suite covers retries, ordering, reply references, pause permissions, restart persistence, authentication, origin checks, and single-writer exclusion. It uses scratch directories and loopback HTTP only.

## Embedded chat and Claude push channel

The separate `server/session-chat.mjs` MCP server exposes `chat_open(name)` and an
MCP Apps chat component. User-composed messages go to the room as `human`, with
an explicit `@claude`, `@codex`, participant handle, or `@all` prefix. Replies
refresh inside the component. The existing Codex composer and native participant
bubbles are not changed. Codex still reads its inbox during active turns.

Register the human UI server in Codex using an absolute path to the checkout:

```sh
codex mcp add teambrrr-chat -- node /path/to/teambrrr/server/session-chat.mjs
```

After tool discovery refreshes, ask Codex to open the TeamBrrr room. Human mutation
tools are app-only; credentials stay in the MCP process and never reach the
iframe. The widget binds both room name and immutable room ID. Send retries reuse
an idempotency key. Acknowledgment is distinct from queuing and from completion.

For automatic Claude delivery, configure `server/session-channel.mjs` as an MCP
server named `teambrrr-channel`, with `--room NAME`. Launch/resume the intended
Claude session with `TEAMBRRR_CHANNEL_SESSION_ID` set to its actual ID and:

```sh
claude --resume ACTUAL_SESSION_ID --mcp-config /path/to/channel-config.json \
  --dangerously-load-development-channels server:teambrrr-channel
```

Use a launch-scoped config, not a global fixed session identity. Stop the existing
host for that session before resuming it elsewhere; do not run two writers over
one Claude conversation. The channel rejects a conflicting host-provided session
ID. The development flag opts this local channel into Claude's research preview;
it does not disable tool approvals. Claude may show its own consent screen, and
organization channel policy still applies. Desktop-managed session activation
has not been verified; the documented launch route is Claude Code CLI.

The adapter declares `claude/channel`, forwards addressed room messages after MCP
initialization, and exposes `channel_ack` and `channel_reply`. It does not invent
acknowledgments when a notification is written. Unacknowledged messages replay
when the channel reconnects; in one connection each message is forwarded once.
If channels are not enabled, Claude may silently ignore notifications. Pause
blocks forwarding and agent replies, but does not interrupt work already running.
Replies use the same existing room and participant identity, and remain visible
to every room participant. As with the original adapter, this is a trusted local
user boundary, not host identity attestation or isolation from same-user processes.

Reference: https://code.claude.com/docs/en/channels-reference

## One-step managed Claude

In a new Codex conversation, say **“Start TeamBrrr with Claude.”** The
`teambrrr-chat` MCP server's `team_start` tool creates a room for the current
Codex session, launches signed-in Claude Code in the current working directory,
checks an actual acknowledgment and reply, and opens the embedded chat. Repeating
it reuses that room and Claude session. No command in Claude and no separate
"enable replies" step are needed. Send `@claude ...` in the embedded composer.

The tool takes `cwd` (absolute working directory), `codex_session_id` (the actual
current session ID, or `CODEX_THREAD_ID`), and optional `name`. This configured
launcher uses **bypass permissions**; Claude can operate in that working directory
without individual permission prompts. It uses Claude subscription login and
removes inherited `ANTHROPIC_API_KEY`; run `claude auth login` once if signed out.
The managed process exposes only this room's MCP adapter, while Claude's built-in
coding tools remain available.

CLI equivalent from Codex's terminal:

```sh
teambrrr start my-room --with-claude --context-file /path/to/handoff.txt
```

Outside Codex, supply `--session ACTUAL_CODEX_SESSION_ID --host codex` and optionally
`--cwd /absolute/project`. Ordinary `teambrrr start NAME` retains its previous behavior.

A detached Node worker keeps Claude's streaming input open and delivers addressed
messages serially. Claude posts its own acknowledgments and replies through the
room tools. Startup stays `connecting` until both arrive; failures are displayed
in chat. This does not depend on the experimental Channels opt-in flag or a
foreground Claude terminal. The worker survives the initiating MCP connection.

Ask Codex to stop the room's managed Claude (`team_stop`) when finished. A subsequent
start resumes the same Claude identity after both owned processes have exited.
Ambiguous crashed processes are reported as disconnected instead of launching a
duplicate. Runtime state and logs live privately under `~/.room/sessions/NAME/`.
Codex still reads messages during active turns; this launcher does not wake Codex.

### Conversation context at startup

`team_start` requires `session_context`: Codex supplies a faithful summary of the
existing conversation automatically. Include the goal, relevant history, decisions,
constraints and permissions, completed work and evidence, relevant files, open
questions, and next steps. Distinguish user requests from proposed work. Do not
include credentials or hidden reasoning. This is a handoff summary, not a raw
transcript export; the MCP server cannot independently read the native conversation.

Claude receives the handoff in its first input before doing any work. The same
handoff appears as an attributed room message, with Claude's acknowledgment and
reply. Repeated identical handoffs are deduplicated; changed context is sent when
reusing the collaborator. CLI callers must supply `--context-file` because a shell
command cannot infer the current conversation. Missing context fails before launch.
