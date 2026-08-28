#!/usr/bin/env node
// Warm-start tests: onboarding briefings and the pin board.
//
// The property under test is not "a file was written" but "the recruit actually
// saw it, in the right place, in the right order" — so most checks read the
// message array a spy provider was handed.
import fs from 'node:fs';
import path from 'node:path';
import { check, done, SCRATCH } from './_harness.mjs';
import { createRoom, PIN_BUDGET_CHARS, BRIEF_HEADER, PINS_HEADER } from '../core/room.mjs';
import { createEventLogSource } from '../core/digest/event-log.mjs';

const ROOT = path.join(SCRATCH, 'context-test');
fs.rmSync(ROOT, { recursive: true, force: true });
const mk = (...p) => { const d = path.join(ROOT, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

console.log('warm-start tests (briefings + pins)\n');

// A provider that records exactly what it was handed.
function spyProvider() {
  const seen = [];
  return {
    seen,
    name: 'mock',
    call: async ({ messages }) => { seen.push(messages); return { text: 'ok', cost: 0 }; },
    last: () => seen[seen.length - 1]
  };
}

const roomAt = (stateDir, projectDir, provider, extra = {}) => createRoom({
  stateDir, projectDir, provider, host: 'test', autoMigrate: false,
  digestSource: createEventLogSource(stateDir), ...extra
});

// ------------------------------------------------------------ 1. briefings ---
{
  const stateDir = mk('state1');
  const projectDir = mk('proj1');
  const spy = spyProvider();
  const room = roomAt(stateDir, projectDir, spy);

  const cold = await room.recruit({ name: 'cold', model: 'x/c', system_prompt: 'you are cold' });
  check(cold.ok && cold.briefing === null, 'a recruit hired with no briefing has none');
  check(/No onboarding brief/.test(cold.text), 'and recruit() says so out loud', cold.text);

  const BRIEF = 'Project: persona-recruiter.\nGoal: recruits start warm.\nCodenames: "the chair" is Claude.';
  const warm = await room.recruit({ name: 'warm', model: 'x/w', system_prompt: 'you are warm', briefing: BRIEF });
  check(warm.ok && warm.briefing === BRIEF, 'recruit() accepts a briefing');
  const briefFile = path.join(stateDir, 'recruits', 'warm', 'briefing.md');
  check(fs.existsSync(briefFile), 'briefing stored at recruits/<name>/briefing.md');
  check(fs.readFileSync(briefFile, 'utf8') === BRIEF, 'stored verbatim');
  check(!fs.existsSync(path.join(stateDir, 'recruits', 'cold', 'briefing.md')), 'no file written for a briefless recruit');

  await room.ask({ name: 'warm', message: 'q' });
  const msgs = spy.last();
  const brief = msgs.find((m) => m.__briefing);
  check(!!brief, 'the briefing is injected into the provider call');
  check(brief.role === 'system', 'as a system message');
  check(brief.content.startsWith(BRIEF_HEADER), 'prefixed with the onboarding header', brief.content.slice(0, 60));
  check(brief.content.includes('Goal: recruits start warm.'), 'carrying the brief body');

  await room.ask({ name: 'cold', message: 'q' });
  check(!spy.last().some((m) => m.__briefing), 'a briefless recruit gets no brief block');
}

// -------------------------------------------------------- 2. brief_update ----
{
  const stateDir = mk('state2');
  const projectDir = mk('proj2');
  const spy = spyProvider();
  const room = roomAt(stateDir, projectDir, spy);
  await room.recruit({ name: 'ada', model: 'x/a', system_prompt: 'ada', briefing: 'BRIEF-ONE' });

  const shown1 = room.showPersona({ name: 'ada' });
  check(shown1.briefing === 'BRIEF-ONE', 'show_persona returns the current briefing');
  check(shown1.briefing_revision === 1, 'at revision 1', String(shown1.briefing_revision));
  check(shown1.text.includes('briefing: rev 1 (original)'), 'and renders the revision count', shown1.text.split('\n')[4]);
  check(shown1.text.includes('— onboarding brief (rev 1) —'), 'and prints the brief itself');

  const up = room.briefUpdate({ name: 'ada', briefing: 'BRIEF-TWO' });
  check(up.ok && up.revision === 2 && up.from === 1, 'brief_update bumps to rev 2', JSON.stringify({ r: up.revision, f: up.from }));
  const snap = path.join(stateDir, 'recruits', 'ada', 'briefings', '1.md');
  check(fs.readFileSync(snap, 'utf8') === 'BRIEF-ONE', 'rev 1 snapshotted to briefings/1.md');
  check(fs.readFileSync(path.join(stateDir, 'recruits', 'ada', 'briefing.md'), 'utf8') === 'BRIEF-TWO', 'current brief replaced');

  const up2 = room.briefUpdate({ name: 'ada', briefing: 'BRIEF-THREE' });
  check(up2.revision === 3 && fs.readFileSync(path.join(stateDir, 'recruits', 'ada', 'briefings', '2.md'), 'utf8') === 'BRIEF-TWO',
    'a second update snapshots rev 2 and moves to rev 3', String(up2.revision));
  check(room.showBriefing({ name: 'ada', revision: 1 }).briefing === 'BRIEF-ONE', 'superseded briefs stay readable');
  check(room.showPersona({ name: 'ada' }).text.includes('briefing: rev 3 (2 superseded)'), 'show_persona counts the superseded ones');

  await room.ask({ name: 'ada', message: 'q' });
  const brief = spy.last().find((m) => m.__briefing);
  check(brief.content.includes('BRIEF-THREE') && !brief.content.includes('BRIEF-ONE'), 'only the current brief is injected');

  // the persona chain is a separate chain
  await room.updatePersona({ name: 'ada', system_prompt: 'ada, revised' });
  check(room.showPersona({ name: 'ada' }).briefing_revision === 3, 'a persona edit does not touch the brief chain');
  check(fs.readFileSync(path.join(stateDir, 'recruits', 'ada', 'history.jsonl'), 'utf8').length > 0, 'memory survives a re-brief');

  check(room.briefUpdate({ name: 'ghost', briefing: 'x' }).ok === false, 'brief_update refuses an unknown recruit');
  check(room.briefUpdate({ name: 'ada' }).ok === false, 'brief_update refuses an empty briefing');
  const first = room.briefUpdate({ name: 'ada2', briefing: 'x' });
  check(first.ok === false && /never creates/.test(first.text), 'brief_update never creates a recruit', first.text);
}

// --------------------------------------------------------------- 3. pins ----
{
  const stateDir = mk('state3');
  const projectDir = mk('proj3');
  const spy = spyProvider();
  const room = roomAt(stateDir, projectDir, spy);
  await room.recruit({ name: 'pat', model: 'x/p', system_prompt: 'pat' });

  check(room.pins().pins.length === 0, 'the pin board starts empty');
  check(/No pins/.test(room.pins().text), 'and says so');

  const p1 = room.pin({ text: 'We ship Postgres, not Dynamo.', by: 'ashar' });
  check(p1.ok && typeof p1.id === 'string', 'pin returns an id', p1.id);
  check(fs.existsSync(path.join(stateDir, 'pins.json')), 'pins.json written to the state dir');
  const p2 = room.pin({ text: 'No git operations without asking.' });
  check(room.pins().pins.length === 2, 'both pins listed');
  check(room.pins().text.includes(p1.id) && room.pins().text.includes('ashar'), 'the listing carries id and author');
  check(room.pins().used === 'We ship Postgres, not Dynamo.'.length + 'No git operations without asking.'.length,
    'used chars are the sum of the pin texts', String(room.pins().used));

  await room.ask({ name: 'pat', message: 'q' });
  const msgs = spy.last();
  const pinsMsg = msgs.find((m) => m.__pins);
  check(!!pinsMsg && pinsMsg.role === 'system', 'the pin board is injected as a system message');
  check(pinsMsg.content.startsWith(PINS_HEADER), 'under the pinned-context header', pinsMsg.content.slice(0, 40));
  check(pinsMsg.content.includes('- We ship Postgres, not Dynamo. — ashar'), 'one line per pin, with the author', pinsMsg.content);

  const gone = room.unpin({ id: p2.id });
  check(gone.ok && room.pins().pins.length === 1, 'unpin removes exactly one pin', gone.text);
  check(room.unpin({ id: 'nope' }).ok === false, 'unpin refuses an unknown id');
  check(room.unpin({}).ok === false, 'unpin needs an id');
  check(room.pin({ text: '   ' }).ok === false, 'pin refuses empty text');

  // discuss carries the pins too; audition does not go through this path at all
  await room.recruit({ name: 'quinn', model: 'x/q', system_prompt: 'quinn' });
  await room.discuss({ names: ['pat', 'quinn'], topic: 't', rounds: 1 });
  check(spy.last().some((m) => m.__pins), 'discuss rounds carry the pin board as well');
}

// ------------------------------------------------------- 4. pin budget ------
{
  const stateDir = mk('state4');
  const projectDir = mk('proj4');
  const room = roomAt(stateDir, projectDir, spyProvider());

  const big = 'x'.repeat(PIN_BUDGET_CHARS - 10);
  check(room.pin({ text: big }).ok, 'a pin just under the budget is accepted');
  const over = room.pin({ text: 'yyyyyyyyyyyyyyyyyyyy' });
  check(over.ok === false, 'the pin that would cross the budget is refused');
  check(/unpin\(\{id\}\)/.test(over.text) && /shorten/.test(over.text),
    'and the refusal says how to fix it (unpin or shorten)', over.text);
  check(/of 2000 chars already pinned/.test(over.text), 'quoting the budget', over.text);
  check(room.pins().pins.length === 1, 'the refused pin was not written');

  const exact = room.pin({ text: 'z'.repeat(10) });
  check(exact.ok, 'a pin that exactly fills the budget is accepted');
  check(room.pins().used === PIN_BUDGET_CHARS, 'the board is now exactly full', String(room.pins().used));
  check(room.pin({ text: 'a' }).ok === false, 'and one more char is refused');
}

// --------------------------------------------- 5. overlay pins stack ---------
{
  const stateDir = mk('state5');
  const projectDir = mk('proj5');
  const spy = spyProvider();
  fs.mkdirSync(path.join(projectDir, '.room'), { recursive: true });
  const room = roomAt(stateDir, projectDir, spy);
  await room.recruit({ name: 'ola', model: 'x/o', system_prompt: 'ola' });

  room.pin({ text: 'GLOBAL-PIN' });
  const proj = room.pin({ text: 'PROJECT-PIN', scope: 'project' });
  check(proj.ok && fs.existsSync(path.join(projectDir, '.room', 'pins.json')), 'a project pin lands in the overlay');
  check(!fs.readFileSync(path.join(stateDir, 'pins.json'), 'utf8').includes('PROJECT-PIN'), 'and not in the global file');

  const listed = room.pins();
  check(listed.pins.length === 2, 'overlay pins STACK on global ones rather than shadowing', String(listed.pins.length));
  check(listed.pins[0].text === 'GLOBAL-PIN' && listed.pins[1].text === 'PROJECT-PIN', 'global first, project second');
  check(listed.pins[1].__scope === 'project', 'each pin carries its scope');
  check(listed.used === 'GLOBAL-PIN'.length + 'PROJECT-PIN'.length, 'the budget counts both scopes together', String(listed.used));

  await room.ask({ name: 'ola', message: 'q' });
  const pinsMsg = spy.last().find((m) => m.__pins);
  check(pinsMsg.content.includes('GLOBAL-PIN') && pinsMsg.content.includes('PROJECT-PIN'), 'the recruit sees both');

  check(room.unpin({ id: proj.id }).ok && room.pins().pins.length === 1, 'unpin reaches into the overlay too');
}

// ------------------------------------------------ 6. injection ORDER ---------
// The layout a recruit actually receives. This is the check that would catch a
// refactor quietly moving the brief after the transcript.
{
  const stateDir = mk('state6');
  const projectDir = mk('proj6');
  const spy = spyProvider();
  const room = roomAt(stateDir, projectDir, spy);
  await room.recruit({ name: 'ord', model: 'x/o', system_prompt: 'PERSONA-TEXT', briefing: 'BRIEF-TEXT' });
  room.pin({ text: 'PIN-TEXT' });
  room.events.append({ author: 'user', role: 'user', text: 'DIGEST-TEXT' });

  await room.ask({ name: 'ord', message: 'FIRST-Q' });
  await room.ask({ name: 'ord', message: 'SECOND-Q' });
  const m = spy.last();

  check(m[0].role === 'system' && m[0].content.startsWith('PERSONA-TEXT'), '1. persona system prompt');
  check(m[1].__briefing === true && m[1].content.startsWith(BRIEF_HEADER), '2. onboarding brief');
  check(m[2].__pins === true && m[2].content.startsWith(PINS_HEADER), '3. pinned room context');
  check(m[3].__digest === true && m[3].content.includes('DIGEST-TEXT'), '4. channel transcript');
  check(m[4].role === 'user' && m[4].content === 'FIRST-Q', '5. history: the earlier question');
  check(m[5].role === 'assistant', '6. history: the earlier answer');
  check(m[m.length - 1].role === 'user' && m[m.length - 1].content === 'SECOND-Q', '7. the message, last');
  check(m.length === 7, 'and nothing else', String(m.length));

  // the brief and the pins must not leak into the persona system message
  check(!m[0].content.includes('BRIEF-TEXT') && !m[0].content.includes('PIN-TEXT'),
    'the persona message is not polluted with either block');
}

// ------------------------------------------------------- 7. watch flag -------
{
  const stateDir = mk('state7');
  const projectDir = mk('proj7');
  const room = roomAt(stateDir, projectDir, spyProvider());
  await room.recruit({ name: 'quiet', model: 'x/q', system_prompt: 'q' });
  await room.recruit({ name: 'eye', model: 'x/e', system_prompt: 'e', watch: true });

  const names = (list) => list.filter((p) => p.watch === true).map((p) => p.name);
  check(JSON.stringify(names(room.store.listPersonas())) === JSON.stringify(['eye']), 'recruit({watch:true}) marks the persona');
  check(room.showPersona({ name: 'eye' }).text.includes('watch: on'), 'show_persona reports it');

  await room.updatePersona({ name: 'quiet', watch: true });
  check(names(room.store.listPersonas()).sort().join(',') === 'eye,quiet', 'update_persona can switch watching on');
  await room.updatePersona({ name: 'eye', watch: false });
  check(names(room.store.listPersonas()).join(',') === 'quiet', 'and off again');
  check(room.store.readPersona('eye').watch === undefined, 'watch:false clears the field rather than storing false');
}

done();
