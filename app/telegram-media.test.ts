import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {randomUUID} from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { testDatabase } from './test-support/database.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startApp} from './test-bridge.ts';
import {pdfFixture} from './test-support/pdf-fixture.ts';
import { rustConnectorFixture, slackEnvelope, telegramUpdate, waitFor } from './test-support/rust-connector-fixture.ts';

test('Telegram media uploads once in requester thread and retries lost uploads/messages with original bytes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'minarbot-telegram-media-')),agent=randomUUID(),other=randomUUID(),token='local-script-test-token-with-32-characters';
 const captures:any[]=[],downloads:string[]=[];let sequence=0;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkAAAAABJRU5ErkJggg==','base64');
 const payloads:Record<string,Buffer>={text:Buffer.from('Exact attachment contents'),image:png,binary:Buffer.from([0,255]),oversize:Buffer.alloc(4*1024*1024+1)};
 const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;captures.push(JSON.parse(raw));res.end(JSON.stringify({choices:[{message:{content:'Received'},finish_reason:'stop'}]}));});
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const pa=provider.address();assert(pa&&typeof pa!=='string');
 const scriptToken=token;
 let pdfUnavailable=false;
 const pdfFault=async()=>pdfUnavailable?{status:503,error:'PDF sandbox is unavailable.'}:undefined;
 const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${pa.port}/v1`,scriptToken,scriptDirectory:join(root,'scripts'),pdfFault}, { directory: root, servers: [provider] });
 let db:DatabaseSync|undefined;
 const connector=await rustConnectorFixture('telegram',root,agent,app.origin,scriptToken,(method,raw,req,res)=>{
  if(req.url!.startsWith('/file/')){downloads.push(method);res.end(payloads[method]);return;}
  if(method==='getFile'){const {file_id}=JSON.parse(raw.toString());return {file_id,file_path:`documents/${file_id}`};}
 });
 const journal=join(connector.directory,'telegram.sqlite');
 const armFaults=()=>connector.faults.push(
  {method:'POST',path:/\/files\/[^/]+$/,after:true},
  {method:'POST',path:/\/turns$/,after:true},
 );
 const lost=()=>connector.expectedFailure(/Local agent request failed/);
 const start=()=>{db?.close();db=testDatabase(journal);connector.start();};
 const uploads=()=>connector.requests.filter(request=>request.method==='POST'&&/\/files\/[^/]+$/.test(request.path));
 const sent=()=>connector.jsonPosts<any>('sendMessage');
 async function ui(path:string,body?:unknown):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await res.json();assert(res.ok,JSON.stringify(value));return value;}
 async function incoming(file:string,user=4,caption='Read attached',size?:number){
  const id=++sequence;const update=telegramUpdate(id,'',user);
  Object.assign(update.message,{caption,document:{file_id:file,file_name:`${file}.dat`,...(size===undefined?{}:{file_size:size})}});
  await connector.send(update);db??=testDatabase(journal);
  return db!.prepare('SELECT * FROM telegram_inbox WHERE update_id=?').get(id)!;
 }
 async function settle(turn:unknown){
  await waitFor(()=>{connector.check();return db!.prepare('SELECT status FROM telegram_inbox WHERE turn=?').get(String(turn))?.status==='done'&&db!.prepare('SELECT status FROM telegram_outbox WHERE id=?').get(String(turn))?.status==='sent';},'Media task did not settle');
 }
 try{
  for(const id of [agent,other])await ui('/api/agents',{runtime:'api', id,name:id===agent?'Media':'Other',model:'fixture',instructions:'Help'});
  for(const id of [agent,other])await ui(`/api/agents/${id}/scripts`,{id:randomUUID(),revision:0,enabled:true});connector.start();armFaults();
  const text=await incoming('text');await lost();payloads.text=Buffer.from('CHANGED REMOTE');start();await lost();start();await settle(text.turn);assert.equal(downloads.filter(x=>x==='text').length,1);assert.deepEqual(uploads()[0],uploads()[1]);assert.equal(captures.length,1);assert(JSON.stringify(captures[0]).includes('Exact attachment contents'));
  const files=await ui(`/api/threads/${text.thread}/files`);assert.equal(files.length,1);assert.deepEqual(await ui(`/api/agents/${agent}/turns`),[]);
  const auth={Authorization:`Bearer ${token}`};let res=await fetch(`${app.origin}/api/scripts/agents/${other}/threads/${text.thread}/files`,{headers:auth});assert.equal(res.status,404);await res.text();
  res=await fetch(`${app.origin}/api/scripts/agents/${agent}/threads/${text.thread}/files/${files[0].id}`,{headers:auth});assert.equal(await res.text(),'Exact attachment contents');
  const photo=await incoming('image',5,'/stop not-a-command');await settle(photo.turn);assert.notEqual(photo.thread,text.thread);assert.equal(captures.length,2);assert(JSON.stringify(captures[1]).includes('data:image/png;base64,'));assert.equal((await ui(`/api/threads/${photo.thread}/files`)).length,1);
  const unsupported=await incoming('binary');await settle(unsupported.turn);const tooLarge=await incoming('image',4,'Too big',10*1024*1024+1);await settle(tooLarge.turn);const streamedLarge=await incoming('oversize');await settle(streamedLarge.turn);assert.equal(captures.length,2);assert.equal(downloads.filter(x=>x==='image').length,1);assert(sent().some(row=>row.text.includes('Attachment cannot be processed')));
  const fileId=randomUUID();let release!:()=>void;const uploadPath=`/api/scripts/agents/${agent}/threads/${text.thread}/files/${fileId}`;
  const streamed=new Promise<number|undefined>((resolve,reject)=>{const req=httpRequest(app.origin+uploadPath,{method:'POST',headers:{...auth,'Content-Type':'application/octet-stream','X-File-Name':'late.txt'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write('first');release=()=>req.end('last');});
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:1,enabled:false});release();assert.equal(await streamed,403);assert(!(await ui(`/api/threads/${text.thread}/files`)).some((file:any)=>file.id===fileId));
  const revoked=await incoming('text',4,'/stop ordinary caption');await connector.expectedFailure(/403/);assert.equal(downloads.filter(x=>x==='text').length,1);
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:2,enabled:true});await ui(`/api/threads/${text.thread}/edit`,{id:randomUUID(),revision:1,name:'Archived',archived:true});start();await settle(revoked.turn);assert.equal(captures.length,2);assert(db!.prepare('SELECT 1 FROM telegram_closed_threads WHERE id=?').get(text.thread),'Media caption failure must close archived thread mapping');const fresh=await incoming('text');assert.notEqual(fresh.thread,text.thread);await settle(fresh.turn);assert.equal(captures.length,3);
  const originalPdf=Buffer.concat([pdfFixture('TELEGRAM_PDF_TEXT'),Buffer.alloc(5*1024*1024,32)]);payloads.pdf=originalPdf;armFaults();
  const pdf=await incoming('pdf');await lost();payloads.pdf=pdfFixture('CHANGED_PDF');start();await lost();start();await settle(pdf.turn);assert.equal(captures.length,4);assert(JSON.stringify(captures.at(-1)).includes('TELEGRAM_PDF_TEXT'));assert.equal(downloads.filter(id=>id==='pdf').length,1);
  const pdfFile=db!.prepare('SELECT upload FROM telegram_media WHERE turn=?').get(pdf.turn)!;const downloaded=await fetch(`${app.origin}/api/threads/${pdf.thread}/files/${pdfFile.upload}`);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),originalPdf);
  payloads.badPdf=Buffer.from('%PDF-malformed');payloads.largePdf=pdfFixture('X'.repeat(500),70);
  payloads.huge=Buffer.alloc(10*1024*1024+1);payloads.largeImage=Buffer.concat([png,Buffer.alloc(4*1024*1024)]);
  for(const file of ['badPdf','largePdf','huge','largeImage']){const row=await incoming(file);await settle(row.turn);}assert.equal(captures.length,4);
  const afterFailure=await incoming('pdf');await settle(afterFailure.turn);assert.equal(captures.length,5);assert(JSON.stringify(captures.at(-1)).includes('CHANGED_PDF'));
  const count=captures.length,downloadCount=downloads.length;
  pdfUnavailable=true;
  let retry;
  try{retry=await incoming('pdf');await connector.expectedFailure(/503/);assert.equal(db!.prepare('SELECT status FROM telegram_inbox WHERE turn=?').get(retry.turn)!.status,'submitting');assert.equal(captures.length,count);}
  finally{pdfUnavailable=false;}
  start();assert(retry);await settle(retry.turn);assert.equal(captures.length,count+1);assert.equal(downloads.length,downloadCount+1);

 }finally{await connector.close();db?.close();await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});
