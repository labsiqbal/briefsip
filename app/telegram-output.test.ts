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


test('Telegram sends exact generated artifacts, retains uncertain delivery and rechecks grant before recovery',async()=>{
 const root=mkdtempSync(join(tmpdir(),'minarbot-telegram-output-')),agent=randomUUID(),text='<h1>Exact generated output</h1>\n';
 let calls=0,lost=true,sequence=0,question=false;const deliveries:any[]=[],messages:any[]=[];
 const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const data=JSON.parse(raw);calls++;const tools=data.messages.flatMap((m:any)=>m.tool_calls??[]);let call:any;
  if(!tools.length)call={name:'create_text_file',arguments:JSON.stringify({name:'result.html',text})};else if(question&&!tools.some((c:any)=>c.function.name==='ask_user'))call={name:'ask_user',arguments:JSON.stringify({question:'Continue?',choices:['Yes','No']})};
  res.end(JSON.stringify({choices:[{finish_reason:call?'tool_calls':'stop',message:call?{tool_calls:[{id:call.name,type:'function',function:call}]}:{content:'File ready'}}]}));});
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const pa=provider.address();assert(pa&&typeof pa!=='string');
 const scriptToken='fixture-output-script-token-01234567890';
 const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${pa.port}/v1`,scriptToken,scriptDirectory:join(root,'scripts')}, { directory: root, servers: [provider] });
 let db:DatabaseSync|undefined;
 const connector=await rustConnectorFixture('telegram',root,agent,app.origin,scriptToken,async(method,raw,req)=>{
  if(method==='sendDocument'){
   const form=await new Request('http://fixture',{method:'POST',headers:{'Content-Type':String(req.headers['content-type'])},body:new Uint8Array(raw)}).formData();
   const file=form.get('document');assert(file instanceof File);
   deliveries.push({chat:form.get('chat_id'),reply:JSON.parse(String(form.get('reply_parameters'))),name:file.name,type:file.type,bytes:Buffer.from(await file.arrayBuffer()).toString('hex'),detect:form.get('disable_content_type_detection'),caption:form.get('caption')});
   if(lost){lost=false;req.socket.destroy();return;}
   return {message_id:100+deliveries.length,chat:{id:4}};
  }
  if(method==='sendMessage')messages.push(JSON.parse(raw.toString()));
 });
 const journal=join(connector.directory,'telegram.sqlite');
 const state=(id:unknown)=>db!.prepare('SELECT status FROM telegram_outbox WHERE id=?').get(String(id))?.status;
 const recover=(id:unknown)=>runRustConnectorJournal({platform:'telegram',directory:connector.directory,command:'recover',id,revision:0,action:'retry',confirmation:'--accept-duplicate-risk'});
 async function ui(path:string,body?:unknown):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await res.json();assert(res.ok,JSON.stringify(result));return result;}
 async function incoming(text='Create file'){
  const id=++sequence;
  await connector.send(telegramUpdate(id,text));
  db??=testDatabase(journal);
  return db!.prepare('SELECT * FROM telegram_inbox ORDER BY rowid DESC LIMIT 1').get()!;
 }
 const until=(check:()=>boolean)=>waitFor(()=>{connector.check();return check();},'Connector did not settle');
 const restart=async()=>{await connector.stop();connector.start();await incoming('/status');};
 try{
  await ui('/api/agents',{runtime:'api', id:agent,name:'Artifacts',model:'fixture',instructions:'Help'});await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true});connector.start();
  const first=await incoming();await until(()=>{
   const document=db!.prepare('SELECT id FROM telegram_documents WHERE turn=?').get(first.turn);
   return document!==undefined&&state(document.id)==='uncertain'&&state(first.turn)==='sent';
  });assert.equal(calls,3);assert.equal(deliveries.length,1);assert.equal(deliveries[0].bytes,Buffer.from(text).toString('hex'));assert.equal(deliveries[0].name,'result.html');assert.equal(deliveries[0].chat,'4');assert.deepEqual(deliveries[0].reply,{message_id:1,allow_sending_without_reply:false});assert.equal(deliveries[0].type,'application/octet-stream');assert.equal(deliveries[0].detect,'true');assert.equal(messages[0].text,'File ready');
  const document=db!.prepare('SELECT * FROM telegram_documents WHERE turn=?').get(first.turn)!;assert.equal(db!.prepare('SELECT status FROM telegram_outbox WHERE id=?').get(document.id)!.status,'uncertain');
  await restart();assert.equal(deliveries.length,1);await connector.stop();await recover(document.id);
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:1,enabled:false});
  connector.start();await connector.expectedFailure(/403/);assert.equal(deliveries.length,1);
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:2,enabled:true});
  connector.start();await until(()=>state(document.id)==='sent');assert.equal(deliveries.length,2);assert.deepEqual(deliveries[0],deliveries[1]);assert.equal(calls,3);
  question=true;const partial=await incoming();await until(()=>!!db!.prepare('SELECT 1 FROM telegram_questions WHERE turn=?').get(partial.turn));await ui(`/api/threads/${partial.thread}/turns/${partial.turn}/cancel`,{id:randomUUID()});await until(()=>{
   const document=db!.prepare('SELECT id FROM telegram_documents WHERE turn=?').get(partial.turn);
   return document!==undefined&&state(document.id)==='sent'&&state(partial.turn)==='sent';
  });assert.equal(deliveries.length,3);assert.match(String(deliveries[2].caption),/Partial result/);assert(messages.some(m=>m.text.includes('partial result')));
  await connector.stop();
  const partialDoc=db!.prepare('SELECT id FROM telegram_documents WHERE turn=?').get(partial.turn)!;
  db!.prepare("UPDATE telegram_outbox SET status='uncertain',part=0,message_ids='[]' WHERE id=?").run(partialDoc.id);
  await recover(partialDoc.id);
  await ui(`/api/threads/${partial.thread}/edit`,{id:randomUUID(),revision:1,name:'Archived',archived:true});
  await ui(`/api/threads/${partial.thread}/delete`,{id:randomUUID(),revision:2});
  const count=deliveries.length;
  connector.start();await until(()=>state(partialDoc.id)==='revoked');assert.equal(deliveries.length,count);
 }finally{await connector.close();db?.close();await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(root,{recursive:true,force:true});}

});
