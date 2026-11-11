import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startApp} from './server.ts';
import {pdfFixture} from './pdf-fixture.ts';
import {initializeSlack,bindSlack,recordSlackEnvelope,slackApi} from './slack.ts';
import {slackAgentStep} from './slack-runner.ts';
import {localScript} from './script-client.ts';

test('Slack files snapshot bytes and retry uploads and turns without duplicate work',async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-slack-media-')),agent=randomUUID(),users=new Set(['UUSER']),captures:any[]=[],uploads:any[]=[],downloads:string[]=[],sent:any[]=[];
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkAAAAABJRU5ErkJggg==','base64');
 const bytes:Record<string,Buffer>={FTEXT:Buffer.from('Exact Slack file content'),FIMAGE:png,FBINARY:Buffer.from([0,255]),FLARGE:Buffer.alloc(4*1024*1024+1),FEXTERNAL:Buffer.from('secret')};let sequence=0,loseUpload=true,loseMessage=true,origin='';
 const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;captures.push(JSON.parse(raw));res.end(JSON.stringify({choices:[{message:{content:'Read'},finish_reason:'stop'}]}));});
 const slack=createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer xoxb-'+'b'.repeat(24));if(req.url!.startsWith('/download/')){const id=req.url!.split('/').at(-1)!;downloads.push(id);res.end(bytes[id]);return;}let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);
  if(req.url==='/api/files.info'){res.end(JSON.stringify({ok:true,file:{id:body.file,name:`${body.file}.dat`,size:body.file==='FLARGE'?1:bytes[body.file].length,mode:body.file==='FEXTERNAL'?'external':'hosted',is_external:body.file==='FEXTERNAL',url_private:`${origin}/download/${body.file}`}}));return;}
  sent.push(body);res.end(JSON.stringify({ok:true,channel:body.channel,ts:`1700000002.${String(sent.length).padStart(6,'0')}`}));});
 await Promise.all([new Promise<void>(r=>provider.listen(0,'127.0.0.1',r)),new Promise<void>(r=>slack.listen(0,'127.0.0.1',r))]);const pa=provider.address(),sa=slack.address();assert(pa&&typeof pa!=='string'&&sa&&typeof sa!=='string');origin=`http://127.0.0.1:${sa.port}`;
 const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${pa.port}/v1`,scriptDirectory:join(root,'scripts')});let db=new DatabaseSync(join(root,'slack.sqlite'));const remote=slackApi('xoxb-'+'b'.repeat(24),'xapp-'+'a'.repeat(24),origin),actual=localScript(join(root,'scripts'));
 const local=async(path:string,body?:unknown,signal?:AbortSignal,name?:string)=>{const value=await actual(path,body,signal,name);if(name){uploads.push({path,name,bytes:Buffer.from(body as Uint8Array).toString('hex')});if(loseUpload){loseUpload=false;throw new Error('Lost upload');}}else if(body&&path.endsWith('/turns')&&loseMessage){loseMessage=false;throw new Error('Lost message');}return value;};
 async function ui(path:string,body?:unknown):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await res.json();assert(res.ok,JSON.stringify(value));return value;}
 function incoming(files:string[],text='Read files',sender='UUSER'){sequence++;const event={type:'events_api',envelope_id:`e${sequence}`,payload:{type:'event_callback',team_id:'TTEAM',api_app_id:'AAPP',event_id:`Ev${sequence}`,authorizations:[{team_id:'TTEAM',user_id:'UBOT',is_bot:true}],event:{type:'message',subtype:'file_share',bot_id:null,channel_type:'im',channel:'DCHAT',user:sender,text,ts:`1700000000.${String(sequence).padStart(6,'0')}`,files:files.map(id=>({id}))}}};recordSlackEnvelope(db,event,users);return db.prepare('SELECT * FROM slack_inbox WHERE event=?').get(`Ev${sequence}`);}
 async function settle(turn:unknown){for(let i=0;i<200;i++){await slackAgentStep(db,users,local,remote);if(db.prepare('SELECT status FROM slack_inbox WHERE turn=?').get(String(turn))?.status==='done')return;await new Promise(r=>setTimeout(r,10));}assert.fail('Task did not settle');}
 try{
  await ui('/api/agents',{id:agent,name:'Files',model:'fixture',instructions:'Help'});await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true});initializeSlack(db);bindSlack(db,'TTEAM','AAPP','UBOT',agent);
  assert.equal(incoming(['FTEXT'],'ignored','UOTHER'),undefined);const row=incoming(['FTEXT'])!;await assert.rejects(slackAgentStep(db,users,local,remote),/Lost upload/);bytes.FTEXT=Buffer.from('Changed remote');db.close();db=new DatabaseSync(join(root,'slack.sqlite'));initializeSlack(db);await assert.rejects(slackAgentStep(db,users,local,remote),/Lost message/);await settle(row.turn);
  assert.equal(downloads.filter(id=>id==='FTEXT').length,1);assert.deepEqual(uploads[0],uploads[1]);assert.equal(captures.length,1);assert(JSON.stringify(captures[0]).includes('Exact Slack file content'));assert.equal((await ui(`/api/threads/${row.thread}/files`)).length,1);assert.deepEqual(await ui(`/api/agents/${agent}/turns`),[]);
  const image=incoming(['FIMAGE'],'')!;await settle(image.turn);assert(JSON.stringify(captures.at(-1)).includes(png.toString('base64')));
  for(const ids of [['FBINARY'],['FLARGE'],['FEXTERNAL'],['FTEXT','FTEXT'],Array.from({length:5},(_,i)=>`FFILE${i}`)]){const before:number=captures.length;const bad=incoming(ids)!;await settle(bad.turn);assert.equal(captures.length,before);assert(sent.at(-1).text.includes('Lampiran'));}
  assert(!downloads.includes('FEXTERNAL'));
  const command=incoming(['FTEXT'],'!status')!;await settle(command.turn);assert.equal(captures.length,3);assert(JSON.stringify(captures.at(-1)).includes('!status'));
  const workflow=await ui(`/api/agents/${agent}/workflows`,{id:randomUUID(),revision:0,name:'Wait',graph:{entry:'ask',maxSteps:2,nodes:[{id:'ask',kind:'approval',prompt:'Proceed?',yes:'out'},{id:'out',kind:'output'}]}});const run=randomUUID();await actual(`/api/scripts/agents/${agent}/workflows/${workflow.id}/run`,{id:run,revision:1,input:'Wait'});
  const stopCaption=incoming(['FTEXT'],`!stop ${run}`)!;db.prepare('INSERT INTO slack_workflows VALUES (?,?,?,?,?)').run(run,stopCaption.channel,stopCaption.sender,stopCaption.root,workflow.id);await settle(stopCaption.turn);assert.equal((await ui(`/api/workflow-runs/${run}`)).status,'approval');assert.equal(captures.length,4);assert(JSON.stringify(captures.at(-1)).includes(`!stop ${run}`));
  const revoked=incoming(['FTEXT'])!;await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:1,enabled:false});const before=downloads.length;await assert.rejects(slackAgentStep(db,users,local,remote));assert.equal(downloads.length,before);assert.equal(captures.length,4);
  await assert.rejects(remote('downloadFile',{url:'http://localhost:1234/private'}));await assert.rejects(remote('downloadFile',{url:'https://files.slack.com.example.com/private'}));assert(revoked);
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:2,enabled:true});await settle(revoked.turn);
  const originalPdf=Buffer.concat([pdfFixture('SLACK_PDF_TEXT'),Buffer.alloc(5*1024*1024,32)]);bytes.FPDF=originalPdf;loseUpload=true;loseMessage=true;
  const pdf=incoming(['FPDF'])!;await assert.rejects(slackAgentStep(db,users,local,remote),/Lost upload/);bytes.FPDF=pdfFixture('CHANGED_PDF');db.close();db=new DatabaseSync(join(root,'slack.sqlite'));initializeSlack(db);
  await assert.rejects(slackAgentStep(db,users,local,remote),/Lost message/);await settle(pdf.turn);assert(JSON.stringify(captures.at(-1)).includes('SLACK_PDF_TEXT'));assert.equal(downloads.filter(id=>id==='FPDF').length,1);
  const pdfFile=db.prepare('SELECT upload FROM slack_media WHERE turn=?').get(pdf.turn)!;const downloaded=await fetch(`${app.origin}/api/threads/${pdf.thread}/files/${pdfFile.upload}`);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),originalPdf);
  const count=captures.length;bytes.FBADPDF=Buffer.from('%PDF-malformed');bytes.FBIGPDF=pdfFixture('X'.repeat(500),70);
  bytes.FHUGE=Buffer.alloc(10*1024*1024+1);bytes.FLARGEIMAGE=Buffer.concat([png,Buffer.alloc(4*1024*1024)]);
  for(const file of ['FBADPDF','FBIGPDF','FHUGE','FLARGEIMAGE']){const row=incoming([file])!;await settle(row.turn);}assert.equal(captures.length,count);
  bytes.FHALF1=pdfFixture('X'.repeat(500),34);bytes.FHALF2=pdfFixture('Y'.repeat(500),34);await settle(incoming(['FHALF1','FHALF2'])!.turn);assert.equal(captures.length,count);
  const afterFailure=incoming(['FPDF'])!;await settle(afterFailure.turn);assert.equal(captures.length,count+1);assert(JSON.stringify(captures.at(-1)).includes('CHANGED_PDF'));
 }finally{db.close();await app.close();provider.closeAllConnections();slack.closeAllConnections();await Promise.all([new Promise<void>(r=>provider.close(()=>r())),new Promise<void>(r=>slack.close(()=>r()))]);rmSync(root,{recursive:true,force:true});}
});

test('Slack download refuses redirects before sending credentials to another endpoint',async()=>{
 let requests=0;const server=createServer((req,res)=>{requests++;res.writeHead(302,{Location:'/should-not-receive-token'});res.end();});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
 try{const remote=slackApi('xoxb-'+'b'.repeat(24),'xapp-'+'a'.repeat(24),origin);await assert.rejects(remote('downloadFile',{url:origin+'/redirect'}));assert.equal(requests,1);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
