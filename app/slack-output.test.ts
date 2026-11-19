import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { testDatabase } from './test-support/database.ts';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startApp} from './test-bridge.ts';
import { runRustConnectorJournal } from './rust-connectors-runner.ts';
import { rustConnectorFixture, slackEnvelope, telegramUpdate, waitFor } from './test-support/rust-connector-fixture.ts';


test('Slack artifacts retain exact bytes and upload stages across uncertain completion and grant recovery',async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-slack-output-')),agent=randomUUID(),text='<h1>Exact Slack output</h1>\n';let calls=0,lost=true,sequence=0,question=false;const completed:any[]=[],uploaded:Buffer[]=[],allocated:any[]=[],messages:any[]=[];
 const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const data=JSON.parse(raw);calls++;const tools=data.messages.flatMap((m:any)=>m.tool_calls??[]);let call:any;
  if(!tools.length)call={name:'create_text_file',arguments:JSON.stringify({name:'result.html',text})};else if(question&&!tools.some((c:any)=>c.function.name==='ask_user'))call={name:'ask_user',arguments:JSON.stringify({question:'Continue?',choices:['Yes','No']})};res.end(JSON.stringify({choices:[{finish_reason:call?'tool_calls':'stop',message:call?{tool_calls:[{id:call.name,type:'function',function:call}]}:{content:'File ready'}}]}));});
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const pa=provider.address();assert(pa&&typeof pa!=='string');
 const scriptToken='fixture-output-script-token-01234567890';
 const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${pa.port}/v1`,scriptToken,scriptDirectory:join(root,'scripts')}, { directory: root, servers: [provider] });
 let db:DatabaseSync|undefined;
 const connector=await rustConnectorFixture('slack',root,agent,app.origin,scriptToken,(method,raw,req,res)=>{
  if(req.url!.startsWith('/upload/')){assert.equal(req.headers.authorization,undefined);uploaded.push(raw);res.end('OK');return;}
  assert.equal(req.headers.authorization,'Bearer xoxb-'+'b'.repeat(24));
  const body=JSON.parse(raw.toString());
  if(method==='files.getUploadURLExternal'){allocated.push(body);return {file_id:`FFILE${allocated.length}`,upload_url:`http://${req.headers.host}/upload/${allocated.length}`};}
  if(method==='files.completeUploadExternal'){completed.push(body);if(lost){lost=false;req.socket.destroy();return;}return {files:body.files};}
  messages.push(body);
 });
 const journal=join(connector.directory,'slack.sqlite');
 const state=(id:unknown)=>db!.prepare('SELECT status FROM slack_outbox WHERE id=?').get(String(id))?.status;
 const recover=(id:unknown)=>runRustConnectorJournal({platform:'slack',directory:connector.directory,command:'recover',id,revision:0,action:'retry',confirmation:'--accept-duplicate-risk'});
 async function ui(path:string,body?:unknown):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await res.json();assert(res.ok,JSON.stringify(result));return result;}
 async function incoming(text='Create file'){
  const id=++sequence;
  await connector.send(slackEnvelope(id,text));
  db??=testDatabase(journal);
  return db!.prepare('SELECT * FROM slack_inbox ORDER BY rowid DESC LIMIT 1').get()!;
 }
 const until=(check:()=>boolean)=>waitFor(()=>{connector.check();return check();},'Connector did not settle');
 const restart=async()=>{await connector.stop();connector.start();await incoming('!status');};
 try{
  await ui('/api/agents',{runtime:'api', id:agent,name:'Output',model:'fixture',instructions:'Help'});await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true});connector.start();
  const first=await incoming();await until(()=>{
   const document=db!.prepare('SELECT id FROM slack_documents WHERE turn=?').get(first.turn);
   return document!==undefined&&state(document.id)==='uncertain'&&state(first.turn)==='sent';
  });const document=db!.prepare('SELECT * FROM slack_documents WHERE turn=?').get(first.turn)!;assert.equal(document.stage,2);assert.equal(db!.prepare('SELECT status FROM slack_outbox WHERE id=?').get(document.id)!.status,'uncertain');assert.equal(calls,3);assert.equal(allocated.length,1);assert.equal(uploaded.length,1);assert.deepEqual(uploaded[0],Buffer.from(text));assert.deepEqual(allocated[0],{filename:'result.html',length:Buffer.byteLength(text)});assert.equal(completed[0].channel_id,'DCHAT');assert.equal(completed[0].thread_ts,first.root);
  await restart();assert.equal(completed.length,1);await connector.stop();await recover(document.id);
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:1,enabled:false});
  connector.start();await connector.expectedFailure(/403/);assert.equal(completed.length,1);
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:2,enabled:true});
  connector.start();await until(()=>state(document.id)==='sent');assert.equal(completed.length,2);assert.deepEqual(completed[0],completed[1]);assert.equal(calls,3);
  assert.equal(uploaded.length,1);assert.equal(allocated.length,1);
  question=true;const partial=await incoming();await until(()=>!!db!.prepare('SELECT 1 FROM slack_questions WHERE turn=?').get(partial.turn));await ui(`/api/threads/${partial.thread}/turns/${partial.turn}/cancel`,{id:randomUUID()});await until(()=>{
   const document=db!.prepare('SELECT id FROM slack_documents WHERE turn=?').get(partial.turn);
   return document!==undefined&&state(document.id)==='sent'&&state(partial.turn)==='sent';
  });assert(completed.at(-1).initial_comment.includes('Partial result'));assert.deepEqual(uploaded.at(-1),Buffer.from(text));assert.deepEqual(await ui(`/api/agents/${agent}/turns`),[]);
  await connector.stop();
  const partialDoc=db!.prepare('SELECT id FROM slack_documents WHERE turn=?').get(partial.turn)!;
  db!.prepare("UPDATE slack_outbox SET status='uncertain' WHERE id=?").run(partialDoc.id);
  db!.prepare('UPDATE slack_documents SET stage=2 WHERE id=?').run(partialDoc.id);
  await recover(partialDoc.id);
  await ui(`/api/threads/${partial.thread}/edit`,{id:randomUUID(),revision:1,name:'Archived',archived:true});
  await ui(`/api/threads/${partial.thread}/delete`,{id:randomUUID(),revision:2});
  const count=completed.length;
  connector.start();await until(()=>state(partialDoc.id)==='revoked');assert.equal(completed.length,count);
 }finally{await connector.close();db?.close();await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(root,{recursive:true,force:true});}

});
