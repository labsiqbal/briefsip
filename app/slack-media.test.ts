import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startApp} from './test-bridge.ts';
import {pdfFixture} from './test-support/pdf-fixture.ts';
import { localScript } from './test-support/script-client.ts';
import { rustConnectorFixture, slackEnvelope, telegramUpdate, waitFor } from './test-support/rust-connector-fixture.ts';

test('Slack files snapshot bytes and retry uploads and turns without duplicate work',async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-slack-media-')),agent=randomUUID(),captures:any[]=[],downloads:string[]=[];
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkAAAAABJRU5ErkJggg==','base64');
 const bytes:Record<string,Buffer>={FTEXT:Buffer.from('Exact Slack file content'),FIMAGE:png,FBINARY:Buffer.from([0,255]),FLARGE:Buffer.alloc(4*1024*1024+1),FEXTERNAL:Buffer.from('secret')};let sequence=0;
 const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;captures.push(JSON.parse(raw));res.end(JSON.stringify({choices:[{message:{content:'Read'},finish_reason:'stop'}]}));});
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const pa=provider.address();assert(pa&&typeof pa!=='string');
 const scriptToken='fixture-media-script-token-01234567890';
 let pdfUnavailable=false;
 const pdfFault=async()=>pdfUnavailable?{status:503,error:'PDF sandbox is unavailable.'}:undefined;
 const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${pa.port}/v1`,scriptToken,scriptDirectory:join(root,'scripts'),pdfFault}, { directory: root, servers: [provider] });
 const actual=localScript(join(root,'scripts'));
 let db:DatabaseSync|undefined;
 const connector=await rustConnectorFixture('slack',root,agent,app.origin,scriptToken,(method,raw,req,res)=>{
  assert.equal(req.headers.authorization,'Bearer xoxb-'+'b'.repeat(24));
  if(req.url!.startsWith('/download/')){downloads.push(method);res.end(bytes[method]);return;}
  if(method==='files.info'){
   const {file}=JSON.parse(raw.toString());
   return {file:{id:file,name:`${file}.dat`,size:file==='FLARGE'?1:bytes[file].length,mode:file==='FEXTERNAL'?'external':'hosted',is_external:file==='FEXTERNAL',url_private:`http://${req.headers.host}/download/${file}`}};
  }
 });
 const journal=join(connector.directory,'slack.sqlite');
 const armFaults=()=>connector.faults.push(
  {method:'POST',path:/\/files\/[^/]+$/,after:true},
  {method:'POST',path:/\/turns$/,after:true},
 );
 const lost=()=>connector.expectedFailure(/Local agent request failed/);
 const start=()=>{db?.close();db=new DatabaseSync(journal);connector.start();};
 const uploads=()=>connector.requests.filter(request=>request.method==='POST'&&/\/files\/[^/]+$/.test(request.path));
 const sent=()=>connector.jsonPosts<any>('chat.postMessage');
 async function ui(path:string,body?:unknown):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await res.json();assert(res.ok,JSON.stringify(value));return value;}
 async function incoming(files:string[],text='Read files',sender='UUSER'){
  const id=++sequence;const envelope=slackEnvelope(id,text,sender);
  Object.assign(envelope.payload.event,{subtype:'file_share',bot_id:null,files:files.map(id=>({id}))});
  await connector.send(envelope);db??=new DatabaseSync(journal);
  return db!.prepare('SELECT * FROM slack_inbox WHERE event=?').get(`Ev${id}`)!;
 }
 async function settle(turn:unknown){
  await waitFor(()=>{connector.check();return db!.prepare('SELECT status FROM slack_inbox WHERE turn=?').get(String(turn))?.status==='done'&&db!.prepare('SELECT status FROM slack_outbox WHERE id=?').get(String(turn))?.status==='sent';},'Media task did not settle');
 }
 try{
  await ui('/api/agents',{runtime:'api', id:agent,name:'Files',model:'fixture',instructions:'Help'});await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true});connector.start();armFaults();
  assert.equal(await incoming(['FTEXT'],'ignored','UNOT'),undefined);
  const row=await incoming(['FTEXT']);await lost();bytes.FTEXT=Buffer.from('Changed remote');start();await lost();start();await settle(row.turn);
  assert.equal(downloads.filter(id=>id==='FTEXT').length,1);assert.deepEqual(uploads()[0],uploads()[1]);assert.equal(captures.length,1);assert(JSON.stringify(captures[0]).includes('Exact Slack file content'));assert.equal((await ui(`/api/threads/${row.thread}/files`)).length,1);assert.deepEqual(await ui(`/api/agents/${agent}/turns`),[]);
  const image=await incoming(['FIMAGE'],'')!;await settle(image.turn);assert(JSON.stringify(captures.at(-1)).includes(png.toString('base64')));
  for(const ids of [['FBINARY'],['FLARGE'],['FEXTERNAL'],['FTEXT','FTEXT'],Array.from({length:5},(_,i)=>`FFILE${i}`)]){const before:number=captures.length;const bad=await incoming(ids)!;await settle(bad.turn);assert.equal(captures.length,before);assert.equal(sent().at(-1).text, ids.length > 4 || new Set(ids).size !== ids.length ? 'Invalid attachment. Send at most four different files.' : 'Attachment cannot be processed. Use at most four files: UTF-8 text or combined PDF text up to 32 KiB (PDF up to 10 MiB), or PNG/JPEG/WebP images up to 4 MiB each.');}
  assert(!downloads.includes('FEXTERNAL'));
  const command=await incoming(['FTEXT'],'!status')!;await settle(command.turn);assert.equal(captures.length,3);assert(JSON.stringify(captures.at(-1)).includes('!status'));
  const workflow=await ui(`/api/agents/${agent}/workflows`,{id:randomUUID(),revision:0,name:'Wait',graph:{entry:'ask',maxSteps:2,nodes:[{id:'ask',kind:'approval',prompt:'Proceed?',yes:'out'},{id:'out',kind:'output'}]}});const run=randomUUID();await actual(`/api/scripts/agents/${agent}/workflows/${workflow.id}/run`,{id:run,revision:1,input:'Wait'});
  const rootTs=slackEnvelope(sequence+1,'').payload.event.ts;
  db!.prepare('INSERT INTO slack_workflows VALUES (?,?,?,?,?)').run(run,'DCHAT','UUSER',rootTs,workflow.id);
  const stopCaption=await incoming(['FTEXT'],`!stop ${run}`);await settle(stopCaption.turn);assert.equal((await ui(`/api/workflow-runs/${run}`)).status,'approval');assert.equal(captures.length,4);assert(JSON.stringify(captures.at(-1)).includes(`!stop ${run}`));
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:1,enabled:false});const before=downloads.length;const revoked=await incoming(['FTEXT']);
  await connector.expectedFailure(/403/);assert.equal(downloads.length,before);assert.equal(captures.length,4);
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:2,enabled:true});start();await settle(revoked.turn);
  const originalPdf=Buffer.concat([pdfFixture('SLACK_PDF_TEXT'),Buffer.alloc(5*1024*1024,32)]);bytes.FPDF=originalPdf;armFaults();
  const pdf=await incoming(['FPDF']);await lost();bytes.FPDF=pdfFixture('CHANGED_PDF');start();await lost();start();await settle(pdf.turn);assert(JSON.stringify(captures.at(-1)).includes('SLACK_PDF_TEXT'));assert.equal(downloads.filter(id=>id==='FPDF').length,1);
  const pdfFile=db!.prepare('SELECT upload FROM slack_media WHERE turn=?').get(pdf.turn)!;const downloaded=await fetch(`${app.origin}/api/threads/${pdf.thread}/files/${pdfFile.upload}`);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),originalPdf);
  const count=captures.length;bytes.FBADPDF=Buffer.from('%PDF-malformed');bytes.FBIGPDF=pdfFixture('X'.repeat(500),70);
  bytes.FHUGE=Buffer.alloc(10*1024*1024+1);bytes.FLARGEIMAGE=Buffer.concat([png,Buffer.alloc(4*1024*1024)]);
  for(const file of ['FBADPDF','FBIGPDF','FHUGE','FLARGEIMAGE']){const row=await incoming([file])!;await settle(row.turn);}assert.equal(captures.length,count);
  bytes.FHALF1=pdfFixture('X'.repeat(500),34);bytes.FHALF2=pdfFixture('Y'.repeat(500),34);await settle((await incoming(['FHALF1','FHALF2'])).turn);assert.equal(captures.length,count);
  const afterFailure=await incoming(['FPDF'])!;await settle(afterFailure.turn);assert.equal(captures.length,count+1);assert(JSON.stringify(captures.at(-1)).includes('CHANGED_PDF'));
  const retryCount=captures.length,downloadCount=downloads.length;
  pdfUnavailable=true;
  let retry;
  try{retry=await incoming(['FPDF']);await connector.expectedFailure(/503/);assert.equal(db!.prepare('SELECT status FROM slack_inbox WHERE turn=?').get(retry.turn)!.status,'submitting');assert.equal(captures.length,retryCount);}
  finally{pdfUnavailable=false;}
  start();assert(retry);await settle(retry.turn);assert.equal(captures.length,retryCount+1);assert.equal(downloads.length,downloadCount+1);

 }finally{await connector.close();db?.close();await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});
