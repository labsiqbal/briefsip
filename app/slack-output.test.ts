import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startApp} from './server.ts';
import {slackApi,initializeSlack,bindSlack,recordSlackEnvelope,recoverSlackReply} from './slack.ts';
import {slackAgentStep} from './slack-runner.ts';
import {localScript} from './script-client.ts';

test('Slack artifacts retain exact bytes and upload stages across uncertain completion and grant recovery',async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-slack-output-')),agent=randomUUID(),users=new Set(['UUSER']),text='<h1>Exact Slack output</h1>\n';let calls=0,lost=true,sequence=0,question=false,origin='';const completed:any[]=[],uploaded:Buffer[]=[],allocated:any[]=[],messages:any[]=[];
 const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const data=JSON.parse(raw);calls++;const tools=data.messages.flatMap((m:any)=>m.tool_calls??[]);let call:any;
  if(!tools.length)call={name:'create_text_file',arguments:JSON.stringify({name:'result.html',text})};else if(question&&!tools.some((c:any)=>c.function.name==='ask_user'))call={name:'ask_user',arguments:JSON.stringify({question:'Continue?',choices:['Yes','No']})};res.end(JSON.stringify({choices:[{finish_reason:call?'tool_calls':'stop',message:call?{tool_calls:[{id:call.name,type:'function',function:call}]}:{content:'File ready'}}]}));});
 const slack=createServer(async(req,res)=>{const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));const raw=Buffer.concat(parts);
  if(req.url!.startsWith('/upload/')){assert.equal(req.headers.authorization,undefined);uploaded.push(raw);res.end('OK');return;}
  assert.equal(req.headers.authorization,'Bearer xoxb-'+'b'.repeat(24));const body=JSON.parse(raw.toString());let result:any;
  if(req.url==='/api/files.getUploadURLExternal'){allocated.push(body);result={file_id:`FFILE${allocated.length}`,upload_url:origin+`/upload/${allocated.length}`};}
  else if(req.url==='/api/files.completeUploadExternal'){completed.push(body);if(lost){lost=false;req.socket.destroy();return;}result={files:body.files};}
  else{messages.push(body);result={channel:body.channel,ts:`1700000002.${String(messages.length).padStart(6,'0')}`};}res.end(JSON.stringify({ok:true,...result}));});
 await Promise.all([new Promise<void>(r=>provider.listen(0,'127.0.0.1',r)),new Promise<void>(r=>slack.listen(0,'127.0.0.1',r))]);const pa=provider.address(),sa=slack.address();assert(pa&&typeof pa!=='string'&&sa&&typeof sa!=='string');origin=`http://127.0.0.1:${sa.port}`;
 const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${pa.port}/v1`,scriptDirectory:join(root,'scripts')});let db=new DatabaseSync(join(root,'slack.sqlite'));const local=localScript(join(root,'scripts')),remote=slackApi('xoxb-'+'b'.repeat(24),'xapp-'+'a'.repeat(24),origin);
 async function ui(path:string,body?:unknown):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await res.json();assert(res.ok,JSON.stringify(result));return result;}
 function incoming(){sequence++;recordSlackEnvelope(db,{type:'events_api',envelope_id:`e${sequence}`,payload:{type:'event_callback',team_id:'TTEAM',api_app_id:'AAPP',event_id:`Ev${sequence}`,authorizations:[{team_id:'TTEAM',user_id:'UBOT',is_bot:true}],event:{type:'message',channel_type:'im',channel:'DCHAT',user:'UUSER',text:'Create file',ts:`1700000000.${String(sequence).padStart(6,'0')}`}}},users);return db.prepare('SELECT * FROM slack_inbox WHERE event=?').get(`Ev${sequence}`)!;}
 async function until(check:()=>boolean){for(let i=0;i<200;i++){await slackAgentStep(db,users,local,remote);if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Not settled');}
 try{
  await ui('/api/agents',{runtime:'api', id:agent,name:'Output',model:'fixture',instructions:'Help'});await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true});initializeSlack(db);bindSlack(db,'TTEAM','AAPP','UBOT',agent);
  const first=incoming();await until(()=>db.prepare('SELECT status FROM slack_inbox WHERE turn=?').get(first.turn)!.status==='done');const document=db.prepare('SELECT * FROM slack_documents WHERE turn=?').get(first.turn)!;assert.equal(document.stage,2);assert.equal(db.prepare('SELECT status FROM slack_outbox WHERE id=?').get(document.id)!.status,'uncertain');assert.equal(calls,2);assert.equal(allocated.length,1);assert.equal(uploaded.length,1);assert.deepEqual(uploaded[0],Buffer.from(text));assert.deepEqual(allocated[0],{filename:'result.html',length:Buffer.byteLength(text)});assert.equal(completed[0].channel_id,'DCHAT');assert.equal(completed[0].thread_ts,first.root);
  db.close();db=new DatabaseSync(join(root,'slack.sqlite'));initializeSlack(db);await slackAgentStep(db,users,local,remote);assert.equal(completed.length,1);recoverSlackReply(db,String(document.id),0,'retry');await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:1,enabled:false});await assert.rejects(slackAgentStep(db,users,local,remote));assert.equal(completed.length,1);await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:2,enabled:true});await slackAgentStep(db,users,local,remote);assert.deepEqual(completed[0],completed[1]);assert.equal(uploaded.length,1);assert.equal(allocated.length,1);assert.equal(db.prepare('SELECT status FROM slack_outbox WHERE id=?').get(document.id)!.status,'sent');
  question=true;const partial=incoming();await until(()=>!!db.prepare('SELECT 1 FROM slack_questions WHERE turn=?').get(partial.turn));await ui(`/api/threads/${partial.thread}/turns/${partial.turn}/cancel`,{id:randomUUID()});await until(()=>db.prepare('SELECT status FROM slack_inbox WHERE turn=?').get(partial.turn)!.status==='done');assert(completed.at(-1).initial_comment.includes('Partial result'));assert.deepEqual(uploaded.at(-1),Buffer.from(text));assert.deepEqual(await ui(`/api/agents/${agent}/turns`),[]);
  const part=db.prepare('SELECT * FROM slack_documents WHERE turn=?').get(partial.turn)!;db.prepare("UPDATE slack_outbox SET status='queued' WHERE id=?").run(part.id);const count=completed.length;
  await slackAgentStep(db,users,async(path,body,signal)=>{if(path.includes(`files/${part.file}?metadata`)){const {LocalAgentError}=await import('./script-client.ts');throw new LocalAgentError(404);}return local(path,body,signal);},remote);assert.equal(completed.length,count);assert.equal(db.prepare('SELECT status FROM slack_outbox WHERE id=?').get(part.id)!.status,'revoked');
 }finally{db.close();await app.close();provider.closeAllConnections();slack.closeAllConnections();await Promise.all([new Promise<void>(r=>provider.close(()=>r())),new Promise<void>(r=>slack.close(()=>r()))]);rmSync(root,{recursive:true,force:true});}
});

for(const failure of ['allocate','upload'])test(`Slack file ${failure} lost response requires explicit retry`,async()=>{
 const {deliverSlackFile}=await import('./slack-output.ts');const root=mkdtempSync(join(tmpdir(),'briefsip-slack-stage-')),file=join(root,'state.sqlite'),id=randomUUID();let db=new DatabaseSync(file),lost=true,origin='';const calls:string[]=[],raws:Buffer[]=[];
 const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const part of req)chunks.push(Buffer.from(part));const raw=Buffer.concat(chunks),stage=req.url==='/upload'?'upload':req.url?.endsWith('getUploadURLExternal')?'allocate':'complete';calls.push(stage);
  if(stage==='upload'){assert.equal(req.headers.authorization,undefined);raws.push(raw);}
  if(lost&&stage===failure){lost=false;req.socket.destroy();return;}
  res.end(stage==='upload'?'OK':JSON.stringify({ok:true,...(stage==='allocate'?{file_id:'FFILE',upload_url:origin+'/upload'}:{files:[{id:'FFILE'}]})}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address!=='string');origin=`http://127.0.0.1:${address.port}`;
 try{
  initializeSlack(db);db.prepare('INSERT INTO slack_documents(id,turn,thread,file,name,bytes) VALUES (?,?,?,?,?,?)').run(id,randomUUID(),randomUUID(),randomUUID(),'file.txt',Buffer.from('exact'));
  db.prepare('INSERT INTO slack_outbox(id,channel,sender,root,text) VALUES (?,?,?,?,?)').run(id,'DCHAT','UUSER','1700000000.000001','File');const remote=slackApi('xoxb-'+'b'.repeat(24),'xapp-'+'a'.repeat(24),origin);
  await deliverSlackFile(db,id,remote,async()=>{});assert.equal(db.prepare('SELECT status FROM slack_outbox').get()!.status,'uncertain');assert.equal(db.prepare('SELECT stage FROM slack_documents').get()!.stage,failure==='allocate'?0:1);const count=calls.length;
  db.close();db=new DatabaseSync(file);initializeSlack(db);await deliverSlackFile(db,id,remote,async()=>{});assert.equal(calls.length,count);recoverSlackReply(db,id,0,'retry');await deliverSlackFile(db,id,remote,async()=>{});assert.equal(db.prepare('SELECT status FROM slack_outbox').get()!.status,'sent');assert.equal(db.prepare('SELECT stage FROM slack_documents').get()!.stage,3);assert.equal(calls.filter(c=>c==='allocate').length,failure==='allocate'?2:1);assert(raws.every(bytes=>bytes.equals(Buffer.from('exact'))));
  const before=calls.length;await assert.rejects(remote('uploadFile',{url:'https://files.slack.com.example.com/upload',bytes:Buffer.from('private')}));assert.equal(calls.length,before);
 }finally{db.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});
