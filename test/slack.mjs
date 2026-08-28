#!/usr/bin/env node
// Slack adapter, driven entirely through a fake transport: no @slack/bolt, no
// socket, no network. Covers mention routing, the username/icon overrides, the
// text commands, and what happens when someone addresses a stranger.
import fs from 'node:fs';
import path from 'node:path';
import { check, done, SCRATCH } from './_harness.mjs';
import { createRoom } from '../core/room.mjs';
import { createEventLogSource } from '../core/digest/event-log.mjs';
import {
  createSlackBot, routeMentions, parseCommand, stripMentions, rawMentions, emojiFor, HOST
} from '../adapters/slack/bot.mjs';

const ROOT = path.join(SCRATCH, 'slack-test');
fs.rmSync(ROOT, { recursive: true, force: true });
const mk = (...p) => { const d = path.join(ROOT, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

console.log('slack adapter tests\n');

// The entire Slack surface the bot is allowed to touch.
function fakeTransport() {
  const sent = [];
  return { sent, postMessage: async (args) => { sent.push(args); return { ok: true, ts: `${sent.length}.0` }; } };
}

const echo = {
  name: 'mock',
  call: async ({ name, messages }) => ({
    text: `${name.toUpperCase()}-REPLY to "${messages[messages.length - 1].content}" | digest:"${String(messages.find((m) => m.__digest)?.content || '').slice(0, 200)}"`,
    cost: 0.0001,
    usage: { prompt_tokens: 1, completion_tokens: 1 }
  })
};

async function setup(tag, { provider = echo, ...opts } = {}) {
  const stateDir = mk(`${tag}-state`);
  const projectDir = mk(`${tag}-proj`);
  const room = createRoom({
    stateDir, projectDir, provider, host: HOST, autoMigrate: false,
    digestSource: createEventLogSource(stateDir), ...opts
  });
  await room.recruit({ name: 'alice', model: 'x/alice', system_prompt: 'alice' });
  await room.recruit({ name: 'bob', model: 'x/bob', system_prompt: 'bob' });
  const transport = fakeTransport();
  return { room, transport, bot: createSlackBot({ room, transport, botUserId: 'UBOT' }) };
}

const msg = (text, over = {}) => ({
  type: 'message', channel: 'C-ROOM', ts: '1700000000.000100',
  user: 'U-HUMAN', text, ...over
});

// -------------------------------------------------- 1. routing units ---------
{
  const known = ['alice', 'bob'];
  const one = routeMentions('@alice what about the locks?', known);
  check(JSON.stringify(one.names) === JSON.stringify(['alice']), 'a single mention routes to one recruit', JSON.stringify(one));
  check(one.per.alice === 'what about the locks?', 'the mention is stripped from the message', one.per.alice);

  const two = routeMentions('@alice locks? @bob and the index rebuild?', known);
  check(JSON.stringify(two.names) === JSON.stringify(['alice', 'bob']), 'both recruits are routed, in order', JSON.stringify(two.names));
  check(two.per.alice === 'locks?' && two.per.bob === 'and the index rebuild?',
    'each recruit gets only the segment after their own name', JSON.stringify(two.per));

  const shared = routeMentions('@alice @bob thoughts?', known);
  check(shared.names.length === 2 && shared.per.alice === 'thoughts?' && shared.per.bob === 'thoughts?',
    'back-to-back mentions both get the whole message', JSON.stringify(shared.per));

  const lead = routeMentions('hey team, @alice can you look?', known);
  check(lead.per.alice === 'hey team, can you look?', 'with one mention the whole message is kept, lead-in included', lead.per.alice);

  check(routeMentions('no mentions at all', known).names.length === 0, 'a plain message routes nowhere');
  check(routeMentions('@ghost hello', known).names.length === 0, 'an unknown name routes nowhere');
  check(routeMentions('email me at bob@example.com', known).names.length === 0, 'an email address is not a mention');
  check(routeMentions('<@U0123ABC> hi there', known).names.length === 0, 'a real Slack user mention is not a recruit mention');
  check(routeMentions('@ALICE shout', known).per.alice === 'shout', 'mentions are case-insensitive');
  check(routeMentions('@alice one @alice two', known).names.length === 1, 'a repeated mention collapses to one');
  check(routeMentions('@alice', known).per.alice === '@alice', 'a bare mention with no text falls back to the raw message');

  check(stripMentions('@alice and @ghost', known) === 'and @ghost', 'stripMentions leaves unknown names alone', stripMentions('@alice and @ghost', known));
  check(JSON.stringify(rawMentions('@alice @ghost @alice')) === JSON.stringify(['alice', 'ghost']), 'rawMentions lists every handle once');

  check(emojiFor('alice') === emojiFor('alice'), 'a recruit keeps the same emoji across calls');
  check(emojiFor('alice') !== emojiFor('bob'), 'different recruits get different emoji');
  check(emojiFor('alice', { icon_emoji: ':dog:' }) === ':dog:', 'a persona can pin its own emoji');
}

// ------------------------------------------- 2. a mention reaches a recruit ---
{
  const { bot, transport, room } = await setup('route');
  const r = await bot.handleEvent(msg('@alice is the migration safe?'));

  check(r.ok && JSON.stringify(r.names) === JSON.stringify(['alice']), 'the event routed to alice', JSON.stringify(r.names));
  check(transport.sent.length === 1, 'exactly one message was posted', `got ${transport.sent.length}`);

  const [p] = transport.sent;
  check(p.channel === 'C-ROOM', 'posted back to the same channel', p.channel);
  check(p.thread_ts === '1700000000.000100', 'the reply threads under the trigger', p.thread_ts);
  check(p.username === 'alice', 'the reply is posted under the recruit name (chat:write.customize)', p.username);
  check(p.icon_emoji === emojiFor('alice'), 'the reply carries the recruit emoji', p.icon_emoji);
  check(p.text.includes('ALICE-REPLY'), "the recruit's own words are posted", p.text.slice(0, 80));
  check(p.text.includes('is the migration safe?'), 'the question reached the recruit', p.text.slice(0, 120));
  check(r.per.alice === 'is the migration safe?', 'the mention was stripped before the recruit saw it', r.per.alice);
  check(/_x\/alice · \$0\.0001_$/.test(p.text.trim()), 'the model and cost are footered for transparency', p.text.slice(-40));

  // bob was never asked
  check(!transport.sent.some((s) => s.username === 'bob'), 'the unaddressed recruit stayed quiet');

  // memory: the room's own log, not Slack history
  // The log keeps the message as it was said, mentions and all — same convention
  // as the chair's own events on the other hosts.
  const ev = room.events.tail(20);
  check(ev.some((e) => e.author === 'U-HUMAN' && e.text === '@alice is the migration safe?'),
    'the triggering Slack message is appended to the room log verbatim', JSON.stringify(ev[0]));
  check(ev.every((e) => e.host === HOST), "events are tagged host:'slack'", JSON.stringify(ev.map((e) => e.host)));

  // a second message sees the first through the digest — no history fetch
  const r2 = await bot.handleEvent(msg('@alice still?', { ts: '1700000000.000200' }));
  const p2 = transport.sent[transport.sent.length - 1];
  check(r2.ok && p2.text.includes('is the migration safe?'),
    'the room log gives the recruit context without reading Slack history', p2.text.slice(0, 200));
}

// ------------------------------------------------- 3. two recruits, one msg ---
{
  const { bot, transport } = await setup('fanout');
  const r = await bot.handleEvent(msg('@alice locks? @bob and the index?'));

  check(r.ok && r.names.length === 2, 'both recruits were asked', JSON.stringify(r.names));
  check(transport.sent.length === 2, 'one post per recruit', `got ${transport.sent.length}`);
  check(r.per.alice === 'locks?' && r.per.bob === 'and the index?',
    'the message was split per recruit before it left the adapter', JSON.stringify(r.per));
  // isolate what each model was actually asked (the echo reply also carries the digest)
  const asked = Object.fromEntries(transport.sent.map((s) => [s.username, s.text.split('| digest:')[0]]));
  check(asked.alice.includes('locks?') && !asked.alice.includes('and the index?'),
    'alice was asked only her own question', asked.alice.slice(0, 120));
  check(asked.bob.includes('and the index?') && !asked.bob.includes('locks?'),
    'bob was asked only his own question', asked.bob.slice(0, 120));
  check(transport.sent[0].icon_emoji !== transport.sent[1].icon_emoji, 'the two replies wear different faces');
}

// --------------------------------------------------- 4. unknown recruit ------
{
  const { bot, transport } = await setup('unknown');
  const r = await bot.handleEvent(msg('@ghost can you take a look?'));

  check(r.ok === false && JSON.stringify(r.unknown) === JSON.stringify(['ghost']), 'the stranger is reported', JSON.stringify(r));
  check(transport.sent.length === 1, 'the room answers once', `got ${transport.sent.length}`);
  const [p] = transport.sent;
  check(p.text.includes('@ghost is not in the room'), 'it says who is missing', p.text.split('\n')[0]);
  check(p.text.includes('@alice') && p.text.includes('@bob'), 'and lists who is actually here', p.text.split('\n')[0]);
  check(p.text.includes('room recruit'), 'and points at the way to add them');
  check(p.username === 'room', 'that answer comes from the room, not a recruit', p.username);
  check(!p.text.includes('REPLY to'), 'no model was called for a stranger');

  transport.sent.length = 0;
  const quiet = await bot.handleEvent(msg('just chatting, no mentions'));
  check(quiet.ok === false && quiet.ignored === 'no recruit mentioned', 'an unaddressed message is ignored', JSON.stringify(quiet));
  check(transport.sent.length === 0, 'and nothing is posted');

  const both = await bot.handleEvent(msg('@ghost @phantom anyone?'));
  check(both.unknown.length === 2 && /are not in the room/.test(transport.sent[0].text),
    'two strangers are reported together', transport.sent[0].text.split('\n')[0]);
}

// -------------------------------------------------------- 5. commands --------
{
  const { bot, transport, room } = await setup('cmd');

  check(parseCommand('room roster').cmd === 'roster', 'parseCommand reads the verb');
  check(parseCommand('ROOM Roster').cmd === 'roster', 'commands are case-insensitive');
  check(parseCommand('not a command') === null, 'ordinary text is not a command');
  check(parseCommand('room').cmd === 'help', 'a bare "room" asks for help');

  // roster
  const ros = await bot.handleEvent(msg('room roster'));
  check(ros.ok && ros.command === 'roster', 'roster command runs', JSON.stringify(ros));
  const rosterPost = transport.sent[transport.sent.length - 1];
  check(rosterPost.text.includes('@alice · x/alice') && rosterPost.text.includes('@bob · x/bob'), 'the roster lists both recruits', rosterPost.text);
  check(rosterPost.text.includes('cap'), 'the roster shows the spend cap');
  check(rosterPost.username === 'room' && rosterPost.icon_emoji === ':speech_balloon:', 'the room posts under its own identity', rosterPost.username);

  // recruit
  const rec = await bot.handleEvent(msg('room recruit carol openai/gpt-4o-mini -- You are a sceptical SRE who has seen this fail before.'));
  check(rec.ok && rec.name === 'carol', 'recruit command creates a recruit', JSON.stringify(rec));
  check(room.store.readPersona('carol')?.model === 'openai/gpt-4o-mini', 'the model is stored', JSON.stringify(room.store.readPersona('carol')));
  check(room.store.readPersona('carol')?.system_prompt === 'You are a sceptical SRE who has seen this fail before.',
    'the whole tail becomes the system prompt', room.store.readPersona('carol')?.system_prompt);
  check(transport.sent[transport.sent.length - 1].text.includes('@carol'), 'the room confirms the hire');

  // the new recruit is immediately addressable
  const useCarol = await bot.handleEvent(msg('@carol what would you check first?'));
  check(useCarol.ok && transport.sent[transport.sent.length - 1].username === 'carol', 'a recruit hired in Slack answers in Slack');

  // bad usage
  const badRec = await bot.handleEvent(msg('room recruit carol'));
  check(badRec.ok === false && /Usage:/.test(transport.sent[transport.sent.length - 1].text), 'malformed recruit gets a usage line', transport.sent[transport.sent.length - 1].text);

  // dismiss
  const dis = await bot.handleEvent(msg('room dismiss carol'));
  check(dis.ok && !room.store.readPersona('carol'), 'dismiss command archives the recruit', JSON.stringify(dis));
  const badDis = await bot.handleEvent(msg('room dismiss'));
  check(badDis.ok === false, 'dismiss with no name is refused');

  // discuss
  transport.sent.length = 0;
  const disc = await bot.handleEvent(msg('room discuss alice,bob 2 -- do we ship on friday?'));
  check(disc.ok && disc.blocks.length === 4, 'discuss command runs two rounds for two recruits', `got ${disc.blocks?.length}`);
  check(transport.sent[0].text.includes('do we ship on friday?'), 'the topic is posted first', transport.sent[0].text);
  check(transport.sent.length === 5, 'one header post plus one post per reply', `got ${transport.sent.length}`);
  check(transport.sent.slice(1).every((s) => s.username === 'alice' || s.username === 'bob'), 'every reply wears its own name');
  const badDisc = await bot.handleEvent(msg('room discuss alice -- solo'));
  check(badDisc.ok === false && /Usage:/.test(transport.sent[transport.sent.length - 1].text), 'a one-person discussion gets a usage line');

  // help / unknown
  const help = await bot.handleEvent(msg('room help'));
  check(help.ok && /room recruit/.test(transport.sent[transport.sent.length - 1].text), 'help lists the commands');
  const huh = await bot.handleEvent(msg('room frobnicate'));
  check(huh.ok === false && /Unknown command/.test(transport.sent[transport.sent.length - 1].text), 'an unknown command is reported', transport.sent[transport.sent.length - 1].text.split('\n')[0]);
}

// ------------------------------------------------- 6. loop safety + shapes ---
{
  const { bot, transport } = await setup('safety');

  const cases = [
    [{ ...msg('@alice hi'), bot_id: 'B123' }, 'a bot_id message is dropped'],
    [{ ...msg('@alice hi'), subtype: 'bot_message' }, 'a bot_message subtype is dropped'],
    [{ ...msg('@alice hi'), user: 'UBOT' }, 'the app never answers itself'],
    [{ ...msg('@alice hi'), subtype: 'message_changed' }, 'an edit is not re-answered'],
    [msg('   '), 'an empty message is dropped'],
    [{ type: 'reaction_added', channel: 'C1' }, 'a non-message event is dropped']
  ];
  for (const [event, label] of cases) {
    const before = transport.sent.length;
    const r = await bot.handleEvent(event);
    check(r.ok === false && transport.sent.length === before, label, JSON.stringify(r));
  }

  // app_mention: the <@BOT> token is stripped, the rest routes normally
  const am = await bot.handleEvent({
    type: 'app_mention', channel: 'C-ROOM', ts: '1700000000.000900', user: 'U-HUMAN',
    text: '<@UBOT> @alice what do you think?'
  });
  check(am.ok && am.names[0] === 'alice', 'an app_mention still routes to the recruit', JSON.stringify(am.names));
  check(am.per.alice === 'what do you think?', 'the bot token is stripped from the question', am.per.alice);

  // threading: a reply inside a thread stays in that thread
  transport.sent.length = 0;
  await bot.handleEvent(msg('@alice in-thread', { ts: '1700000000.001000', thread_ts: '1700000000.000500' }));
  check(transport.sent[0].thread_ts === '1700000000.000500', 'a threaded question is answered in its thread', transport.sent[0].thread_ts);
}

// ------------------------------------------------- 7. errors and budget ------
{
  const dead = { name: 'mock', call: async () => { const e = new Error('OpenRouter 401: bad key'); e.status = 401; throw e; } };
  const { bot, transport } = await setup('errors', { provider: dead, retryDelayMs: 5 });
  const r = await bot.handleEvent(msg('@alice hello'));
  check(r.ok, 'a model failure still produces a post');
  check(/:warning:/.test(transport.sent[0].text), 'the failure is posted as a warning, not swallowed', transport.sent[0].text.slice(0, 80));
  check(transport.sent[0].username === 'alice', 'the error is still attributed to the recruit');
  check(transport.sent[0].text.includes('bad key'), 'the real error text is shown');

  // budget refusal comes from the room, not a recruit
  const paid = { name: 'mock', call: async () => ({ text: 'pricey', cost: 0.9 }) };
  const b = await setup('budget', { provider: paid, budget: 0.5 });
  await b.bot.handleEvent(msg('@alice one'));
  b.transport.sent.length = 0;
  const blocked = await b.bot.handleEvent(msg('@alice two'));
  check(blocked.ok === false && /spend cap reached/.test(b.transport.sent[0].text), 'the spend cap is reported in channel', b.transport.sent[0].text);
  check(b.transport.sent[0].username === 'room', 'the cap notice comes from the room', b.transport.sent[0].username);
}

// ---------------------------------------------------- 8. construction --------
{
  let threw = null;
  try { createSlackBot({ transport: fakeTransport() }); } catch (e) { threw = e; }
  check(/needs a room/.test(threw?.message || ''), 'createSlackBot demands a room', threw?.message);
  threw = null;
  try { createSlackBot({ room: {} }); } catch (e) { threw = e; }
  check(/postMessage/.test(threw?.message || ''), 'createSlackBot demands a transport', threw?.message);

  const { room, transport } = await setup('nofooter');
  const plain = createSlackBot({ room, transport, footer: false });
  await plain.handleEvent(msg('@alice hi'));
  check(!/_x\/alice/.test(transport.sent[0].text), 'footer:false posts the bare reply', transport.sent[0].text.slice(-40));
}

done();
