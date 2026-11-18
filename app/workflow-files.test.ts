import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startApp} from './test-bridge.ts';
import {localScript,LocalAgentError} from './script-client.ts';
import {initializeSlack,bindSlack,recordSlackEnvelope} from './slack.ts';
import {slackAgentStep} from './slack-runner.ts';
import {initializeTelegram,bindTelegram,recordTelegramUpdates} from './telegram.ts';
import {telegramAgentStep} from './telegram-bridge.ts';

for(const platform of ['slack','telegram'])for(const mode of ['step','reply','notice','nested'])test(`${platform} ${mode} workflow artifacts are scoped to owned run and retain partial bytes`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-workflow-files-')),owner=randomUUID(),worker=randomUUID(),teammate=randomUUID(),grandchild=randomUUID(),foreign=randomUUID(),text='workflow artifact exact';const journal=join(root,'connector.sqlite');let db=new DatabaseSync(journal);let sequence=0,failRead=true,restartPending=true,restarted=false,previousFile='';const sends:any[]=[],uploads:Buffer[]=[];
 const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const data=JSON.parse(raw),done=data.messages.some((m:any)=>m.role==='tool');res.end(JSON.stringify({choices:[{finish_reason:done?'stop':'tool_calls',message:done?{content:'Done'}:{tool_calls:[{id:'file',type:'function',function:['delegate','nested','notice'].includes(data.model)?{name:'send_message',arguments:JSON.stringify({recipients:[data.model==='nested'?grandchild:teammate],text:'Make file',expects_reply:data.model!=='notice'})}:{name:'create_text_file',arguments:JSON.stringify({name:'workflow.txt',text})}}]}}]}));});await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const address=provider.address();assert(address&&typeof address!=='string');const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${address.port}/v1`,scriptDirectory:join(root,'scripts')});
 const actual=localScript(join(root,'scripts')),local=async(path:string,body?:unknown,signal?:AbortSignal,name?:string,binary=false)=>{if(restartPending&&path.includes('/files/')&&path.endsWith('?metadata=1')){restartPending=false;throw new Error('Restart journal');}const result=await actual(path,body,signal,name,binary);if(failRead&&binary){failRead=false;throw new Error('Lost file read');}return result;};
 const remote=async(method:string,body:Record<string,unknown>)=>{sends.push({method,body});if(method==='files.getUploadURLExternal')return {file_id:`FFILE${sends.length}`,upload_url:'https://files.slack.com/upload/fixture'};if(method==='uploadFile'){uploads.push(Buffer.from(body.bytes as Uint8Array));return {}; }if(method==='files.completeUploadExternal')return {files:body.files};if(method==='sendDocument')uploads.push(Buffer.from(body.bytes as Uint8Array));return platform==='slack'?{channel:body.channel,ts:`1700000002.${String(sends.length).padStart(6,'0')}`}:{message_id:sends.length,chat:{id:4}};};
 async function ui(path:string,body?:unknown):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await res.json();assert(res.ok,JSON.stringify(value));return value;}
 const tick=()=>platform==='slack'?slackAgentStep(db,new Set(['UUSER']),local,remote):telegramAgentStep(db,new Set([4]),local,remote);
 function incoming(workflow:string){sequence++;if(platform==='slack'){recordSlackEnvelope(db,{type:'events_api',envelope_id:`e${sequence}`,payload:{type:'event_callback',team_id:'TTEAM',api_app_id:'AAPP',event_id:`Ev${sequence}`,authorizations:[{team_id:'TTEAM',user_id:'UBOT',is_bot:true}],event:{type:'message',channel_type:'im',channel:'DCHAT',user:'UUSER',text:`!workflow ${workflow} 1 Work`,ts:`1700000000.${String(sequence).padStart(6,'0')}`}}},new Set(['UUSER']));return db.prepare('SELECT * FROM slack_inbox WHERE event=?').get(`Ev${sequence}`)!;}recordTelegramUpdates(db,[{update_id:sequence,message:{message_id:sequence,chat:{id:4,type:'private'},from:{id:4,is_bot:false},text:`/workflow ${workflow} 1 Work`}}],new Set([4]));return db.prepare('SELECT * FROM telegram_inbox WHERE update_id=?').get(sequence)!;}
 try{
  for(const id of [owner,worker,teammate,grandchild,foreign])await ui('/api/agents',{runtime:'api', id,name:id,model:mode!=='step'&&id===worker?(mode==='notice'?'notice':'delegate'):mode==='nested'&&id===teammate?'nested':'fixture',instructions:'Help'});for(const id of [owner,foreign])await ui(`/api/agents/${id}/scripts`,{id:randomUUID(),revision:0,enabled:true});
  if(platform==='slack'){initializeSlack(db);bindSlack(db,'TTEAM','AAPP','UBOT',owner);}else{initializeTelegram(db);bindTelegram(db,123,owner);}
  for(const partial of mode==='notice'?[false]:[false,true]){
   const workflow=await ui(`/api/agents/${owner}/workflows`,{id:randomUUID(),revision:0,name:'Files',graph:{entry:'work',maxSteps:3,nodes:[{id:'work',kind:'agent',agent:worker,prompt:'Make file',next:partial?'ask':'out'},...(partial?[{id:'ask',kind:'approval',prompt:'Continue?',yes:'out'}]:[]),{id:'out',kind:'output'}]}});const row=incoming(workflow.id);let lost=false;
   for(let i=0;i<200;i++){try{await tick();}catch(error){if(String(error).includes('Restart journal')){assert.equal(uploads.length,0);assert.equal(db.prepare(`SELECT count(*) AS n FROM ${platform}_document_workflows`).get()!.n,1);db.close();db=new DatabaseSync(journal);if(platform==='slack')initializeSlack(db);else initializeTelegram(db);restarted=true;await tick();}else{assert.match(String(error),/Lost file read/);lost=true;}}const run=await ui(`/api/workflow-runs/${row.turn}`);if(partial&&run.status==='approval')await ui(`/api/workflow-runs/${row.turn}/cancel`,{id:randomUUID(),revision:run.revision});if(db.prepare(`SELECT status FROM ${platform}_inbox WHERE turn=?`).get(row.turn)!.status==='done')break;await new Promise(r=>setTimeout(r,10));}
   assert.equal(db.prepare(`SELECT status FROM ${platform}_inbox WHERE turn=?`).get(row.turn)!.status,'done');
   const path=`/api/scripts/agents/${owner}/workflow-runs/${row.turn}`,run=await actual(path);
   if(mode==='notice'){
    const detail=await ui(`/api/workflow-runs/${row.turn}`),step=detail.steps.find((step:any)=>step.thread),parent=(await ui(`/api/threads/${step.thread}/turns`))[0],child=parent.agentMessages[0];let childTurn:any;
    for(let i=0;i<200;i++){childTurn=(await ui(`/api/threads/${child.thread}/turns`))[0];if(childTurn.status==='done')break;await new Promise(r=>setTimeout(r,10));}
    assert.equal(childTurn.status,'done');assert.equal(childTurn.generatedFiles.length,1);assert.deepEqual((await actual(path)).generatedFiles,[]);assert.equal(uploads.length,0);
    await assert.rejects(actual(`${path}/files/${childTurn.generatedFiles[0].id}`),(error:any)=>error.status===404);
    await ui(`/api/workflows/${workflow.id}/delete`,{id:randomUUID(),revision:1});continue;
   }
   assert.equal(run.generatedFiles.length,1);if(!partial){assert(lost);assert(restarted);}assert.equal(uploads.at(-1)!.toString(),text);const file=run.generatedFiles[0];assert.equal((await actual(`${path}/files/${file.id}`,undefined,undefined,undefined,true)).toString(),text);
   await assert.rejects(actual(`/api/scripts/agents/${foreign}/workflow-runs/${row.turn}/files/${file.id}`),(error:any)=>error instanceof LocalAgentError&&error.status===404);await assert.rejects(actual(`${path}/files/${randomUUID()}`),(error:any)=>error.status===404);
   if(previousFile)await assert.rejects(actual(`${path}/files/${previousFile}`),(error:any)=>error.status===404);previousFile=file.id;
   if(partial){const sent=sends.filter(s=>s.method===(platform==='slack'?'files.completeUploadExternal':'sendDocument')).at(-1)!;assert(String(platform==='slack'?sent.body.initial_comment:sent.body.caption).includes('Partial result'));}
   const count=uploads.length;db.close();db=new DatabaseSync(journal);if(platform==='slack')initializeSlack(db);else initializeTelegram(db);await tick();assert.equal(uploads.length,count);
   if(!partial&&['reply','nested'].includes(mode)){
    const detail=await ui(`/api/workflow-runs/${row.turn}`),step=detail.steps.find((step:any)=>step.thread),parent=(await ui(`/api/threads/${step.thread}/turns`))[0],child=parent.agentMessages[0];
    const side=(await ui(`/api/agents/${teammate}/threads`)).find((thread:any)=>thread.id===child.thread);
    const archived=await ui(`/api/threads/${child.thread}/edit`,{id:randomUUID(),revision:side.revision,name:side.name,archived:true});await ui(`/api/threads/${child.thread}/delete`,{id:randomUUID(),revision:archived.revision});
    await assert.rejects(actual(`${path}/files/${file.id}`),(error:any)=>error.status===404);assert.deepEqual((await actual(path)).generatedFiles,[]);
   }
   if(partial){const detail=await ui(`/api/workflow-runs/${row.turn}`),threadId=detail.steps.find((step:any)=>step.thread).thread;const side=(await ui(`/api/agents/${worker}/threads`)).find((thread:any)=>thread.id===threadId);const archived=await ui(`/api/threads/${threadId}/edit`,{id:randomUUID(),revision:side.revision,name:side.name,archived:true});await ui(`/api/threads/${threadId}/delete`,{id:randomUUID(),revision:archived.revision});await assert.rejects(actual(`${path}/files/${file.id}`),(error:any)=>error.status===404);assert.deepEqual((await actual(path)).generatedFiles,[]);}
   await ui(`/api/workflows/${workflow.id}/delete`,{id:randomUUID(),revision:1});await assert.rejects(actual(`${path}/files/${file.id}`),(error:any)=>error.status===404);
  }
  assert.deepEqual(await ui(`/api/agents/${owner}/turns`),[]);await ui(`/api/agents/${owner}/scripts`,{id:randomUUID(),revision:1,enabled:false});await assert.rejects(actual(`/api/scripts/agents/${owner}/workflow-runs/${randomUUID()}`),(error:any)=>error.status===403);
 }finally{db.close();await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});
