import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startApp} from './test-bridge.ts';
import {localScript} from './test-support/script-client.ts';
import { artifactReceiver, rustConnectorFixture, slackEnvelope, telegramUpdate, waitFor } from './test-support/rust-connector-fixture.ts';

for(const platform of ['slack','telegram'] as const)for(const mode of ['reply','notice','nested'])test(`${platform} ordinary chat collects only requested teammate files (${mode})`,async()=>{
 const expectsReply=mode!=='notice';
 const root=mkdtempSync(join(tmpdir(),'briefsip-task-files-')),owner=randomUUID(),worker=randomUUID(),leaf=randomUUID(),foreign=randomUUID(),bytes=Buffer.from('exact teammate bytes');
 let db: DatabaseSync | undefined, sequence=0, partial=false;
 const uploads:Buffer[]=[];
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw),calls=body.messages.flatMap((m:any)=>m.tool_calls??[]);let fn:any;
  if(!calls.length)fn=['owner','nested'].includes(body.model)?{name:'send_message',arguments:JSON.stringify({recipients:[body.model==='nested'?leaf:worker],text:'Make artifact',expects_reply:expectsReply})}:{name:'create_text_file',arguments:JSON.stringify({name:'teammate.txt',text:bytes.toString()})};
  else if(partial&&body.model==='owner'&&!calls.some((c:any)=>c.function.name==='ask_user'))fn={name:'ask_user',arguments:JSON.stringify({question:'Continue?',choices:[]})};
  res.end(JSON.stringify({choices:[{finish_reason:fn?'tool_calls':'stop',message:fn?{tool_calls:[{id:fn.name,type:'function',function:fn}]}:{content:'Done'}}]}));
 });
 await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const address=provider.address();assert(address&&typeof address!=='string');
 const scriptToken='connector-artifact-test-token-0123456789';
 const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${address.port}/v1`,scriptToken,scriptDirectory:join(root,'scripts')});
 const actual=localScript(join(root,'scripts'));
 const connector=await rustConnectorFixture(platform,root,owner,app.origin,scriptToken,artifactReceiver(platform,uploads));
 const journal=join(connector.directory,platform+'.sqlite');
 const outbox=()=>db!.prepare(`SELECT * FROM ${platform}_outbox ORDER BY rowid`).all();
 const deliver=()=>waitFor(()=>{connector.check();return outbox().every(row=>row.status==='sent');},'Artifacts and text were not delivered');
 const restart=async()=>{await connector.stop();db!.close();db=new DatabaseSync(journal);connector.start();};
 async function ui(path:string,body?:unknown):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await res.json();assert(res.ok,JSON.stringify(result));return result;}
 async function incoming(text:string){
  const id=++sequence;
  await connector.send(platform==='slack'?slackEnvelope(id,text):telegramUpdate(id,text));
  db??=new DatabaseSync(journal);
  return db.prepare(`SELECT * FROM ${platform}_inbox ORDER BY rowid DESC LIMIT 1`).get()!;
 }
 try{
  for(const id of [owner,worker,leaf,foreign])await ui('/api/agents',{runtime:'api', id,name:id,model:id===owner?'owner':mode==='nested'&&id===worker?'nested':'worker',instructions:'Help'});
  for(const id of [owner,foreign])await ui(`/api/agents/${id}/scripts`,{id:randomUUID(),revision:0,enabled:true});
  connector.start();
  const readFault={method:'GET',path:/\/files\/[^/?]+$/,after:true};
  const metadataFault={method:'GET',path:/\/files\/[^/?]+\?metadata=1$/,after:false};
  const waitDone=(turn:unknown)=>waitFor(()=>{connector.check();return db!.prepare(`SELECT status FROM ${platform}_inbox WHERE turn=?`).get(String(turn))?.status==='done';},'Connector intake did not settle');
  let previousFile='';
  for(const cancelled of expectsReply?[false,true]:[false]){
   partial=cancelled;
   if(expectsReply&&!partial)connector.faults.push(readFault,metadataFault);
   const row=await incoming('Make file');
   const pathToParent=`/api/threads/${row.thread}/turns?focus=${row.turn}`;
   if(cancelled){
    await waitFor(async()=>{
     const response=await fetch(app.origin+pathToParent);
     if(response.status===404)return false;
     assert(response.ok);
     const [turn]=await response.json();
     return turn?.questions.some((q:any)=>q.answer===null);
    },'Task did not ask for input');
    await ui(`/api/threads/${row.thread}/turns/${row.turn}/cancel`,{id:randomUUID()});
   }
   if(expectsReply&&!partial){
    await connector.expectedFailure(/Local agent request failed/);assert.equal(uploads.length,0);connector.start();
    await connector.expectedFailure(/Local agent request failed/);assert.equal(uploads.length,0);
    assert.equal(db!.prepare(`SELECT count(*) AS n FROM ${platform}_documents`).get()!.n,1);connector.start();
   }
   await waitDone(row.turn);await deliver();
   const [parent]=await ui(pathToParent);
   assert.equal(parent.agentMessages[0].generatedFiles?.length,expectsReply?1:0);
   const child=parent.agentMessages[0];let childTurn:any;
   for(let i=0;i<200;i++){childTurn=(await ui(`/api/threads/${child.thread}/turns`))[0];if(childTurn.status==='done')break;await new Promise(r=>setTimeout(r,10));}
   assert.equal(childTurn.status,'done');const file=mode==='nested'?(await ui(`/api/threads/${childTurn.agentMessages[0].thread}/turns`))[0].generatedFiles[0]:childTurn.generatedFiles[0];assert(file);
   const base=`/api/scripts/agents/${owner}/threads/${row.thread}`,path=`${base}/turns/${row.turn}/files`;
   const turns=await actual(`${base}/turns?focus=${row.turn}`);assert.equal(turns[0].generatedFiles.length,expectsReply?1:0);
   if(!expectsReply){assert.equal(uploads.length,0);assert.deepEqual(await actual(path),[]);await assert.rejects(actual(`${path}/${file.id}`),(e:any)=>e.status===404);continue;}
   const visible=parent.agentMessages[0].generatedFiles[0];assert.equal(visible.id,file.id);const download=await fetch(`${app.origin}/api/threads/${visible.thread}/files/${visible.id}`);assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
   assert.deepEqual(uploads.at(-1),bytes);assert.deepEqual(await actual(`${path}/${file.id}`,undefined,undefined,undefined,true),bytes);
   await assert.rejects(actual(path.replace(owner,foreign)),(e:any)=>e.status===404);
   await assert.rejects(actual(`${base}/files/${file.id}`),(e:any)=>e.status===404);
   await assert.rejects(actual(path,{id:randomUUID()}),(e:any)=>e.status===405);
   const other=await ui(`/api/agents/${owner}/threads`,{id:randomUUID(),name:'Unrelated'});await assert.rejects(actual(path.replace(String(row.thread),other.id)),(e:any)=>e.status===404);
   await assert.rejects(actual(`${base}/turns/${randomUUID()}/files/${file.id}`),(e:any)=>e.status===404);
   if(previousFile)await assert.rejects(actual(`${path}/${previousFile}`),(e:any)=>e.status===404);previousFile=file.id;
   if(cancelled)assert(connector.posts.filter(s=>s.method===(platform==='slack'?'files.completeUploadExternal':'sendDocument')).at(-1)!.raw.includes('Partial result'));
   const count=uploads.length;await restart();const probe=await incoming(platform==='slack'?'!status':'/status');await waitDone(probe.turn);await deliver();assert.equal(uploads.length,count);
   if(!cancelled)continue;
   const side=(await ui(`/api/agents/${worker}/threads`)).find((t:any)=>t.id===child.thread),archived=await ui(`/api/threads/${child.thread}/edit`,{id:randomUUID(),revision:side.revision,name:side.name,archived:true});
   await ui(`/api/threads/${child.thread}/delete`,{id:randomUUID(),revision:archived.revision});assert.deepEqual(await actual(path),[]);await assert.rejects(actual(`${path}/${file.id}`),(e:any)=>e.status===404);assert.deepEqual((await ui(`/api/threads/${row.thread}/turns?focus=${row.turn}`))[0].agentMessages[0].generatedFiles,[]);
   const document=db!.prepare(`SELECT id FROM ${platform}_documents WHERE turn=?`).get(row.turn)!;
   if(platform==='slack') db!.prepare('UPDATE slack_documents SET stage=2 WHERE id=?').run(document.id);
   db!.prepare(`UPDATE ${platform}_outbox SET status='queued'${platform==='telegram'?',part=0':''} WHERE id=?`).run(document.id);const sentCount=connector.posts.length;
   await waitFor(()=>{connector.check();return db!.prepare(`SELECT status FROM ${platform}_outbox WHERE id=?`).get(document.id)?.status==='revoked';},'Deleted artifact was not revoked');
   assert.equal(connector.posts.length,sentCount);
  }
  assert.deepEqual(await ui(`/api/agents/${owner}/turns`),[]);
  await ui(`/api/agents/${owner}/scripts`,{id:randomUUID(),revision:1,enabled:false});await assert.rejects(actual(`/api/scripts/agents/${owner}/threads/${randomUUID()}/turns/${randomUUID()}/files`),(e:any)=>e.status===403);
 }finally{await connector.close();db?.close();await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});
