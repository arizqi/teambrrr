import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ensureRoom, joinRoom, listRooms, localRequest } from '../core/session-manager.mjs';
import { Client, StdioClientTransport } from './mcp-sdk.mjs';
import { check, done, SCRATCH } from './_harness.mjs';
const root = path.join(SCRATCH, 'named-rooms'), clients = [];
const env = Object.fromEntries(Object.entries(process.env).filter(([k,v]) => typeof v === 'string' && !['CODEX_THREAD_ID','CLAUDE_CODE_SESSION_ID'].includes(k)));
async function client(host) {
  const c = new Client({ name:'lifecycle-test',version:'1' }); clients.push(c);
  await c.connect(new StdioClientTransport({ command:process.execPath,args:[fileURLToPath(new URL('../server/session.mjs',import.meta.url)),'--host',host,'--root',root],env }));
  return c;
}
const call = (c,name,args={}) => c.callTool({name,arguments:args});
const data = r => { if(r.isError) throw Error(r.content[0].text); return JSON.parse(r.content[0].text); };
async function stop(name, signal = 'SIGTERM') {
  const dir=path.join(root,name), lock=path.join(dir,'server.lock');
  if(!fs.existsSync(lock))return;
  const pid=Number(fs.readFileSync(lock));try{process.kill(pid,signal)}catch(e){if(e.code!=='ESRCH')throw e}
  for(let n=0;n<60;n++){try{process.kill(pid,0)}catch(e){if(e.code==='ESRCH')return}await new Promise(r=>setTimeout(r,50))}
  throw Error('Test daemon did not exit');
}
try {
  const starts=await Promise.all([ensureRoom({root,name:'alpha',create:true}),ensureRoom({root,name:'alpha',create:true})]);
  check(starts[0].state.id===starts[1].state.id,'Concurrent start converges on one room and daemon');
  const a=await joinRoom({root,name:'alpha',host:'codex',sessionId:'codex-one'});
  const b=await joinRoom({root,name:'alpha',host:'claude',sessionId:'claude-one'});
  check(a.actor==='codex'&&b.actor==='claude','Named room enrolls two actual session identities');
  const again=await joinRoom({root,name:'alpha',host:'codex',sessionId:'codex-one'});
  check(again.actor===a.actor&&Object.keys(again.state.participants).length===3,'Repeated join preserves identity without duplicate enrollment');
  const c=await joinRoom({root,name:'alpha',host:'codex',sessionId:'codex-two'});
  check(c.actor!==a.actor&&c.state.participants.codex.sessionId==='codex-one','Second Codex session cannot overwrite first');
  let refused=false;try{await localRequest(a.configPath,'/participants',{host:'claude',sessionId:'bad'})}catch{refused=true}
  check(refused,'Ordinary participant credential cannot enroll peers');
  const sent=await localRequest(a.configPath,'/events',{kind:'message',to:b.actor,text:'Persist across crash',key:'before-crash'});
  await stop('alpha','SIGKILL');
  const recovered=await ensureRoom({root,name:'alpha'});
  check(recovered.started&&recovered.state.events.some(e=>e.id===sent.id),'Daemon crash recovers automatically with transcript intact');
  check((await joinRoom({root,name:'alpha',host:'codex',sessionId:'codex-one'})).actor===a.actor,'Recovered daemon preserves enrollment');
  let missing=false;try{await joinRoom({root,name:'missing',host:'codex',sessionId:'x'})}catch{missing=true}
  check(missing&&!fs.existsSync(path.join(root,'missing')),'Join typo does not create a new room');
  let traversal=false;try{await ensureRoom({root,name:'../escape',create:true})}catch{traversal=true}
  check(traversal,'Room names cannot escape root');
  const cx=await client('codex'),cl=await client('claude');
  check((await cx.listTools()).tools.length===7,'Named MCP advertises start and list alongside messaging');
  const first=data(await call(cx,'room_start',{name:'beta',session_id:'cx-beta'}));
  const second=data(await call(cl,'room_join',{name:'beta',session_id:'cl-beta'}));
  check(first.room_id===second.room_id,'Two hosts join same named room using MCP only');
  const m=data(await call(cx,'room_send',{to:'claude',message:'Named MCP hello',idempotency_key:'hello'}));
  check(data(await call(cl,'room_read')).inbox.some(e=>e.id===m.id),'Named MCP routes real messages');
  check(!data(await call(cl,'room_read')).events.some(e=>e.id===sent.id),'Rooms do not share transcripts');
  await stop('beta','SIGKILL');
  check(data(await call(cl,'room_read')).inbox.some(e=>e.id===m.id),'Existing MCP client restarts a crashed daemon transparently');
  check(data(await call(cx,'room_list')).rooms.length===2,'MCP lists named rooms without changing membership');
  const index=fileURLToPath(new URL('../server/index.mjs',import.meta.url));
  const cli=spawnSync(process.execPath,[index,'start','cli-room','--root',root],{env,encoding:'utf8',timeout:15000});
  check(cli.status===0&&JSON.parse(cli.stdout).name==='cli-room','teambrrr start works from an ordinary terminal without session IDs');
  const cliJoin=spawnSync(process.execPath,[index,'join','cli-room','--host','claude','--session','cli-session','--root',root],{env,encoding:'utf8',timeout:15000});
  check(cliJoin.status===0&&JSON.parse(cliJoin.stdout).actor==='claude','teambrrr join enrolls session from terminal');
} finally {
  for(const c of clients)await c.close();
  for(const room of listRooms(root))await stop(room.name);
}
done();
