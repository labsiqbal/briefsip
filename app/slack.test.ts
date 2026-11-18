import { connectorApp, slackEnvelope, waitFor } from './test-support/rust-connector-fixture.ts';
import { runRustConnector } from './rust-connectors-runner.ts';
import { connectorJournalCommand, openConnectorJournalFixture } from './test-support/connector-journal-command.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startApp} from './test-bridge.ts';

const envelope=(n:number,text='Hello',user='UUSER',root?:string)=>({type:'events_api',envelope_id:`envelope-${n}`,payload:{type:'event_callback',team_id:'TTEAM',api_app_id:'AAPP',event_id:`Ev${n}`,authorizations:[{team_id:'TTEAM',user_id:'UBOT',is_bot:true}],event:{type:'message',channel_type:'im',channel:'DCHAT',user,text,ts:`1700000000.${String(n).padStart(6,'0')}`,...(root?{thread_ts:root}:{})}}});



for(const useButtons of [false,true])test(`Slack actual agent API retries one task and isolates requester question answers (buttons=${useButtons})`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-slack-bridge-')),agent=randomUUID();
 let calls=0,sequence=0;
 const yes=useButtons?'Yes '.repeat(45).trim():'Yes';
 const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const data=JSON.parse(raw);calls++;const answered=data.messages.some((m:any)=>m.role==='tool');res.end(JSON.stringify({choices:[{finish_reason:answered?'stop':'tool_calls',message:answered?{content:'Confirmed'}:{tool_calls:[{id:'question',type:'function',function:{name:'ask_user',arguments:JSON.stringify({question:'Proceed?',choices:[yes,'No']})}}]}}]}));});
 await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const address=provider.address();assert(address&&typeof address!=='string');
 const f=await connectorApp('slack',root,agent,{baseURL:`http://127.0.0.1:${address.port}/v1`});
 const {connector,ui}=f;
 const db=openConnectorJournalFixture('slack',connector.directory);
 const posted=()=>connector.jsonPosts<any>('chat.postMessage');
 const requests=(suffix:string)=>connector.requests.filter(req=>req.method==='POST'&&req.path.endsWith(suffix));
 const until=<T>(check:()=>T)=>waitFor(()=>{connector.check();return check();},'Slack question did not settle');
 const delivered=(id:unknown)=>until(()=>db.prepare("SELECT * FROM slack_outbox WHERE id=? AND status='sent'").get(String(id)));
 async function incoming(text:string,sender='UUSER',root?:string,channel='DCHAT'){
  const id=++sequence;await connector.send(slackEnvelope(id,text,sender,root,channel));
  return db.prepare('SELECT * FROM slack_inbox WHERE event=?').get(`Ev${id}`)!;
 }
 const fault=(suffix:string)=>connector.faults.push({method:'POST',path:new RegExp(`/${suffix}$`),after:true});
 async function restart(){await connector.expectedFailure(/Local agent request failed/);connector.start();}
 try{
  fault('turns');connector.start();
  const original=await incoming('Hello');await restart();
  const q=await until(()=>db.prepare('SELECT * FROM slack_questions WHERE turn=?').get(original.turn));
  const notice=await delivered(q.id);
  assert.equal(requests('/turns').length,2);
  assert.deepEqual(requests('/turns')[0],requests('/turns')[1]);assert.equal(calls,1);
  const foreign=await incoming(`!answer ${q.id} Yes`,'UOTHER',String(q.root),'DOTHER');
  await delivered(foreign.turn);assert.equal(requests('/answer').length,0);

  if(useButtons){
   const ts=JSON.parse(String(notice.timestamps)).at(-1),buttons=posted().find(p=>p.blocks).blocks.at(-1).elements;
   assert.equal(buttons.length,2);
   assert.equal(buttons[0].text.text,`1. ${Array.from(yes).slice(0,45).join('')}...`);
   assert(posted().some(p=>p.text.includes(yes)));
   const click=(index=0)=>({type:'interactive',envelope_id:`question-button-${++sequence}`,payload:{type:'block_actions',team:{id:'TTEAM'},api_app_id:'AAPP',user:{id:'UUSER'},channel:{id:'DCHAT'},container:{channel_id:'DCHAT',message_ts:ts},message:{user:'UBOT',ts},actions:[{type:'button',action_id:buttons[index].action_id,value:buttons[index].value}]}});
   const edits: ((p:ReturnType<typeof click>['payload']) => void)[] = [
    p=>p.user.id='UOTHER',
    p=>p.message.ts='1700000099.000001',
    p=>p.actions[0]={type:'button',action_id:'briefsip_answer_7',value:`question:${q.id}:7`},
    p=>p.actions[0]={type:'button',action_id:'briefsip_approve_yes',value:`approval:${q.id}:yes`},
   ];
   for(const edit of edits){
    const bad=click();edit(bad.payload);await connector.send(bad);
    assert.equal(db.prepare('SELECT count(*) AS n FROM slack_question_callbacks').get()!.n,0);
   }
   db.prepare("UPDATE slack_outbox SET status='sending' WHERE id=?").run(q.id);
   const early=click();await connector.push(early);
   await connector.send({type:'probe',envelope_id:'question-barrier'});
   assert(!connector.acks.includes(early.envelope_id));
   db.prepare("UPDATE slack_outbox SET status='sent' WHERE id=?").run(q.id);
   await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:1,enabled:false});
   await connector.send(click());
   await connector.expectedFailure(/403/);
   assert.equal(db.prepare('SELECT status FROM slack_question_callbacks').get()!.status,'queued');
   assert.equal(db.prepare('SELECT answer FROM slack_question_callbacks').get()!.answer,yes);
   assert.equal(calls,1);
   await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:2,enabled:true});
   fault('answer');connector.start();await restart();await connector.send(click(1));
   assert.equal(db.prepare('SELECT answer FROM slack_question_callbacks').get()!.answer,yes);
  }else{
   fault('answer');
   const pending=await incoming(`!answer ${q.id} Yes`,'UUSER',String(q.root));
   await connector.expectedFailure(/Local agent request failed/);
   const stop=slackEnvelope(++sequence,`!stop ${pending.turn}`,'UUSER',String(q.root));
   db.prepare("INSERT INTO slack_inbox(event,channel,sender,ts,root,text,thread,turn) VALUES(?,?,'UUSER',?,?,?,?,?)").run(stop.payload.event_id,'DCHAT',stop.payload.event.ts,q.root,stop.payload.event.text,q.thread,randomUUID());
   connector.start();
  }
  await delivered(original.turn);assert(posted().some(p=>p.text==='Confirmed'));
  const answers=connector.successful.filter(req=>req.method==='POST'&&req.path.endsWith('/answer'));
  assert.equal(answers.length,2);assert.deepEqual(answers[0],answers[1]);
  assert.equal(calls,2);assert.deepEqual(await ui(`/api/agents/${agent}/turns`),[]);
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:useButtons?3:1,enabled:false});
  await incoming('No longer authorized');await connector.expectedFailure(/403/);assert.equal(calls,2);
 }finally{db.close();await f.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});

// Minimal fixture framing; production uses Node's native WebSocket implementation.
function frame(value:unknown){const bytes=Buffer.from(JSON.stringify(value)),head=bytes.length<126?Buffer.from([0x81,bytes.length]):Buffer.from([0x81,126,bytes.length>>8,bytes.length&255]);return Buffer.concat([head,bytes]);}
test('Slack Socket Mode runner acknowledges journaled event and delivers once after reconnect',async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-slack-run-')),agent=randomUUID(),controller=new AbortController(),sockets=new Set<any>();let providerCalls=0,connections=0,acks=0,delivered=0;const limited=new Map<string,number>();const authHeaders:string[]=[];const finish=()=>{if(delivered&&acks>=2)setTimeout(()=>controller.abort(),20);};
 const provider=createServer(async(req,res)=>{for await(const _ of req){}providerCalls++;res.end(JSON.stringify({choices:[{message:{content:'Socket reply'},finish_reason:'stop'}]}));});
 const slack=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);authHeaders.push(String(req.headers.authorization));let result:any;
  if(['/api/auth.test','/api/apps.connections.open'].includes(req.url!)){const prior=limited.get(req.url!);if(prior===undefined){limited.set(req.url!,Date.now());res.writeHead(429,{'Retry-After':'1'});res.end('Wait');return;}assert(Date.now()-prior>=1000);}
  if(req.url?.endsWith('/auth.test'))result={team_id:'TTEAM',user_id:'UBOT',bot_id:'BBOT'};
  else if(req.url?.endsWith('/apps.connections.open')){const a=slack.address();assert(a&&typeof a!=='string');result={url:`ws://127.0.0.1:${a.port}/socket`};}
  else{delivered++;assert.equal(body.thread_ts,'1700000000.000001');assert.equal(body.channel,'DCHAT');assert.equal(body.text,'Socket reply');result={channel:'DCHAT',ts:'1700000001.000001'};finish();}res.end(JSON.stringify({ok:true,...result}));});
 slack.on('upgrade',(req,socket)=>{connections++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));const accept=createHash('sha1').update(String(req.headers['sec-websocket-key'])+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);socket.write(frame({type:'hello',connection_info:{app_id:'AAPP'}}));socket.write(frame(envelope(1)));let pending=Buffer.alloc(0);
  socket.on('data',chunk=>{pending=Buffer.concat([pending,chunk]);while(pending.length>=6){const code=pending[0]&15,size=pending[1]&127;if(size>=126)return;if(pending.length<6+size)return;const mask=pending.subarray(2,6),body=Buffer.from(pending.subarray(6,6+size));pending=pending.subarray(6+size);for(let i=0;i<body.length;i++)body[i]^=mask[i%4];if(code===8){socket.end(Buffer.from([0x88,0]));continue;}if(code!==1)continue;const ack=JSON.parse(body.toString());assert.equal(ack.envelope_id,'envelope-1');const journal=new DatabaseSync(join(root,'state','slack.sqlite'));try{assert.equal(journal.prepare('SELECT count(*) AS n FROM slack_inbox').get()!.n,1);}finally{journal.close();}acks++;finish();if(connections===1)socket.write(frame({type:'disconnect',reason:'refresh_requested'}));}});
 });
 await Promise.all([new Promise<void>(r=>provider.listen(0,'127.0.0.1',r)),new Promise<void>(r=>slack.listen(0,'127.0.0.1',r))]);const pa=provider.address(),sa=slack.address();assert(pa&&typeof pa!=='string'&&sa&&typeof sa!=='string');const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${pa.port}/v1`,scriptDirectory:join(root,'scripts')}, { directory: root, servers: [provider, slack] });const timeout=setTimeout(()=>controller.abort(),10000);
 try{for(const [path,body]of [['/api/agents',{runtime:'api', id:agent,name:'Socket',model:'fixture',instructions:'Help'}],[`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true}]]as const){const res=await fetch(app.origin+path,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});assert(res.ok);await res.json();}
  await runRustConnector('slack',{directory:join(root,'state'),scriptDirectory:join(root,'scripts'),agent,team:'TTEAM',app:'AAPP',botToken:'xoxb-'+'b'.repeat(24),appToken:'xapp-'+'a'.repeat(24),users:['UUSER'],origin:`http://127.0.0.1:${sa.port}`},controller.signal);assert.equal(providerCalls,1);assert.equal(delivered,1);assert(connections>=2);assert(acks>=2);assert(!existsSync(join(root,'state','owner.lock')));assert(authHeaders.some(h=>h.startsWith('Bearer xapp-')));assert(authHeaders.some(h=>h.startsWith('Bearer xoxb-')));
 }finally{clearTimeout(timeout);controller.abort();for(const socket of sockets)socket.destroy();await app.close();provider.closeAllConnections();slack.closeAllConnections();await Promise.all([new Promise<void>(r=>provider.close(()=>r())),new Promise<void>(r=>slack.close(()=>r()))]);rmSync(root,{recursive:true,force:true});}
});

test('Slack status and stop scope to requester root and preserve cancellation identity after lost responses',async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-slack-controls-')),agent=randomUUID();
 let sequence=0,calls=0;
 const provider=createServer(async(req,res)=>{for await(const _ of req){}calls++;res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'ask',type:'function',function:{name:'ask_user',arguments:JSON.stringify({question:'Wait',choices:['Yes','No']})}}]}}]}));});
 await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const address=provider.address();assert(address&&typeof address!=='string');
 const f=await connectorApp('slack',root,agent,{baseURL:`http://127.0.0.1:${address.port}/v1`});
 const {connector,ui}=f;
 const db=openConnectorJournalFixture('slack',connector.directory);
 const posts=()=>connector.jsonPosts<any>('chat.postMessage');
 const requests=(suffix:string)=>connector.requests.filter(req=>req.method==='POST'&&req.path.endsWith(suffix));
 const status=(id:unknown)=>db.prepare('SELECT status FROM slack_inbox WHERE turn=?').get(String(id))?.status;
 const until=(id:unknown)=>waitFor(()=>{connector.check();return db.prepare("SELECT 1 FROM slack_outbox WHERE id=? AND status='sent'").get(String(id));},'Slack command did not settle');
 const row=(n:number)=>db.prepare('SELECT * FROM slack_inbox WHERE event=?').get(`Ev${n}`)!;
 const insert=db.prepare("INSERT INTO slack_inbox(event,channel,sender,ts,root,text,thread,turn) VALUES(?,?,?,?,?,?,?,?)");
 function seed(text:string,parent?:string,thread:string=randomUUID()){
  const id=++sequence,sample=slackEnvelope(id,text);
  insert.run(sample.payload.event_id,'DCHAT','UUSER',sample.payload.event.ts,parent??sample.payload.event.ts,text,thread,randomUUID());
  return row(id);
 }
 async function incoming(text:string,parent?:string,user='UUSER',channel='DCHAT'){
  const id=++sequence;await connector.send(slackEnvelope(id,text,user,parent,channel));return row(id);
 }
 const fault=(suffix:string,after=true)=>connector.faults.push({method:'POST',path:new RegExp(`/${suffix}$`),after});
 try{
  const unsent=seed('Never execute'),stop=seed(`!stop ${unsent.turn}`,String(unsent.root),String(unsent.thread));
  connector.start();await until(stop.turn);
  assert.equal(calls,0);assert.equal(requests('/turns').length,0);assert.equal(status(unsent.turn),'cancelled');

  fault('turns');const active=await incoming('!ANSWER ordinary task');
  await connector.expectedFailure(/Local agent request failed/);
  assert.equal(status(active.turn),'submitting');
  db.prepare("UPDATE slack_inbox SET status='queued' WHERE event=?").run(active.event);db.exec('PRAGMA user_version=0');
  assert.equal(connectorJournalCommand('slack',connector.directory)('status').status,0);
  assert.equal(status(active.turn),'submitting');
  connector.start();
  await until((await incoming(`!stop ${active.turn}`)).turn);
  await until((await incoming(`!stop ${active.turn}`,String(active.root),'UOTHER','DOTHER')).turn);
  await until((await incoming('!status',String(active.root))).turn);
  assert.equal(requests('/cancel').length,0);
  assert(posts().some(post=>post.text.includes(String(active.turn))&&post.text.includes('!stop')));
  fault('cancel');
  const cancellation=await incoming(`!stop ${active.turn}`,String(active.root));
  await connector.expectedFailure(/Local agent request failed/);
  connector.start();await until(cancellation.turn);
  const cancellations=requests('/cancel');
  assert.equal(cancellations.length,2);assert.deepEqual(cancellations[0],cancellations[1]);
  assert.equal(JSON.parse(cancellations[0].bytes.toString()).id,cancellation.turn);
  assert.equal((await ui(`/api/threads/${active.thread}/turns`))[0].status,'cancelled');

  fault('turns',false);
  const before=await incoming('Do not create');
  await connector.expectedFailure(/Local agent request failed/);
  const priorCalls=calls,unavailable=seed(`!stop ${before.turn}`,String(before.root),String(before.thread));
  connector.start();await until(unavailable.turn);
  assert.equal(status(before.turn),'unavailable');assert.equal(calls,priorCalls);
  assert.deepEqual(await ui(`/api/threads/${before.thread}/turns`),[]);
  await until((await incoming('!status',String(before.root))).turn);
  assert(posts().some(post=>post.text==='No active tasks in this thread.'));
 }finally{db.close();await f.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});

test('Slack offline recovery pins revisions, retains confirmed chunks and requires explicit CLI confirmation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-slack-recovery-')),id=randomUUID(),agent=randomUUID();
 let mode='lost',calls=0;
 const fixture=await connectorApp('slack',root,agent,{remote:(_method,raw,req,res)=>{
  calls++;const body=JSON.parse(raw.toString());
  if(mode==='rejected'){res.end(JSON.stringify({ok:false,error:'channel_not_found'}));return;}
  if(calls>1){assert.equal(body.text,'x'.repeat(1000));if(mode==='lost'){req.socket.destroy();return;}}
  return {channel:'DCHAT',ts:`1700000001.${String(calls).padStart(6,'0')}`};
 }});
 const {connector,ui}=fixture;
 const cli=connectorJournalCommand('slack',connector.directory);
 const db=openConnectorJournalFixture('slack',connector.directory);
 const add=(id:string,text:string)=>db.prepare('INSERT INTO slack_outbox(id,channel,sender,root,text) VALUES (?,?,?,?,?)').run(id,'DCHAT','UUSER','1700000000.000001',text);
 const read=()=>JSON.parse(cli('inspect',id).stdout);
 const until=async(id:string,status:string)=>{await waitFor(()=>{connector.check();return db.prepare('SELECT status FROM slack_outbox WHERE id=?').get(id)?.status===status;},`Reply did not become ${status}`);};
 try{
  add(id,'x'.repeat(5000));
  connector.start();await until(id,'uncertain');await connector.stop();assert.equal(calls,2);
  let inspected=read();assert.equal(inspected.reply.status,'uncertain');assert.equal(inspected.reply.part,1);assert.equal(inspected.revision,0);
  assert.notEqual(cli('recover',id,'0','retry').status,0);assert.equal(cli('recover',id,'0','retry','--accept-duplicate-risk').status,0);
  connector.start();await until(id,'uncertain');await connector.stop();assert.equal(calls,3);
  assert.notEqual(cli('recover',id,'0','retry','--accept-duplicate-risk').status,0);
  inspected=read();assert.equal(inspected.reply.part,1);assert.equal(JSON.parse(inspected.reply.timestamps).length,1);assert.equal(inspected.revision,1);
  assert.equal(cli('recover',id,'1','retry','--accept-duplicate-risk').status,0);
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:1,enabled:false});
  connector.start();await connector.expectedFailure(/403/);assert.equal(calls,3);
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:2,enabled:true});
  mode='ok';connector.start();await until(id,'sent');await connector.stop();assert.equal(calls,4);
  db.prepare("UPDATE slack_outbox SET status='sending' WHERE id=?").run(id);
  inspected=read();assert.equal(inspected.reply.status,'uncertain');assert.equal(inspected.revision,2);
  assert.notEqual(cli('recover',id,'2','discard').status,0);assert.equal(cli('recover',id,'2','discard','--confirm').status,0);assert.notEqual(cli('recover',id,'3','retry','--accept-duplicate-risk').status,0);
  inspected=read();assert.equal(inspected.reply.status,'discarded');assert.equal(inspected.decisions.length,3);assert.equal(inspected.reply.part,2);
  const rejected=randomUUID();mode='rejected';add(rejected,'Rejected');
  connector.start();await until(rejected,'failed');await connector.stop();
  inspected=JSON.parse(cli('inspect',rejected).stdout);assert.equal(inspected.reply.status,'failed');assert.equal(inspected.reply.part,0);
  assert.equal(cli('recover',rejected,'0','retry','--accept-duplicate-risk').status,0);
  assert.equal(JSON.parse(cli('inspect',rejected).stdout).reply.status,'queued');
 }finally{db.close();await fixture.close();rmSync(root,{recursive:true,force:true});}
});

test('Slack startup cancellation releases lock and status retains authentication cooldown',async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-slack-start-stop-')),directory=join(root,'state'),controller=new AbortController();let requests=0;
 const server=createServer(async(req,res)=>{for await(const _ of req){}requests++;res.writeHead(429,{'Retry-After':'60'});res.end('Wait');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address!=='string');
 const timeout=setTimeout(()=>controller.abort(),5000);
 try{
  const running=runRustConnector('slack',{directory,scriptDirectory:join(root,'unused'),agent:randomUUID(),team:'TTEAM',app:'AAPP',botToken:'xoxb-'+'b'.repeat(24),appToken:'xapp-'+'a'.repeat(24),users:['UUSER'],origin:`http://127.0.0.1:${address.port}`},controller.signal);
  let recorded=false;for(let i=0;i<100&&!recorded;i++){await new Promise(r=>setTimeout(r,10));if(!existsSync(join(directory,'slack.sqlite')))continue;const db=new DatabaseSync(join(directory,'slack.sqlite'));try{recorded=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='slack_session_cooldowns'").get()&&!!db.prepare("SELECT until FROM slack_session_cooldowns WHERE method='auth.test'").get();}finally{db.close();}}
  assert(recorded);controller.abort();await running;assert.equal(requests,1);assert(!existsSync(join(directory,'owner.lock')));
  const status=connectorJournalCommand('slack',directory)('status');assert.equal(status.status,0,status.stderr);const rows=JSON.parse(status.stdout).sessionCooldowns;assert.equal(rows.length,1);assert.equal(rows[0].method,'auth.test');assert(rows[0].until>Date.now());
 }finally{clearTimeout(timeout);controller.abort();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});

test('Slack interactive Socket Mode withholds early ACK and commits one decision before redelivery ACK',async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-slack-button-socket-')),agent=randomUUID(),notice=randomUUID(),run=randomUUID();
 let release!:()=>void,exposed=false;
 const gate=new Promise<void>(resolve=>release=resolve);
 const fixture=await connectorApp('slack',root,agent,{remote:async(method,raw)=>{
  if(method!=='chat.postMessage')return;
  const body=JSON.parse(raw.toString());
  if(body.blocks){exposed=true;await gate;return {channel:'DCHAT',ts:'1700000001.000001'};}
 }});
 const {connector}=fixture;
 const db=openConnectorJournalFixture('slack',connector.directory);
 const ts='1700000001.000001',rootTs='1700000000.000001';
 const click=(id:string,choice='yes')=>({type:'interactive',envelope_id:id,payload:{type:'block_actions',team:{id:'TTEAM'},api_app_id:'AAPP',user:{id:'UUSER'},channel:{id:'DCHAT'},container:{channel_id:'DCHAT',message_ts:ts},message:{user:'UBOT',ts},actions:[{type:'button',action_id:`briefsip_approve_${choice}`,value:`approval:${notice}:${choice}`}]}});
 const decision=()=>db.prepare('SELECT id,accepted FROM slack_callbacks').get();
 try{
  db.prepare("INSERT INTO slack_workflows VALUES (?,'DCHAT','UUSER',?,?)").run(run,rootTs,randomUUID());
  db.prepare('INSERT INTO slack_approvals VALUES (?,1,?)').run(run,notice);
  db.prepare("INSERT INTO slack_outbox(id,channel,sender,root,text) VALUES (?,'DCHAT','UUSER',?,'Proceed?')").run(notice,rootTs);
  connector.start();
  await waitFor(()=>{connector.check();return exposed;},'Approval send was not exposed');
  await connector.push(click('early'));await connector.send({type:'probe',envelope_id:'barrier'});
  assert(!connector.acks.includes('early'));assert.equal(decision(),undefined);
  release();
  await waitFor(()=>db.prepare("SELECT 1 FROM slack_outbox WHERE id=? AND status='sent'").get(notice),'Approval send did not settle');
  await connector.send(click('retry'));const recorded=decision();assert(recorded);assert.equal(recorded.accepted,1);
  await connector.send(click('retry'));assert.deepEqual(decision(),recorded);
  await connector.send(click('duplicate','no'));assert.deepEqual(decision(),recorded);
 }finally{release();db.close();await fixture.close();rmSync(root,{recursive:true,force:true});}
});

test('Slack shared channels require opt-in mention and retain one scoped multi-user thread',async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-slack-channels-')),agent=randomUUID(),channels=['CROOM','GROOM'];
 let calls=0;const prompts:any[]=[];
 const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;prompts.push(JSON.parse(raw));calls++;res.end(JSON.stringify({choices:[{message:{content:`Reply ${calls}`},finish_reason:'stop'}]}));});
 await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const address=provider.address();assert(address&&typeof address!=='string');
 const f=await connectorApp('slack',root,agent,{baseURL:`http://127.0.0.1:${address.port}/v1`,channels});
 const {connector,ui}=f;
 const db=openConnectorJournalFixture('slack',connector.directory);
 const sent=()=>connector.jsonPosts<any>('chat.postMessage');
 const rows=()=>db.prepare('SELECT * FROM slack_inbox ORDER BY rowid').all();
 const row=(n:number)=>db.prepare('SELECT * FROM slack_inbox WHERE event=?').get(`Ev${n}`)!;
 const incoming=(n:number,text:string,user='UUSER',thread?:string,channel='CROOM',mention=false)=>{
  const event=slackEnvelope(n,text,user,thread,channel);
  if(channel.startsWith('G'))event.payload.event.channel_type='group';
  if(mention){
   event.payload.event.type='app_mention';
   Reflect.deleteProperty(event.payload.event,'channel_type');
  }
  return event;
 };
 async function settle(n:number){
  await waitFor(()=>{connector.check();const change=row(n);return change&&db.prepare("SELECT 1 FROM slack_outbox WHERE id=? AND status='sent'").get(change.turn);},`Slack event ${n} did not settle`);
 }
 try{
  channels.length=0;connector.start();await connector.send(incoming(4,'<@UBOT> disabled'));assert.equal(rows().length,0);
  await connector.stop();channels.push('CROOM','GROOM');connector.start();
  await connector.send(incoming(1,'Ambient'));
  await connector.send(incoming(2,'<@UBOT> foreign','UUSER',undefined,'CFOREIGN'));
  await connector.send(incoming(3,'<@UBOT> disallowed','UNOT'));
  assert.equal(rows().length,0);
  await connector.send(incoming(5,'<@UBOT> First',undefined,undefined,'CROOM',true));
  const alias=incoming(5,'<@UBOT> First');alias.envelope_id='alias-5';alias.payload.event_id='EvAlias';
  await connector.send(alias);assert.equal(rows().length,1);await settle(5);
  const first=row(5);
  await connector.send(incoming(6,'Second','UOTHER',String(first.root)));await settle(6);
  assert.equal(row(6).thread,first.thread);assert.equal(calls,2);
  assert(sent().every(post=>post.channel==='CROOM'&&post.thread_ts===first.root));
  const texts=prompts[1].messages.filter((m:any)=>m.role==='user').map((m:any)=>m.content).join('\n');
  assert(texts.includes('Slack UUSER: First'));assert(texts.includes('Slack UOTHER: Second'));assert.deepEqual(await ui(`/api/agents/${agent}/turns`),[]);
  await connector.send(incoming(7,'<@UBOT> Private','UUSER',undefined,'GROOM',true));await settle(7);
  assert.notEqual(row(7).thread,first.thread);
  const beforeLong=calls;
  await connector.send(incoming(9,'<@UBOT> '+'x'.repeat(15992)));await settle(9);
  assert.equal(calls,beforeLong);assert(sent().at(-1).text.startsWith('Message is too long. Maximum 15987'));
  assert.equal(row(9).text,'x'.repeat(15992));
  await connector.send(incoming(10,'<@UBOT> '+'x'.repeat(15987)));await settle(10);
  assert.equal(calls,beforeLong+1);assert(prompts.at(-1).messages.some((m:any)=>m.role==='user'&&typeof m.content==='string'&&m.content.length===16000));

  await connector.stop();
  db.prepare("INSERT INTO slack_inbox(event,channel,sender,ts,root,text,thread,turn) VALUES('Ev8','CROOM','UUSER','1700000000.000008',?,'Never send',?,?)").run(first.root,first.thread,randomUUID());
  db.prepare("UPDATE slack_outbox SET status='queued' WHERE channel='CROOM'").run();
  channels.length=0;connector.start();
  await waitFor(()=>{connector.check();return row(8).status==='revoked'&&db.prepare("SELECT count(*) AS n FROM slack_outbox WHERE channel='CROOM' AND status='revoked'").get()!.n===4;},'Disabled channel was not revoked');
  assert.equal(calls,4);assert.equal(sent().length,5);
 }finally{db.close();await f.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});
