# TeamBrrr Slack adapter

Puts the room in a Slack channel. Write `@alice` in a message and the recruit
named `alice` answers in the thread, posting under her own name and emoji.

**Status: app creation pending.** Everything on this side is written and tested
against a fake transport (`test/slack.mjs`, zero network). What is missing is the
Slack app itself — the manifest below has never been submitted to a workspace, so
the live socket path is unproven.

## What it does and does not do

- **Never reads channel history.** No backfill, no `conversations.history` calls.
  The room's own event log (`~/.room/events.jsonl`) is the memory, so a recruit
  in Slack sees the same channel the Claude Code and Codex hosts see. The
  triggering Slack message is appended to that log before the recruit is asked.
- **One reply per recruit**, posted with `username` + `icon_emoji` overrides so
  each persona has a distinct face. That is what `chat:write.customize` is for.
- **Threads.** Replies go to `thread_ts` when the trigger was in a thread,
  otherwise they start one on the triggering message.
- **Never answers itself.** Messages carrying `bot_id`, the `bot_message`
  subtype, or the app's own user id are dropped before anything else happens.

## Create the app

Slack → *Your Apps* → **Create New App** → **From an app manifest**, pick the
workspace, and paste:

```yaml
display_information:
  name: TeamBrrr
  description: Teams go brrr. Recruit AI teammates into your channels.
  background_color: "#1f2733"
features:
  bot_user:
    display_name: teambrrr
    always_online: true
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - chat:write
      - chat:write.customize
      - im:history
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.im
  interactivity:
    is_enabled: false
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
```

Why each scope:

| Scope                 | Needed for                                                |
|-----------------------|-----------------------------------------------------------|
| `app_mentions:read`   | the `app_mention` event when someone @-mentions the app    |
| `channels:history`    | receiving `message.channels` events in channels it is in — the adapter never calls the history API |
| `chat:write`          | posting replies                                            |
| `chat:write.customize`| the per-recruit `username` + `icon_emoji` overrides         |
| `im:history`          | receiving `message.im` events in DMs                       |

Then:

1. **Basic Information → App-Level Tokens** → generate a token with scope
   `connections:write`. That is `SLACK_APP_TOKEN` (starts `xapp-`).
2. **Socket Mode** → confirm it is on.
3. **Install App** → install to the workspace, copy the *Bot User OAuth Token*.
   That is `SLACK_BOT_TOKEN` (starts `xoxb-`).
4. Invite the bot to a channel: `/invite @room`.

## Run

```sh
cd adapters/slack
npm install                      # @slack/bolt lives here, not in server/
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
export OPENROUTER_API_KEY=sk-or-...   # unset => mock provider, no spend
node bot.mjs
```

`ROOM_STATE_DIR` (default `~/.room`) and `PERSONA_RECRUITER_BUDGET_USD`
(default `1.00`) work exactly as they do for the other hosts — same roster, same
history, same one spend cap.

## In-channel commands

```
room roster
room recruit <name> <model> -- <system prompt>
room dismiss <name>
room discuss <name>,<name> [rounds] -- <topic>
room help
```

Addressing recruits:

```
@alice what's the risk in the migration?
@alice locks? @bob and the index rebuild?     # each gets their own question
@alice @bob thoughts?                          # both get the whole message
```

## Embedding it

`start()` is the only function that needs Bolt. To drive the bot from your own
process — or from a test — build it yourself and hand it a transport:

```js
import { createSlackBot, createSlackRoom } from './bot.mjs';

const bot = createSlackBot({
  room: createSlackRoom({ stateDir: '/tmp/room' }),
  transport: { postMessage: async (args) => { sent.push(args); return { ok: true, ts: '1.0' }; } }
});
await bot.handleEvent({ type: 'message', channel: 'C1', ts: '1.0', user: 'U1', text: '@alice hi' });
```

`transport` is the entire Slack surface: one `postMessage({channel, text,
thread_ts, username, icon_emoji})`. That is what keeps the tests offline.
