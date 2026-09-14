#!/usr/bin/env node
// Offline Claude protocol double: exercises the detached worker and real room daemon.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {joinRoom,localRequest} from '../../core/session-manager.mjs';
const args=process.argv.slice(2);const mode=path.basename(process.cwd());
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:mode!=='signed-out'}));process.exit(0)}
const value=flag=>args[args.indexOf(flag)+1];
const config=JSON.parse(fs.readFileSync(value('--mcp-config'))).mcpServers['teambrrr-channel'];
const cv=flag=>config.args[config.args.indexOf(flag)+1];const root=cv('--root'),name=cv('--room'),sessionId=cv('--session');
fs.appendFileSync(path.join(process.cwd(),'starts.jsonl'),JSON.stringify({args,sessionId,apiKeyPresent:!!process.env.ANTHROPIC_API_KEY})+'\n');
const j=await joinRoom({root,name,host:'claude',sessionId});
const out=e=>console.log(JSON.stringify(e));
out({type:'system',subtype:'init',session_id:mode==='mismatch'?'wrong':sessionId,mcp_servers:[{name:'teambrrr-channel',status:'connected'}]});
const lines=readline.createInterface({input:process.stdin});
for await(const line of lines){const input=JSON.parse(line);const content=input.message.content;fs.appendFileSync(path.join(process.cwd(),'inputs.jsonl'),JSON.stringify(content)+'\n');
 if(content.startsWith('Incoming TeamBrrr')){const message=JSON.parse(content.split('\n')[1]);if(mode!=='no-reply'){
  await localRequest(j.configPath,'/events',{kind:'ack',messageId:message.message_id,key:`ack:${message.message_id}`});
  await localRequest(j.configPath,'/events',{kind:'message',to:message.sender,text:'READY',replyTo:message.message_id,key:`reply:${message.message_id}`});
 }}
 out({type:'result',is_error:false,session_id:sessionId,result:'done'});
}
