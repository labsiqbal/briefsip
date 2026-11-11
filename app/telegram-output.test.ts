import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startApp} from './server.ts';
import {telegramApi,initializeTelegram,bindTelegram,recordTelegramUpdates,recoverTelegramReply,queueTelegramReply,deliverTelegramReply} from './telegram.ts';
import {telegramLocal,telegramAgentStep} from './telegram-bridge.ts';

test('Telegram sends exact generated artifacts, retains uncertain delivery and rechecks grant before recovery',async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-telegram-output-')),agent=randomUUID(),users=new Set([4]),text='<h1>Exact generated output</h1>\n';
 let calls=0,lost=true,sequence=0,question=false;const deliveries:any[]=[],messages:any[]=[];
 const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const data=JSON.parse(raw);calls++;const tools=data.messages.flatMap((m:any)=>m.tool_calls??[]);let call:any;
  if(!tools.length)call={name:'create_text_file',arguments:JSON.stringify({name:'result.html',text})};else if(question&&!tools.some((c:any)=>c.function.name==='ask_user'))call={name:'ask_user',arguments:JSON.stringify({question:'Continue?',choices:['Yes','No']})};
  res.end(JSON.stringify({choices:[{finish_reason:call?'tool_calls':'stop',message:call?{tool_calls:[{id:call.name,type:'function',function:call}]}:{content:'File ready'}}]}));});
 const telegram=createServer(async(req,res)=>{const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));const raw=Buffer.concat(parts);
  if(req.url?.endsWith('/sendDocument')){const form=await new Request('http://fixture',{method:'POST',headers:{'Content-Type':String(req.headers['content-type'])},body:raw}).formData();const file=form.get('document') as File;deliveries.push({chat:form.get('chat_id'),reply:JSON.parse(String(form.get('reply_parameters'))),name:file.name,type:file.type,bytes:Buffer.from(await file.arrayBuffer()).toString('hex'),detect:form.get('disable_content_type_detection'),caption:form.get('caption')});if(lost){lost=false;req.socket.destroy();return;}res.end(JSON.stringify({ok:true,result:{message_id:100+deliveries.length,chat:{id:4}}}));}
  else{const body=JSON.parse(raw.toString());messages.push(body);res.end(JSON.stringify({ok:true,result:{message_id:messages.length,chat:{id:4}}}));}});
 await Promise.all([new Promise<void>(r=>provider.listen(0,'127.0.0.1',r)),new Promise<void>(r=>telegram.listen(0,'127.0.0.1',r))]);const pa=provider.address(),ta=telegram.address();assert(pa&&typeof pa!=='string'&&ta&&typeof ta!=='string');
 const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${pa.port}/v1`,scriptDirectory:join(root,'scripts')});let db=new DatabaseSync(join(root,'telegram.sqlite'));const local=telegramLocal(join(root,'scripts')),remote=telegramApi('123:'+'x'.repeat(24),`http://127.0.0.1:${ta.port}`);
 async function ui(path:string,body?:unknown):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await res.json();assert(res.ok,JSON.stringify(result));return result;}
 function incoming(){sequence++;recordTelegramUpdates(db,[{update_id:sequence,message:{message_id:sequence,chat:{id:4,type:'private'},from:{id:4,is_bot:false},text:`Create file ${sequence}`}}],users);return db.prepare('SELECT * FROM telegram_inbox WHERE update_id=?').get(sequence)!;}
 async function until(check:()=>boolean){for(let n=0;n<200;n++){await telegramAgentStep(db,users,local,remote);if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Did not settle');}
 try{
  await ui('/api/agents',{id:agent,name:'Artifacts',model:'fixture',instructions:'Help'});await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true});initializeTelegram(db);bindTelegram(db,123,agent);
  const first=incoming();await until(()=>db.prepare('SELECT status FROM telegram_inbox WHERE turn=?').get(first.turn)!.status==='done');assert.equal(calls,2);assert.equal(deliveries.length,1);assert.equal(deliveries[0].bytes,Buffer.from(text).toString('hex'));assert.equal(deliveries[0].name,'result.html');assert.equal(deliveries[0].chat,'4');assert.deepEqual(deliveries[0].reply,{message_id:1,allow_sending_without_reply:false});assert.equal(deliveries[0].type,'application/octet-stream');assert.equal(deliveries[0].detect,'true');assert.equal(messages[0].text,'File ready');
  const document=db.prepare('SELECT * FROM telegram_documents WHERE turn=?').get(first.turn)!;assert.equal(db.prepare('SELECT status FROM telegram_outbox WHERE id=?').get(document.id)!.status,'uncertain');
  db.close();db=new DatabaseSync(join(root,'telegram.sqlite'));initializeTelegram(db);await telegramAgentStep(db,users,local,remote);assert.equal(deliveries.length,1);recoverTelegramReply(db,String(document.id),0,'retry');
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:1,enabled:false});await assert.rejects(telegramAgentStep(db,users,local,remote));assert.equal(deliveries.length,1);
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:2,enabled:true});await telegramAgentStep(db,users,local,remote);assert.equal(deliveries.length,2);assert.deepEqual(deliveries[0],deliveries[1]);assert.equal(calls,2);
  question=true;const partial=incoming();await until(()=>!!db.prepare('SELECT 1 FROM telegram_questions WHERE turn=?').get(partial.turn));await ui(`/api/threads/${partial.thread}/turns/${partial.turn}/cancel`,{id:randomUUID()});await until(()=>db.prepare('SELECT status FROM telegram_inbox WHERE turn=?').get(partial.turn)!.status==='done');assert.equal(deliveries.length,3);assert.match(String(deliveries[2].caption),/Hasil parsial/);assert(messages.some(m=>m.text.includes('hasil parsial')));
  const partialDoc=db.prepare('SELECT * FROM telegram_documents WHERE turn=?').get(partial.turn)!;db.prepare("UPDATE telegram_outbox SET status='uncertain',part=0,message_ids='[]' WHERE id=?").run(partialDoc.id);recoverTelegramReply(db,String(partialDoc.id),0,'retry');
  await ui(`/api/threads/${partial.thread}/edit`,{id:randomUUID(),revision:1,name:'Archived',archived:true});await ui(`/api/threads/${partial.thread}/delete`,{id:randomUUID(),revision:2});await telegramAgentStep(db,users,local,remote);assert.equal(deliveries.length,3);assert.equal(db.prepare('SELECT status FROM telegram_outbox WHERE id=?').get(partialDoc.id)!.status,'revoked');
 }finally{db.close();await app.close();provider.closeAllConnections();telegram.closeAllConnections();await Promise.all([new Promise<void>(r=>provider.close(()=>r())),new Promise<void>(r=>telegram.close(()=>r()))]);rmSync(root,{recursive:true,force:true});}
});

test('Telegram binary document journal shares partial failure and no-replay semantics',async()=>{
 const db=new DatabaseSync(':memory:'),id=randomUUID(),bytes=Buffer.from([0,255,128,1]);
 try{initializeTelegram(db);db.prepare('INSERT INTO telegram_documents VALUES (?,?,?,?,?,?)').run(id,randomUUID(),randomUUID(),randomUUID(),'binary.dat',bytes);queueTelegramReply(db,id,4,1,'File: binary.dat');let calls=0;
  const remote=async(method:string,body:Record<string,unknown>)=>{calls++;assert.equal(method,'sendDocument');assert.deepEqual(Buffer.from(body.bytes as Uint8Array),bytes);return {message_id:1,chat:{id:5}};};
  await deliverTelegramReply(db,id,remote);assert.equal(db.prepare('SELECT status FROM telegram_outbox').get()!.status,'uncertain');initializeTelegram(db);await deliverTelegramReply(db,id,remote);assert.equal(calls,1);
 }finally{db.close();}
});
