// Slack adapter for the room.
//
// Everything except the live socket is in here and unit-tested: mention routing,
// text commands, reply formatting, per-recruit identity. Every Slack API call
// goes through a `transport` object with one method, so the tests inject a fake
// and nothing touches the network.
//
//   transport.postMessage({channel, text, thread_ts, username, icon_emoji})
//
// Channel history is deliberately NEVER fetched — no channels:history reads, no
// backfill. The room's own event log is the memory: the triggering Slack message
// is appended to it, then the digest is built from the log. So a recruit sees
// the room's shared history across every host, not just this channel.
//
// start() is the only part that needs @slack/bolt (declared in this directory's
// package.json, deliberately NOT installed into server/).
import { pathToFileURL } from 'node:url';
import { createRoom } from '../../core/room.mjs';
import { createEventLogSource } from '../../core/digest/event-log.mjs';
import { DEFAULT_STATE_DIR } from '../../core/state.mjs';

export const HOST = 'slack';

// Recruits are not Slack users, so their mentions arrive as plain text `@name`.
// Real Slack user mentions arrive as `<@U123>` and never match this.
const MENTION_SRC = '(^|[^\\w@<])@([a-z0-9_-]{2,24})\\b';
const BOT_MENTION = /<@[UWB][A-Z0-9]+>/g;
const ROOM_ICON = ':speech_balloon:';
const EMOJI = [
  ':bust_in_silhouette:', ':robot_face:', ':owl:', ':fox_face:',
  ':cat2:', ':koala:', ':crab:', ':otter:', ':hedgehog:', ':dolphin:'
];

const mentionRe = () => new RegExp(MENTION_SRC, 'gi');

// Stable per name, so a recruit keeps the same face across restarts.
export function emojiFor(name, persona) {
  if (persona?.icon_emoji) return persona.icon_emoji;
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return EMOJI[h % EMOJI.length];
}

export function rawMentions(text) {
  const out = [];
  for (const m of String(text || '').matchAll(mentionRe())) out.push(m[2].toLowerCase());
  return [...new Set(out)];
}

export function stripMentions(text, known) {
  return String(text || '')
    .replace(mentionRe(), (full, pre, n) => (known.includes(n.toLowerCase()) ? pre : full))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Split one Slack message into per-recruit messages.
//
//   "@alice what about locks? @bob and the index?"
//     -> alice: "what about locks?"   bob: "and the index?"
//
// One mention means the whole message is for that person. A mention with nothing
// after it falls back to the whole message, so "@alice @bob thoughts?" reaches
// both with the same question.
export function routeMentions(text, known) {
  const src = String(text || '');
  const hits = [];
  for (const m of src.matchAll(mentionRe())) {
    const name = m[2].toLowerCase();
    if (!known.includes(name)) continue;
    const start = m.index + m[1].length;
    hits.push({ name, start, end: start + 1 + m[2].length });
  }
  if (!hits.length) return { names: [], per: {} };

  const whole = stripMentions(src, known);
  const names = [];
  const per = {};
  const take = (name, msg) => {
    if (names.includes(name)) return; // first mention wins
    names.push(name);
    per[name] = msg || whole || src.trim();
  };

  if (hits.length === 1) {
    take(hits[0].name, whole);
    return { names, per };
  }
  hits.forEach((h, i) => {
    const seg = src.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : src.length);
    take(h.name, stripMentions(seg, known).replace(/^[\s,:;.\-–—]+/, '').trim());
  });
  return { names, per };
}

// `room roster`, `room recruit <name> <model> -- <system prompt>`, ...
export function parseCommand(text) {
  const t = String(text || '').trim();
  if (!/^room\b/i.test(t)) return null;
  const rest = t.replace(/^room\b[ \t]*/i, '').trim();
  if (!rest) return { cmd: 'help', rest: '', args: [] };
  const parts = rest.split(/\s+/);
  return { cmd: parts[0].toLowerCase(), rest: parts.slice(1).join(' '), args: parts.slice(1) };
}

// "<args> -- <tail>" — the tail is free text (system prompt, topic).
function splitTail(rest) {
  const i = rest.indexOf('--');
  if (i < 0) return { head: rest.trim(), tail: '' };
  return { head: rest.slice(0, i).trim(), tail: rest.slice(i + 2).trim() };
}

export const HELP = [
  '*Room commands*',
  '`room roster` — who is in the room, with model, calls and spend',
  '`room recruit <name> <model> -- <system prompt>` — add a recruit',
  '`room dismiss <name>` — archive a recruit',
  '`room discuss <name>,<name> [rounds] -- <topic>` — have them talk to each other',
  '`room help` — this message',
  '',
  'Address a recruit by writing `@their-name` in a message. Ask several at once and ' +
  'each one gets the part of the message that follows their name.'
].join('\n');

export function createSlackBot({
  room,
  transport,
  botUserId = null,
  footer = true,
  roomName = 'room',
  roomIcon = ROOM_ICON
} = {}) {
  if (!room) throw new Error('createSlackBot needs a room');
  if (!transport || typeof transport.postMessage !== 'function') {
    throw new Error('createSlackBot needs a transport with postMessage()');
  }

  const post = (args) => transport.postMessage(args);
  const say = (text, where) => post({ ...where, text, username: roomName, icon_emoji: roomIcon });

  const knownNames = () => room.roster().recruits.map((r) => r.name);

  function postReply(b, where) {
    const persona = room.store.readPersona(b.name);
    const cost = typeof b.cost === 'number' && Number.isFinite(b.cost) ? `$${b.cost.toFixed(4)}` : '$n/a';
    const body = b.error ? `:warning: ${b.reply}` : b.reply;
    return post({
      ...where,
      text: footer ? `${body}\n\n_${b.model} · ${cost}_` : body,
      username: persona?.display_name || b.name,
      icon_emoji: emojiFor(b.name, persona)
    });
  }

  async function runCommand({ cmd, rest, args }, where) {
    switch (cmd) {
      case 'roster':
        await say(room.roster().text, where);
        return { ok: true, command: 'roster' };

      case 'recruit': {
        const { head, tail } = splitTail(rest);
        const [name, model] = head.split(/\s+/);
        if (!name || !model || !tail) {
          await say('Usage: `room recruit <name> <model> -- <system prompt>`', where);
          return { ok: false, command: 'recruit', error: 'usage' };
        }
        const r = await room.recruit({ name, model, system_prompt: tail });
        await say(r.text, where);
        return { ok: r.ok !== false, command: 'recruit', name };
      }

      case 'dismiss': {
        if (!args[0]) {
          await say('Usage: `room dismiss <name>`', where);
          return { ok: false, command: 'dismiss', error: 'usage' };
        }
        const r = room.dismiss({ name: args[0] });
        await say(r.text, where);
        return { ok: r.ok !== false, command: 'dismiss' };
      }

      case 'discuss': {
        const { head, tail } = splitTail(rest);
        const bits = head.split(/\s+/).filter(Boolean);
        const names = (bits[0] || '').split(',').map((s) => s.trim()).filter(Boolean);
        const rounds = Number(bits[1]) || 2;
        if (names.length < 2 || !tail) {
          await say('Usage: `room discuss <name>,<name> [rounds] -- <topic>`', where);
          return { ok: false, command: 'discuss', error: 'usage' };
        }
        const r = await room.discuss({ names, topic: tail, rounds, host: HOST });
        if (r.ok === false) {
          await say(r.text, where);
          return { ok: false, command: 'discuss' };
        }
        await say(`*Discussion:* ${tail}`, where);
        for (const b of r.blocks) await postReply(b, where);
        return { ok: true, command: 'discuss', blocks: r.blocks };
      }

      case 'help':
        await say(HELP, where);
        return { ok: true, command: 'help' };

      default:
        await say(`Unknown command \`room ${cmd}\`.\n\n${HELP}`, where);
        return { ok: false, command: cmd, error: 'unknown command' };
    }
  }

  // Slack event -> room. Returns a result object; never throws for ordinary
  // traffic, so a bad message can't take the socket down.
  async function handleEvent(event = {}) {
    if (!event || (event.type !== 'message' && event.type !== 'app_mention')) {
      return { ok: false, ignored: 'not a message event' };
    }
    // Never react to ourselves or to another bot: that is how loops start.
    if (event.bot_id || event.subtype === 'bot_message') return { ok: false, ignored: 'bot message' };
    if (botUserId && event.user === botUserId) return { ok: false, ignored: 'own message' };
    if (event.subtype && event.subtype !== 'file_share') return { ok: false, ignored: `subtype ${event.subtype}` };

    const text = String(event.text || '').replace(BOT_MENTION, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    if (!text) return { ok: false, ignored: 'empty text' };

    const where = { channel: event.channel, thread_ts: event.thread_ts || event.ts };

    // The room's own log is the only history we keep; Slack is never read back.
    room.events.append({
      author: event.user_name || event.user || 'user',
      role: 'user', text, channel: event.channel, slack_ts: event.ts
    });

    const cmd = parseCommand(text);
    if (cmd) return runCommand(cmd, where);

    const known = knownNames();
    const { names, per } = routeMentions(text, known);

    if (!names.length) {
      const unknown = rawMentions(text).filter((n) => !known.includes(n));
      if (unknown.length) {
        const who = unknown.map((n) => `@${n}`).join(', ');
        const roster = known.length ? known.map((n) => `@${n}`).join(', ') : '(nobody yet)';
        await say(
          `${who} ${unknown.length > 1 ? 'are' : 'is'} not in the room. Currently here: ${roster}.\n` +
          'Add someone with `room recruit <name> <model> -- <system prompt>`.',
          where
        );
        return { ok: false, unknown, ignored: 'unknown recruit' };
      }
      return { ok: false, ignored: 'no recruit mentioned' };
    }

    const r = await room.ask({ names, per, host: HOST });
    if (r.ok === false) {
      await say(r.text, where);
      return { ok: false, error: r.error };
    }
    for (const b of r.blocks) await postReply(b, where);
    return { ok: true, names, per, blocks: r.blocks };
  }

  return { handleEvent, runCommand, postReply, knownNames, room, transport };
}

// --- live wiring -------------------------------------------------------------
export function createSlackRoom(opts = {}) {
  const stateDir = opts.stateDir || process.env.ROOM_STATE_DIR || DEFAULT_STATE_DIR;
  return createRoom({
    ...opts,
    stateDir,
    host: HOST,
    digestSource: opts.digestSource || createEventLogSource(stateDir)
  });
}

export const boltTransport = (app) => ({
  postMessage: (args) => app.client.chat.postMessage(args)
});

// Requires @slack/bolt (see this directory's package.json and README).
export async function start({
  token = process.env.SLACK_BOT_TOKEN,
  appToken = process.env.SLACK_APP_TOKEN,
  room,
  ...opts
} = {}) {
  if (!token || !appToken) {
    throw new Error('SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required — see adapters/slack/README.md');
  }
  let App;
  try {
    ({ App } = await import('@slack/bolt'));
  } catch {
    throw new Error('@slack/bolt is not installed — run `npm install` in adapters/slack/');
  }

  const app = new App({ token, appToken, socketMode: true });
  const auth = await app.client.auth.test();
  const bot = createSlackBot({
    room: room || createSlackRoom(opts),
    transport: boltTransport(app),
    botUserId: auth.user_id,
    ...opts
  });

  const safely = async (event) => {
    try { await bot.handleEvent(event); }
    catch (e) { console.error('[room] event failed:', e?.message || e); }
  };
  app.event('app_mention', ({ event }) => safely({ ...event, type: 'app_mention' }));
  app.message(({ message }) => safely({ ...message, type: 'message' }));

  await app.start();
  console.error(`[room] slack adapter live as ${auth.user}; state: ${bot.room.stateDir}`);
  return { app, bot };
}

export default { createSlackBot, createSlackRoom, start, routeMentions, parseCommand, emojiFor, HOST };

// `node adapters/slack/bot.mjs` starts the bot; importing it does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((e) => { console.error(`[room] ${e?.message || e}`); process.exit(1); });
}
