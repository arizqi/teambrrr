import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startTeam,stopTeam,readLaunch,launchStatus,sleep} from '../core/session-launcher.mjs';
import {localRequest} from '../core/session-manager.mjs';
import {check,done,SCRATCH} from './_harness.mjs';
const root=path.join(SCRATCH,'launch-rooms'),names=[];
const sessionId=process.env.CODEX_THREAD_ID||'test-codex';
const command=fileURLToPath(new URL('./fixtures/claude-stream.mjs',import.meta.url));
const options=name=>{names.push(name);const cwd=path.join(SCRATCH,name);fs.mkdirSync(cwd,{recursive:true});return {root,name,cwd,sessionId,claudeCommand:command,waitMs:12000,sessionContext:"Goal: preserve existing work. Decision: use shared room. Constraint: await assignment."}};
try{
 const opts=options('happy');
 let missing=false;try{await startTeam({...opts,sessionContext:''})}catch{missing=true}check(missing,'Startup refuses to silently omit existing conversation context');
 const originalKey=process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_API_KEY='test-sentinel-not-a-real-key';
 const results=await Promise.all([startTeam(opts),startTeam(opts)]);
 if(originalKey===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=originalKey;
 check(results.every(r=>r.launch.status==='ready'),'Concurrent starts complete actual acknowledged handshake');
 check(results[0].launch.session_id===results[1].launch.session_id,'Concurrent starts reuse the same Claude identity');
 let starts=fs.readFileSync(path.join(opts.cwd,'starts.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 check(starts.length===1,'Only one Claude process launches');
 check(starts[0].args.includes('--dangerously-skip-permissions')&&starts[0].args.includes('--strict-mcp-config'),'Managed process uses bypass and isolated room MCP configuration');
 check(!starts[0].apiKeyPresent,'Managed process uses subscription auth, not inherited API key');
 const dir=path.join(root,'happy'),run=readLaunch(dir);
 const initial=await localRequest(run.configPath);
 const handoffs=initial.events.filter(e=>e.key?.startsWith('session-context:'));
 check(handoffs.length===1&&handoffs[0].text.includes(opts.sessionContext),'Concurrent starts publish one visible, exact context handoff');
 check(handoffs[0].seq<initial.events.find(e=>e.key?.startsWith('startup:')).seq,'Context is shared before the startup handshake');
 check(initial.events.some(e=>e.replyTo===handoffs[0].id),'Claude replies to the context handoff before startup is ready');
 const inputs=fs.readFileSync(path.join(opts.cwd,'inputs.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 check(inputs[0].includes(opts.sessionContext),'First Claude input contains the existing conversation context');
 await startTeam({...opts,sessionContext:'Updated decision: wait for a review.'});
 const updated=await localRequest(run.configPath);
 check(updated.events.some(e=>e.key?.startsWith('session-context:')&&e.text.includes('Updated decision: wait for a review.')),'Reusing Claude shares updated conversation context');
 const msg=await localRequest(run.configPath,'/events',{kind:'message',to:run.actor,text:'second message',key:'second'});
 let state;for(let i=0;i<50;i++){state=await localRequest(run.configPath);if(state.events.some(e=>e.replyTo===msg.id))break;await sleep(100)}
 check(state.events.some(e=>e.replyTo===msg.id&&e.actor===run.actor),'Idle managed process automatically answers subsequent messages');
 let refused=false;try{await startTeam({...opts,cwd:SCRATCH})}catch{refused=true}check(refused,'Room cannot silently switch working directories');
 stopTeam({root,name:'happy'});for(let i=0;i<50&&launchStatus(dir).status!=='stopped';i++)await sleep(100);
 check(launchStatus(dir).status==='stopped','Stop request is consumed by its owning supervisor');
 await sleep(500);const resumed=await startTeam(opts);
 check(resumed.launch.status==='ready'&&resumed.launch.session_id===run.sessionId,'Stopped collaborator resumes same identity and verifies a new handshake');
 for(const name of ['signed-out','mismatch','no-reply']){const r=await startTeam(options(name));check(r.launch.status==='failed',`${name} cannot falsely report ready`)}
 check(!fs.existsSync(path.join(SCRATCH,'signed-out','starts.jsonl')),'Signed-out preflight does not launch Claude');
}finally{
 for(const name of new Set(names)){try{stopTeam({root,name})}catch{}}
 await sleep(1000);
 for(const name of new Set(names)){const lock=path.join(root,name,'server.lock');if(fs.existsSync(lock))try{process.kill(Number(fs.readFileSync(lock)),'SIGTERM')}catch{}}
}
done();
