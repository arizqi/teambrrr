import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {ensureRoom,joinRoom,localRequest} from '../core/session-manager.mjs';
import {createChatMcp} from '../server/session-chat.mjs';
import {createChannelMcp} from '../server/session-channel.mjs';
import {check,done,SCRATCH} from './_harness.mjs';
const require=createRequire(new URL('../server/package.json',import.meta.url));
const {Client}=await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const {InMemoryTransport}=await import(require.resolve('@modelcontextprotocol/sdk/inMemory.js'));
const {z}=await import(require.resolve('zod'));
const root=path.join(SCRATCH,'embedded-chat'),clients=[];let channel;
async function connect(server){const [a,b]=InMemoryTransport.createLinkedPair();const c=new Client({name:'chat-test',version:'1'});clients.push(c);await server.connect(a);await c.connect(b);return c}
function data(r){if(r.isError)throw Error(r.content[0].text);return r.structuredContent||JSON.parse(r.content[0].text)}
const call=(c,name,args)=>c.callTool({name,arguments:args});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const room=await ensureRoom({root,name:'test',create:true});
 await joinRoom({root,name:'test',host:'codex',sessionId:'cx'});
 await joinRoom({root,name:'test',host:'claude',sessionId:'cl'});
 const c=await connect(createChatMcp({root}));
 const s=data(await call(c,'chat_open',{name:'test'})),binding={name:'test',room_id:s.room_id};
 check(s.participants.human.label==='You','Embedded room opens existing transcript');
 const tools=(await c.listTools()).tools;
 check(tools.find(t=>t.name==='chat_send')._meta.ui.visibility[0]==='app','Human send is exposed only to the app UI');
 const resource=await c.readResource({uri:tools.find(t=>t.name==='chat_open')._meta.ui.resourceUri});
 check(resource.contents[0].mimeType==='text/html;profile=mcp-app'&&resource.contents[0].text.includes('ui/initialize'),'Chat resource uses verified MCP Apps bridge');
 check(!JSON.stringify(s).includes('token')&&!resource.contents[0].text.includes('Bearer'),'Neither room results nor widget expose credentials');
 const args={...binding,message:'@claude Review this <script> safely',idempotency_key:'human-first'};
 const sent=data(await call(c,'chat_send',args)).event;
 check(sent.actor==='human'&&sent.to==='claude','UI messages preserve human sender and explicit recipient');
 check(data(await call(c,'chat_send',args)).event.id===sent.id,'Uncertain UI send retries do not duplicate messages');
 check((await call(c,'chat_send',{...args,message:'@missing hello',idempotency_key:'bad'})).isError,'Unknown mention rejected');
 check((await call(c,'chat_send',{...args,message:'hello',idempotency_key:'bad'})).isError,'Unaddressed input rejected');
 check((await call(c,'chat_send',{...args,room_id:'00000000-0000-4000-8000-000000000000'})).isError,'Stale widget cannot send to a replaced room');
 channel=await createChannelMcp({root,name:'test',sessionId:'cl',hostSessionId:'cl',pollMs:30});
 const cl=await connect(channel.server),events=[];
 cl.setNotificationHandler(z.object({method:z.literal('notifications/claude/channel'),params:z.object({content:z.string(),meta:z.record(z.string())})}),e=>{events.push(e.params)});
 check(cl.getServerCapabilities().experimental['claude/channel']!==undefined,'Channel declares Claude push capability');
 channel.start();for(let i=0;i<100&&!events.length;i++)await delay(20);
 check(events.length===1&&events[0].meta.message_id===sent.id&&events[0].meta.sender==='human','Human message reaches channel as attributed notification');
 const before=data(await call(c,'chat_read',binding));
 check(!before.events.some(e=>e.kind==='ack'),'Transport delivery never fabricates acknowledgment');
 const reply=data(await call(cl,'channel_reply',{message_id:sent.id,text:'Here are the findings.',idempotency_key:'reply-one'}));
 const after=data(await call(c,'chat_read',binding));
 check(reply.actor==='claude'&&reply.to==='human'&&after.events.some(e=>e.id===reply.id),'Claude reply appears in shared human transcript');
 check(after.events.some(e=>e.kind==='ack'&&e.messageId===sent.id),'Reply explicitly acknowledges incoming message');
 await call(c,'chat_pause',{...binding,paused:true,idempotency_key:'pause'});
 const paused=data(await call(c,'chat_send',{...binding,message:'@claude Wait for resume',idempotency_key:'paused'})).event;
 await delay(120);check(!events.some(e=>e.meta.message_id===paused.id),'Paused room prevents new channel forwarding');
 check((await call(cl,'channel_reply',{message_id:paused.id,text:'blocked',idempotency_key:'paused-reply'})).isError,'Pause prevents Claude replies');
 await call(c,'chat_pause',{...binding,paused:false,idempotency_key:'resume'});
 for(let i=0;i<100&&!events.some(e=>e.meta.message_id===paused.id);i++)await delay(20);
 check(events.some(e=>e.meta.message_id===paused.id),'Resuming forwards queued messages');
 await delay(100);check(events.filter(e=>e.meta.message_id===paused.id).length===1,'Polling does not repeat notifications in one connection');
 channel.stop();await cl.close();
 channel=await createChannelMcp({root,name:'test',sessionId:'cl',hostSessionId:'cl',pollMs:30});
 const reconnected=await connect(channel.server),replayed=[];
 reconnected.setNotificationHandler(z.object({method:z.literal('notifications/claude/channel'),params:z.object({content:z.string(),meta:z.record(z.string())})}),e=>{replayed.push(e.params)});
 channel.start();for(let i=0;i<100&&!replayed.length;i++)await delay(20);
 check(replayed.some(e=>e.meta.message_id===paused.id),'Unacknowledged notification replays on reconnect');
 check(!replayed.some(e=>e.meta.message_id===sent.id),'Acknowledged message does not replay on reconnect');
 let refused=false;try{await createChannelMcp({root,name:'test',sessionId:'cl',hostSessionId:'other'})}catch{refused=true}
 check(refused,'Channel refuses a mismatched host session');
 const human=path.join(room.dir,'human.json');
 const unrelated=await localRequest(human,'/events',{kind:'message',to:'codex',text:'For Codex',key:'codex-only'});
 check((await call(reconnected,'channel_reply',{message_id:unrelated.id,text:'wrong',idempotency_key:'wrong'})).isError,'Channel cannot reply to another participant inbox');
}finally{
 channel?.stop();for(const c of clients)await c.close();
 const lock=path.join(root,'test','server.lock');if(fs.existsSync(lock)){const pid=Number(fs.readFileSync(lock));process.kill(pid,'SIGTERM');for(let i=0;i<100&&fs.existsSync(lock);i++)await delay(20)}
}
done();
