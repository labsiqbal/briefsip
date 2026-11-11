import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startApp} from './server.ts';
import {localScript} from './script-client.ts';
import {initializeSlack,bindSlack,recordSlackEnvelope} from './slack.ts';
import {slackAgentStep} from './slack-runner.ts';
import {initializeTelegram,bindTelegram,recordTelegramUpdates} from './telegram.ts';
import {telegramAgentStep} from './telegram-bridge.ts';

for(const platform of ['slack','telegram'])for(const mode of ['reply','notice','nested'])test(`${platform} ordinary chat collects only requested teammate files (${mode})`,async()=>{
 const expectsReply=mode!=='notice';
 const root=mkdtempSync(join(tmpdir(),'briefsip-task-files-')),owner=randomUUID(),worker=randomUUID(),leaf=randomUUID(),foreign=randomUUID(),bytes=Buffer.from('exact teammate bytes');
 const journal=join(root,'connector.sqlite');let db=new DatabaseSync(journal),sequence=0,partial=false,lost=false,reopened=false;
 const uploads:Buffer[]=[],sent:any[]=[];
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw),calls=body.messages.flatMap((m:any)=>m.tool_calls??[]);let fn:any;
  if(!calls.length)fn=['owner','nested'].includes(body.model)?{name:'send_message',arguments:JSON.stringify({recipients:[body.model==='nested'?leaf:worker],text:'Make artifact',expects_reply:expectsReply})}:{name:'create_text_file',arguments:JSON.stringify({name:'teammate.txt',text:bytes.toString()})};
  else if(partial&&body.model==='owner'&&!calls.some((c:any)=>c.function.name==='ask_user'))fn={name:'ask_user',arguments:JSON.stringify({question:'Continue?',choices:[]})};
  res.end(JSON.stringify({choices:[{finish_reason:fn?'tool_calls':'stop',message:fn?{tool_calls:[{id:fn.name,type:'function',function:fn}]}:{content:'Done'}}]}));
 });
 await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const address=provider.address();assert(address&&typeof address!=='string');
 const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${address.port}/v1`,scriptDirectory:join(root,'scripts')});
 const actual=localScript(join(root,'scripts'));
 const local=async(path:string,body?:unknown,signal?:AbortSignal,name?:string,binary=false)=>{
  const result=await actual(path,body,signal,name,binary);
  if(binary&&!lost){lost=true;throw new Error('Lost file read');}
  if(path.endsWith('?metadata=1')&&!reopened){reopened=true;throw new Error('Reopen journal');}
  return result;
 };
 const remote=async(method:string,body:any)=>{
  sent.push({method,body});if(method==='files.getUploadURLExternal')return {file_id:`FFILE${sent.length}`,upload_url:'https://files.slack.com/upload/fixture'};
  if(method==='uploadFile'||method==='sendDocument')uploads.push(Buffer.from(body.bytes));
  if(method==='files.completeUploadExternal')return {files:body.files};
  return platform==='slack'?{channel:body.channel,ts:`1700000002.${String(sent.length).padStart(6,'0')}`}:{message_id:sent.length,chat:{id:4}};
 };
 async function ui(path:string,body?:unknown):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await res.json();assert(res.ok,JSON.stringify(result));return result;}
 function reopen(){db.close();db=new DatabaseSync(journal);if(platform==='slack')initializeSlack(db);else initializeTelegram(db);}
 const tick=()=>platform==='slack'?slackAgentStep(db,new Set(['UUSER']),local,remote):telegramAgentStep(db,new Set([4]),local,remote);
 function incoming(){sequence++;
  if(platform==='slack')recordSlackEnvelope(db,{type:'events_api',envelope_id:`e${sequence}`,payload:{type:'event_callback',team_id:'TTEAM',api_app_id:'AAPP',event_id:`Ev${sequence}`,authorizations:[{team_id:'TTEAM',user_id:'UBOT',is_bot:true}],event:{type:'message',channel_type:'im',channel:'DCHAT',user:'UUSER',text:'Make file',ts:`1700000000.${String(sequence).padStart(6,'0')}`}}},new Set(['UUSER']));
  else recordTelegramUpdates(db,[{update_id:sequence,message:{message_id:sequence,chat:{id:4,type:'private'},from:{id:4,is_bot:false},text:'Make file'}}],new Set([4]));
  return db.prepare(`SELECT * FROM ${platform}_inbox ORDER BY rowid DESC LIMIT 1`).get()!;
 }
 try{
  for(const id of [owner,worker,leaf,foreign])await ui('/api/agents',{id,name:id,model:id===owner?'owner':mode==='nested'&&id===worker?'nested':'worker',instructions:'Help'});
  for(const id of [owner,foreign])await ui(`/api/agents/${id}/scripts`,{id:randomUUID(),revision:0,enabled:true});
  if(platform==='slack'){initializeSlack(db);bindSlack(db,'TTEAM','AAPP','UBOT',owner);}else{initializeTelegram(db);bindTelegram(db,123,owner);}
  let previousFile='';
  for(const cancelled of expectsReply?[false,true]:[false]){
   partial=cancelled;const row=incoming();let parent:any;
   for(let i=0;i<300;i++){
    try{await tick();}catch(error){if(String(error).includes('Reopen journal')){reopen();await tick();}else assert.match(String(error),/Lost file read/);}
    parent=(await ui(`/api/threads/${row.thread}/turns?focus=${row.turn}`))[0];
    if(cancelled&&parent?.questions.some((q:any)=>q.answer===null)&&parent.status!=='cancelled')await ui(`/api/threads/${row.thread}/turns/${row.turn}/cancel`,{id:randomUUID()});
    if(db.prepare(`SELECT status FROM ${platform}_inbox WHERE turn=?`).get(row.turn)!.status==='done')break;
    await new Promise(r=>setTimeout(r,10));
   }
   assert.equal(db.prepare(`SELECT status FROM ${platform}_inbox WHERE turn=?`).get(row.turn)!.status,'done');
   assert.equal(parent.agentMessages[0].generatedFiles?.length,expectsReply?1:0);
   const child=parent.agentMessages[0];let childTurn:any;
   for(let i=0;i<200;i++){childTurn=(await ui(`/api/threads/${child.thread}/turns`))[0];if(childTurn.status==='done')break;await new Promise(r=>setTimeout(r,10));}
   assert.equal(childTurn.status,'done');const file=mode==='nested'?(await ui(`/api/threads/${childTurn.agentMessages[0].thread}/turns`))[0].generatedFiles[0]:childTurn.generatedFiles[0];assert(file);
   const base=`/api/scripts/agents/${owner}/threads/${row.thread}`,path=`${base}/turns/${row.turn}/files`;
   const turns=await actual(`${base}/turns?focus=${row.turn}`);assert.equal(turns[0].generatedFiles.length,expectsReply?1:0);
   if(!expectsReply){assert.equal(uploads.length,0);assert.deepEqual(await actual(path),[]);await assert.rejects(actual(`${path}/${file.id}`),(e:any)=>e.status===404);continue;}
   const visible=parent.agentMessages[0].generatedFiles[0];assert.equal(visible.id,file.id);const download=await fetch(`${app.origin}/api/threads/${visible.thread}/files/${visible.id}`);assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
   assert(lost&&reopened);assert.deepEqual(uploads.at(-1),bytes);assert.deepEqual(await actual(`${path}/${file.id}`,undefined,undefined,undefined,true),bytes);
   await assert.rejects(actual(path.replace(owner,foreign)),(e:any)=>e.status===404);
   await assert.rejects(actual(`${base}/files/${file.id}`),(e:any)=>e.status===404);
   await assert.rejects(actual(path,{id:randomUUID()}),(e:any)=>e.status===405);
   const other=await ui(`/api/agents/${owner}/threads`,{id:randomUUID(),name:'Unrelated'});await assert.rejects(actual(path.replace(String(row.thread),other.id)),(e:any)=>e.status===404);
   await assert.rejects(actual(`${base}/turns/${randomUUID()}/files/${file.id}`),(e:any)=>e.status===404);
   if(previousFile)await assert.rejects(actual(`${path}/${previousFile}`),(e:any)=>e.status===404);previousFile=file.id;
   if(cancelled)assert(String(sent.filter(s=>s.method===(platform==='slack'?'files.completeUploadExternal':'sendDocument')).at(-1).body[platform==='slack'?'initial_comment':'caption']).includes('Hasil parsial'));
   const count=uploads.length;reopen();await tick();assert.equal(uploads.length,count);
   if(!cancelled)continue;
   const side=(await ui(`/api/agents/${worker}/threads`)).find((t:any)=>t.id===child.thread),archived=await ui(`/api/threads/${child.thread}/edit`,{id:randomUUID(),revision:side.revision,name:side.name,archived:true});
   await ui(`/api/threads/${child.thread}/delete`,{id:randomUUID(),revision:archived.revision});assert.deepEqual(await actual(path),[]);await assert.rejects(actual(`${path}/${file.id}`),(e:any)=>e.status===404);assert.deepEqual((await ui(`/api/threads/${row.thread}/turns?focus=${row.turn}`))[0].agentMessages[0].generatedFiles,[]);
   const document=db.prepare(`SELECT id FROM ${platform}_documents WHERE turn=?`).get(row.turn)!;db.prepare(`UPDATE ${platform}_outbox SET status='queued'${platform==='telegram'?',part=0':''} WHERE id=?`).run(document.id);const sentCount=sent.length;await tick();assert.equal(sent.length,sentCount);assert.equal(db.prepare(`SELECT status FROM ${platform}_outbox WHERE id=?`).get(document.id)!.status,'revoked');
  }
  assert.deepEqual(await ui(`/api/agents/${owner}/turns`),[]);
  await ui(`/api/agents/${owner}/scripts`,{id:randomUUID(),revision:1,enabled:false});await assert.rejects(actual(`/api/scripts/agents/${owner}/threads/${randomUUID()}/turns/${randomUUID()}/files`),(e:any)=>e.status===403);
 }finally{db.close();await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});
