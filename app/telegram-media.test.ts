import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startApp} from './test-bridge.ts';
import {pdfFixture} from './test-support/pdf-fixture.ts';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {initializeTelegram,bindTelegram,recordTelegramUpdates,telegramApi,telegramInput} from './telegram.ts';
import {telegramAgentStep,telegramLocal} from './telegram-bridge.ts';

test('Telegram media uploads once in requester thread and retries lost uploads/messages with original bytes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-telegram-media-')),agent=randomUUID(),other=randomUUID(),token='local-script-test-token-with-32-characters',users=new Set([4,5]);
 const captures:any[]=[],uploads:any[]=[],sent:any[]=[],downloads:string[]=[];let sequence=0,loseUpload=true,loseMessage=true;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkAAAAABJRU5ErkJggg==','base64');
 const payloads:Record<string,Buffer>={text:Buffer.from('Exact attachment contents'),image:png,binary:Buffer.from([0,255]),oversize:Buffer.alloc(4*1024*1024+1)};
 const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;captures.push(JSON.parse(raw));res.end(JSON.stringify({choices:[{message:{content:'Received'},finish_reason:'stop'}]}));});
 const telegram=createServer(async(req,res)=>{const path=req.url!;if(path.startsWith('/file/')){const id=path.split('/').at(-1)!;downloads.push(id);res.end(payloads[id]);return;}let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);let result:any;
  if(path.endsWith('/getFile'))result={file_id:body.file_id,file_path:`documents/${body.file_id}`};else{sent.push(body);result={message_id:sent.length+100,chat:{id:body.chat_id}};}res.end(JSON.stringify({ok:true,result}));});
 await Promise.all([new Promise<void>(r=>provider.listen(0,'127.0.0.1',r)),new Promise<void>(r=>telegram.listen(0,'127.0.0.1',r))]);const pa=provider.address(),ta=telegram.address();assert(pa&&typeof pa!=='string'&&ta&&typeof ta!=='string');
 const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${pa.port}/v1`,scriptToken:token,scriptDirectory:join(root,'scripts')});let db=new DatabaseSync(join(root,'telegram.sqlite'));
 const remote=telegramApi('123:'+'x'.repeat(24),`http://127.0.0.1:${ta.port}`),actual=telegramLocal(join(root,'scripts'));
 const local=async(path:string,body?:unknown,signal?:AbortSignal,name?:string)=>{const value=await actual(path,body,signal,name);if(name){uploads.push({path,name,bytes:Buffer.from(body as Uint8Array).toString('hex')});if(loseUpload){loseUpload=false;throw new Error('Lost upload');}}else if(body&&path.endsWith('/turns')&&loseMessage){loseMessage=false;throw new Error('Lost message');}return value;};
 async function ui(path:string,body?:unknown):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await res.json();assert(res.ok,JSON.stringify(value));return value;}
 function incoming(id:string,user=4,caption='Read attached',size?:number){sequence++;recordTelegramUpdates(db,[{update_id:sequence,message:{message_id:sequence,chat:{id:user,type:'private'},from:{id:user,is_bot:false},caption,document:{file_id:id,file_name:`${id}.dat`,...(size===undefined?{}:{file_size:size})}}}],users);return db.prepare('SELECT * FROM telegram_inbox WHERE update_id=?').get(sequence)!;}
 async function settle(turn:unknown){for(let n=0;n<200;n++){await telegramAgentStep(db,users,local,remote);if(db.prepare('SELECT status FROM telegram_inbox WHERE turn=?').get(String(turn))?.status==='done')return;await new Promise(r=>setTimeout(r,10));}assert.fail('Telegram task did not settle');}
 try{
  for(const id of [agent,other])await ui('/api/agents',{runtime:'api', id,name:id===agent?'Media':'Other',model:'fixture',instructions:'Help'});
  for(const id of [agent,other])await ui(`/api/agents/${id}/scripts`,{id:randomUUID(),revision:0,enabled:true});initializeTelegram(db);bindTelegram(db,123,agent);
  const text=incoming('text');await assert.rejects(telegramAgentStep(db,users,local,remote),/Lost upload/);payloads.text=Buffer.from('CHANGED REMOTE');db.close();db=new DatabaseSync(join(root,'telegram.sqlite'));initializeTelegram(db);
  await assert.rejects(telegramAgentStep(db,users,local,remote),/Lost message/);await settle(text.turn);assert.equal(downloads.filter(x=>x==='text').length,1);assert.deepEqual(uploads[0],uploads[1]);assert.equal(captures.length,1);assert(JSON.stringify(captures[0]).includes('Exact attachment contents'));
  const files=await ui(`/api/threads/${text.thread}/files`);assert.equal(files.length,1);assert.deepEqual(await ui(`/api/agents/${agent}/turns`),[]);
  const auth={Authorization:`Bearer ${token}`};let res=await fetch(`${app.origin}/api/scripts/agents/${other}/threads/${text.thread}/files`,{headers:auth});assert.equal(res.status,404);await res.text();
  res=await fetch(`${app.origin}/api/scripts/agents/${agent}/threads/${text.thread}/files/${files[0].id}`,{headers:auth});assert.equal(await res.text(),'Exact attachment contents');
  const photo=incoming('image',5,'/stop not-a-command');await settle(photo.turn);assert.notEqual(photo.thread,text.thread);assert.equal(captures.length,2);assert(JSON.stringify(captures[1]).includes('data:image/png;base64,'));assert.equal((await ui(`/api/threads/${photo.thread}/files`)).length,1);
  const unsupported=incoming('binary');await settle(unsupported.turn);const tooLarge=incoming('image',4,'Too big',10*1024*1024+1);await settle(tooLarge.turn);const streamedLarge=incoming('oversize');await settle(streamedLarge.turn);assert.equal(captures.length,2);assert.equal(downloads.filter(x=>x==='image').length,1);assert(sent.some(row=>row.text.includes('Attachment cannot be processed')));
  const fileId=randomUUID();let release!:()=>void;const uploadPath=`/api/scripts/agents/${agent}/threads/${text.thread}/files/${fileId}`;
  const streamed=new Promise<number|undefined>((resolve,reject)=>{const req=httpRequest(app.origin+uploadPath,{method:'POST',headers:{...auth,'Content-Type':'application/octet-stream','X-File-Name':'late.txt'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write('first');release=()=>req.end('last');});
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:1,enabled:false});release();assert.equal(await streamed,403);assert(!(await ui(`/api/threads/${text.thread}/files`)).some((file:any)=>file.id===fileId));
  const revoked=incoming('text',4,'/stop ordinary caption');await assert.rejects(telegramAgentStep(db,users,local,remote),/403/);assert.equal(downloads.filter(x=>x==='text').length,1);
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:2,enabled:true});await ui(`/api/threads/${text.thread}/edit`,{id:randomUUID(),revision:1,name:'Archived',archived:true});await settle(revoked.turn);assert.equal(captures.length,2);assert(db.prepare('SELECT 1 FROM telegram_closed_threads WHERE id=?').get(text.thread),'Media caption failure must close archived thread mapping');const fresh=incoming('text');assert.notEqual(fresh.thread,text.thread);await settle(fresh.turn);assert.equal(captures.length,3);
  const originalPdf=Buffer.concat([pdfFixture('TELEGRAM_PDF_TEXT'),Buffer.alloc(5*1024*1024,32)]);payloads.pdf=originalPdf;loseUpload=true;loseMessage=true;
  const pdf=incoming('pdf');await assert.rejects(telegramAgentStep(db,users,local,remote),/Lost upload/);payloads.pdf=pdfFixture('CHANGED_PDF');db.close();db=new DatabaseSync(join(root,'telegram.sqlite'));initializeTelegram(db);
  await assert.rejects(telegramAgentStep(db,users,local,remote),/Lost message/);await settle(pdf.turn);assert.equal(captures.length,4);assert(JSON.stringify(captures.at(-1)).includes('TELEGRAM_PDF_TEXT'));assert.equal(downloads.filter(id=>id==='pdf').length,1);
  const pdfFile=db.prepare('SELECT upload FROM telegram_media WHERE turn=?').get(pdf.turn)!;const downloaded=await fetch(`${app.origin}/api/threads/${pdf.thread}/files/${pdfFile.upload}`);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),originalPdf);
  payloads.badPdf=Buffer.from('%PDF-malformed');payloads.largePdf=pdfFixture('X'.repeat(500),70);
  payloads.huge=Buffer.alloc(10*1024*1024+1);payloads.largeImage=Buffer.concat([png,Buffer.alloc(4*1024*1024)]);
  for(const file of ['badPdf','largePdf','huge','largeImage']){const row=incoming(file);await settle(row.turn);}assert.equal(captures.length,4);
  const afterFailure=incoming('pdf');await settle(afterFailure.turn);assert.equal(captures.length,5);assert(JSON.stringify(captures.at(-1)).includes('CHANGED_PDF'));
  const retry=incoming('pdf'),originalSpawn=childProcess.spawn,count=captures.length,downloadCount=downloads.length;
  childProcess.spawn=((...args:Parameters<typeof childProcess.spawn>)=>args[0]==='/usr/bin/bwrap'?originalSpawn('/usr/bin/bwrap',['--ro-bind','/briefsip-nonexistent-fixture-path','/missing','/bin/true'],args[2]):originalSpawn(...args)) as typeof childProcess.spawn;syncBuiltinESMExports();
  try{await assert.rejects(telegramAgentStep(db,users,local,remote),/503/);assert.equal(db.prepare('SELECT status FROM telegram_inbox WHERE turn=?').get(retry.turn)!.status,'submitting');assert.equal(captures.length,count);}
  finally{childProcess.spawn=originalSpawn;syncBuiltinESMExports();}
  db.close();db=new DatabaseSync(join(root,'telegram.sqlite'));initializeTelegram(db);await settle(retry.turn);assert.equal(captures.length,count+1);assert.equal(downloads.length,downloadCount+1);

 }finally{db.close();await app.close();provider.closeAllConnections();telegram.closeAllConnections();await Promise.all([new Promise<void>(r=>provider.close(()=>r())),new Promise<void>(r=>telegram.close(()=>r()))]);rmSync(root,{recursive:true,force:true});}
});

test('Telegram download paths never escape the bound file endpoint',async()=>{
 const request=telegramApi('123:'+'x'.repeat(24),'http://127.0.0.1:1');
 for(const file_path of ['../secret','/absolute','https://other/file','a/%2e%2e/x','a/../x','a?x','a\\b',''])await assert.rejects(request('downloadFile',{file_path}),/rejected request \(400\)/);
});


test('Telegram photos select the largest supplied size and keep captions as text',()=>{
 const message={message_id:1,chat:{id:4,type:'private'},from:{id:4,is_bot:false},caption:'/approve plain caption',photo:[{file_id:'large',file_size:200,width:200,height:100},{file_id:'small',file_size:100,width:20,height:10}]};
 const input=telegramInput({update_id:1,message},new Set([4]));assert.equal(input?.media?.id,'large');assert.equal(input?.text,'/approve plain caption');assert.equal(input?.media?.name,'telegram-photo.jpg');
 assert.equal(telegramInput({update_id:1,message:{...message,caption:{}}},new Set([4])),null);
 assert.equal(telegramInput({update_id:1,message},new Set([5])),null);
});
