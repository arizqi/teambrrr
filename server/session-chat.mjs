#!/usr/bin/env node
// Human-facing MCP App. Credentials remain in this process, never in the iframe.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { defaultRoomsRoot, ensureRoom, localRequest } from '../core/session-manager.mjs';

import {startTeam,stopTeam,launchStatus} from '../core/session-launcher.mjs';

export function createChatMcp({root=defaultRoomsRoot()}={}) {
  const server=new McpServer({name:'teambrrr-chat',version:'0.1.0'});
  const uri='ui://teambrrr/chat-v1.html';
  const name=z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);
  const binding={name,room_id:z.string().uuid()};
  const appOnly={ui:{visibility:['app']}};
  const wrap=fn=>async args=>{try{const data=await fn(args);return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data}}catch(e){return {isError:true,content:[{type:'text',text:e.message}]}}};
  async function room(args) {
    const r=await ensureRoom({root,name:args.name});
    if(args.room_id&&args.room_id!==r.state.id)throw Error('Room identity changed. Reopen the chat.');
    return {...r,config:path.join(r.dir,'human.json')};
  }
  const snapshot=async args=>{const r=await room(args);return {name:args.name,room_id:r.state.id,...r.state,launch:launchStatus(r.dir)}};
  server.registerResource('chat',uri,{mimeType:'text/html;profile=mcp-app'},async()=>({contents:[{uri,mimeType:'text/html;profile=mcp-app',text:fs.readFileSync(new URL('../adapters/session/chat.html',import.meta.url),'utf8'),_meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}}}}]}));
  server.registerTool('team_start',{description:'Start TeamBrrr with Claude in this Codex conversation: create or reuse a room, launch a persistent signed-in Claude Code session with bypass permissions and automatic replies, verify its reply, and open the embedded chat. Supply the actual current Codex session ID and absolute working directory. Omit name for a separate room per Codex conversation. Always supply session_context: a faithful handoff of the existing conversation, including the user goal, relevant history, decisions, constraints and permissions, completed work and evidence, relevant files, unresolved questions, and next steps. Distinguish user requests from suggestions; do not include hidden reasoning or credentials. Update the handoff when reusing a room. No manual Claude command is needed.',inputSchema:{name:name.optional(),codex_session_id:z.string().min(1).optional(),cwd:z.string().min(1),session_context:z.string().trim().min(1).max(12000).describe('Existing conversation handoff, supplied automatically by Codex rather than asking the user to repeat context.')},_meta:{ui:{resourceUri:uri},'openai/outputTemplate':uri}},wrap(async args=>{const result=await startTeam({root,name:args.name,sessionId:args.codex_session_id,cwd:args.cwd,sessionContext:args.session_context});return snapshot({name:result.name})}));
  server.registerTool('team_stop',{description:'Stop the managed Claude collaborator only when the user asks to stop it.',inputSchema:{name}},wrap(args=>stopTeam({root,...args})));
  server.registerTool('chat_open',{description:'Open an existing TeamBrrr room as an embedded chat. The human can address @claude directly and read attributed replies.',inputSchema:{name},annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:uri},'openai/outputTemplate':uri}},wrap(snapshot));
  server.registerTool('chat_read',{description:'Refresh the human chat transcript.',inputSchema:binding,annotations:{readOnlyHint:true},_meta:appOnly},wrap(snapshot));
  server.registerTool('chat_send',{description:'Send the human message composed in the embedded chat. Do not call on behalf of the model.',inputSchema:{...binding,message:z.string().trim().min(1).max(16000),idempotency_key:z.string().min(1).max(150)},_meta:appOnly},wrap(async args=>{
    const r=await room(args);
    const match=args.message.match(/^@([a-z0-9-]+)\s+([\s\S]+)$/);
    if(!match)throw Error('Start with @claude, @codex, a participant handle, or @all.');
    const [,to,text]=match;
    if(to!=='all'&&!Object.hasOwn(r.state.participants,to))throw Error(`Unknown participant @${to}`);
    const event=await localRequest(r.config,'/events',{kind:'message',to,text,key:args.idempotency_key});
    return {queued:true,event};
  }));
  server.registerTool('chat_pause',{description:'Pause or resume agent messages from the human chat controls.',inputSchema:{...binding,paused:z.boolean(),idempotency_key:z.string().min(1).max(150)},_meta:appOnly},wrap(async args=>{
    const r=await room(args);return {event:await localRequest(r.config,'/events',{kind:'pause',paused:args.paused,key:args.idempotency_key})};
  }));
  return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{root:{type:'string'}}});
  await createChatMcp(values).connect(new StdioServerTransport());
}
