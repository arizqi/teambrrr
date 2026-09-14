// One managed Claude process per room. Durable reservation prevents duplicate launches.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {defaultRoomsRoot,ensureRoom,joinRoom,roomDirectory,localRequest} from './session-manager.mjs';
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function readLaunch(dir){try{return JSON.parse(fs.readFileSync(path.join(dir,'claude-run.json'),'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw e}}
export function saveLaunch(dir,state){const f=path.join(dir,'claude-run.json');fs.writeFileSync(`${f}.tmp`,JSON.stringify(state),{mode:0o600});fs.renameSync(`${f}.tmp`,f)}
export function launchStatus(dir){const s=readLaunch(dir);if(!s)return null;let status=s.status;if(s.supervisorPid&&!['stopped','failed'].includes(status)){try{process.kill(s.supervisorPid,0)}catch(e){if(e.code==='ESRCH')status='disconnected'}}return {status,session_id:s.sessionId,actor:s.actor||null,error:s.error||null,cwd:s.cwd}}
export async function startTeam({root=defaultRoomsRoot(),name,sessionId=process.env.CODEX_THREAD_ID,cwd=process.cwd(),waitMs=25000,claudeCommand='claude',sessionContext}={}){
 if(typeof sessionContext!=='string'||!sessionContext.trim()||sessionContext.length>12000)throw Error('Provide sessionContext: a conversation handoff of 1–12000 characters (goals, decisions, constraints, progress, relevant files, and next steps)');
 if(!sessionId)throw Error('Supply the actual current Codex session ID');
 if(process.env.CODEX_THREAD_ID&&sessionId!==process.env.CODEX_THREAD_ID)throw Error('Session ID differs from current Codex session');
 if(!path.isAbsolute(cwd)||!fs.statSync(cwd).isDirectory())throw Error('cwd must be an existing absolute directory');
 name ||= `room-${sessionId.replace(/[^a-z0-9]/gi,'').toLowerCase().slice(0,24)}`;
 const {dir,state}=await ensureRoom({root,name,create:true});
 const joined=await joinRoom({root,name,host:'codex',sessionId});
 const lock=path.join(dir,'claude-start.lock');let fd;
 for(let i=0;i<100;i++){try{fd=fs.openSync(lock,'wx',0o600);break}catch(e){if(e.code!=='EEXIST')throw e;await sleep(50)}}
 if(fd===undefined)throw Error('Claude startup is busy; inspect claude-start.lock if a launcher crashed');
 try{
  let run=readLaunch(dir);
  if(run&&(run.roomId!==state.id||run.cwd!==cwd))throw Error('This room already has a Claude binding for another directory or room identity');
  let retry=false;
  if(run&&['failed','stopped'].includes(run.status)){
   const alive=pid=>{if(!pid)return false;try{process.kill(pid,0);return true}catch(e){if(e.code==='ESRCH')return false;throw e}};
   retry=!alive(run.supervisorPid)&&!alive(run.childPid);
  }
  if(!run||retry){
   run={version:1,sessionContext,sourceSessionId:sessionId,roomId:state.id,sessionId:run?.sessionId||randomUUID(),resume:!!run?.initialized,initialized:!!run?.initialized,cwd,root:path.resolve(root),name,configPath:joined.configPath,status:'starting',attempt:randomUUID(),createdAt:new Date().toISOString()};
   fs.rmSync(path.join(dir,'claude-stop.json'),{force:true});
   saveLaunch(dir,run);
   const log=fs.openSync(path.join(dir,'claude-launch.log'),'a',0o600);
   const env={...process.env};for(const k of ['ANTHROPIC_API_KEY','CLAUDECODE','CLAUDE_CODE_SESSION_ID','TEAMBRRR_CHANNEL_SESSION_ID'])delete env[k];
   let child;try{child=spawn(process.execPath,[fileURLToPath(new URL('../server/session-worker.mjs',import.meta.url)),dir,claudeCommand],{cwd,env,detached:true,stdio:['ignore',log,log]})}finally{fs.closeSync(log)}
   await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)}).catch(e=>{saveLaunch(dir,{...run,status:'failed',error:e.message});throw e});child.unref();
  }
 }finally{fs.closeSync(fd);fs.unlinkSync(lock)}
 const deadline=Date.now()+waitMs;let launch;
 do{launch=launchStatus(dir);if(launch.status!=='starting'&&launch.status!=='connecting')break;await sleep(250)}while(Date.now()<deadline);
 if(launch.actor)await publishSessionContext({configPath:joined.configPath,actor:launch.actor,sessionId,context:sessionContext});
 return {name,room_id:state.id,launch};
}
// Stop by a private request file consumed by the owning supervisor, never by a stale PID.
export function stopTeam({root=defaultRoomsRoot(),name}){const dir=roomDirectory(root,name);const s=readLaunch(dir);if(!s)throw Error('No managed Claude in this room');fs.writeFileSync(path.join(dir,'claude-stop.json'),JSON.stringify({sessionId:s.sessionId}),{mode:0o600});return {name,status:'stop-requested'}}

export async function publishSessionContext({configPath,actor,sessionId,context}){
 const digest=createHash('sha256').update(JSON.stringify([sessionId,context])).digest('hex');
 return localRequest(configPath,'/events',{kind:'message',to:actor,key:`session-context:${digest}`,text:`Conversation context from Codex session ${sessionId} (handoff summary, not a verbatim transcript):\n\n${context}\n\nAcknowledge this context and briefly confirm your understanding in the room. This is background, not a new request to execute work; await an explicit assignment.`});
}
