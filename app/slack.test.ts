import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeSlack,bindSlack,recordSlackEnvelope,finishSlack,deliverSlack,slackApi,SlackError} from './slack.ts';
import {runSlack,slackAgentStep,slackSocket,slackSessionRequest} from './slack-runner.ts';
import {startApp} from './server.ts';
import {localScript} from './script-client.ts';

const envelope=(n:number,text='Hello',user='UUSER',root?:string)=>({type:'events_api',envelope_id:`envelope-${n}`,payload:{type:'event_callback',team_id:'TTEAM',api_app_id:'AAPP',event_id:`Ev${n}`,authorizations:[{team_id:'TTEAM',user_id:'UBOT',is_bot:true}],event:{type:'message',channel_type:'im',channel:'DCHAT',user,text,ts:`1700000000.${String(n).padStart(6,'0')}`,...(root?{thread_ts:root}:{})}}});
const setup=()=>{const db=new DatabaseSync(':memory:');initializeSlack(db);bindSlack(db,'TTEAM','AAPP','UBOT',randomUUID());return db;};

test('Slack persists accepted events before ack, isolates roots and refuses spoof/replay conflicts',()=>{
 const db=setup(),users=new Set(['UUSER']);try{
  assert.equal(recordSlackEnvelope(db,envelope(1),users),'envelope-1');const first=db.prepare('SELECT * FROM slack_inbox').get()!;recordSlackEnvelope(db,envelope(1),users);assert.equal(db.prepare('SELECT count(*) AS n FROM slack_inbox').get()!.n,1);
  recordSlackEnvelope(db,envelope(2,'Continue','UUSER',String(first.root)),users);assert.equal(db.prepare('SELECT thread FROM slack_inbox WHERE event=?').get('Ev2')!.thread,first.thread);recordSlackEnvelope(db,envelope(3),users);assert.notEqual(db.prepare('SELECT thread FROM slack_inbox WHERE event=?').get('Ev3')!.thread,first.thread);
  for(const alter of [(e:any)=>e.payload.team_id='TOTHER',(e:any)=>e.payload.api_app_id='AOTHER',(e:any)=>e.payload.authorizations=[],(e:any)=>e.payload.event.user='UOTHER',(e:any)=>e.payload.event.user='UBOT',(e:any)=>e.payload.event.subtype='message_changed',(e:any)=>e.payload.event.bot_id='BBOT',(e:any)=>e.payload.event.channel_type='channel',(e:any)=>e.payload.event.channel='CCHAN']){const e=envelope(10);alter(e);recordSlackEnvelope(db,e,users);}assert.equal(db.prepare('SELECT count(*) AS n FROM slack_inbox').get()!.n,3);
  assert.throws(()=>recordSlackEnvelope(db,envelope(1,'Changed'),users),/conflict/);assert.throws(()=>bindSlack(db,'TOTHER','AAPP','UBOT',String(db.prepare('SELECT agent FROM slack_binding').get()!.agent)),/mismatch/);
 }finally{db.close();}
});

test('Slack partial send preserves confirmed timestamps and never replays uncertain remainder',async()=>{
 const db=setup(),sent:any[]=[];try{recordSlackEnvelope(db,envelope(1),new Set(['UUSER']));const row=db.prepare('SELECT * FROM slack_inbox').get()!;finishSlack(db,row,'<@UOTHER>'.repeat(700));let grant=true;
  const remote=async(_method:string,body:Record<string,unknown>)=>{sent.push(body);if(sent.length===2)throw new SlackError(false);return {channel:'DCHAT',ts:'1700000001.000001'};};
  const authorize=async()=>{assert(grant);};await deliverSlack(db,String(row.turn),remote,authorize);assert.equal(sent.length,2);assert(sent[0].text.startsWith('&lt;'));assert.equal(sent[0].mrkdwn,false);assert.equal(sent[0].reply_broadcast,false);assert.equal(sent[0].thread_ts,row.root);assert(sent.every(item=>item.text.length<=4000));
  let result=db.prepare('SELECT * FROM slack_outbox').get()!;assert.equal(result.status,'uncertain');assert.equal(result.part,1);assert.equal(JSON.parse(String(result.timestamps)).length,1);initializeSlack(db);await deliverSlack(db,String(row.turn),remote,authorize);assert.equal(sent.length,2);
  db.prepare("UPDATE slack_outbox SET status='queued'").run();grant=false;await assert.rejects(deliverSlack(db,String(row.turn),remote,authorize));assert.equal(sent.length,2);
  db.prepare("UPDATE slack_outbox SET status='sending'").run();initializeSlack(db);result=db.prepare('SELECT status FROM slack_outbox').get()!;assert.equal(result.status,'uncertain');
 }finally{db.close();}
});

for(const useButtons of [false,true])test(`Slack actual agent API retries one task and isolates requester question answers (buttons=${useButtons})`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-slack-bridge-')),agent=randomUUID(),users=new Set(['UUSER','UOTHER']);let db=new DatabaseSync(join(root,'slack.sqlite'));initializeSlack(db);bindSlack(db,'TTEAM','AAPP','UBOT',agent);let calls=0,lost=true,answerLost=true;const yes=useButtons?'Yes '.repeat(45).trim():'Yes';
 const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const data=JSON.parse(raw);calls++;const answered=data.messages.some((m:any)=>m.role==='tool');res.end(JSON.stringify({choices:[{finish_reason:answered?'stop':'tool_calls',message:answered?{content:'Confirmed'}:{tool_calls:[{id:'question',type:'function',function:{name:'ask_user',arguments:JSON.stringify({question:'Proceed?',choices:[yes,'No']})}}]}}]}));});await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const address=provider.address();assert(address&&typeof address!=='string');const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${address.port}/v1`,scriptDirectory:join(root,'scripts')});const posts:any[]=[],sent:any[]=[];
 const actual=localScript(join(root,'scripts')),local=async(path:string,body?:unknown,signal?:AbortSignal)=>{const result=await actual(path,body,signal);if(body){posts.push({path,body});if(lost&&path.endsWith('/turns')){lost=false;throw new Error('Lost message');}if(answerLost&&path.endsWith('/answer')){answerLost=false;throw new Error('Lost answer');}}return result;};
 const remote=async(_method:string,body:Record<string,unknown>)=>{sent.push(body);return {channel:body.channel,ts:`1700000002.${String(sent.length).padStart(6,'0')}`};};
 async function ui(path:string,body?:unknown){const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await res.json();assert(res.ok,JSON.stringify(value));return value;}
 try{db.prepare('UPDATE slack_binding SET agent=?').run(agent);await ui('/api/agents',{id:agent,name:'Slack',model:'fixture',instructions:'Help'});await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true});recordSlackEnvelope(db,envelope(1),users);await assert.rejects(slackAgentStep(db,users,local,remote),/Lost message/);initializeSlack(db);
  for(let n=0;n<100&&!db.prepare('SELECT 1 FROM slack_questions').get();n++){await slackAgentStep(db,users,local,remote);await new Promise(r=>setTimeout(r,10));}
  const q=db.prepare('SELECT * FROM slack_questions').get()!;assert(q);const messages=posts.filter(p=>p.path.endsWith('/turns'));assert.equal(messages.length,2);assert.deepEqual(messages[0],messages[1]);assert.equal(calls,1);
  const foreign=envelope(2,`!answer ${q.id} Yes`,'UOTHER',String(q.root));foreign.payload.event.channel='DOTHER';recordSlackEnvelope(db,foreign,users);await slackAgentStep(db,users,local,remote);assert.equal(posts.filter(p=>p.path.endsWith('/answer')).length,0);
  if(useButtons){
   const notice=db.prepare('SELECT * FROM slack_outbox WHERE id=?').get(q.id)!;const ts=JSON.parse(String(notice.timestamps)).at(-1),buttons=sent.find(p=>p.blocks)?.blocks.at(-1).elements;assert.equal(buttons.length,2);assert.equal(buttons[0].text.text,`1. ${Array.from(yes).slice(0,45).join('')}...`);assert(sent.some(p=>p.text.includes(yes)));
   const click={type:'interactive',envelope_id:'question-button',payload:{type:'block_actions',team:{id:'TTEAM'},api_app_id:'AAPP',user:{id:'UUSER'},channel:{id:'DCHAT'},container:{channel_id:'DCHAT',message_ts:ts},message:{user:'UBOT',ts},actions:[{type:'button',action_id:buttons[0].action_id,value:buttons[0].value}]}};
   for(const edit of [(p:any)=>p.user.id='UOTHER',(p:any)=>p.message.ts='1700000099.000001',(p:any)=>p.actions[0]={type:'button',action_id:'briefsip_answer_7',value:`question:${q.id}:7`},(p:any)=>p.actions[0]={type:'button',action_id:'briefsip_approve_yes',value:`approval:${q.id}:yes`}]){const bad=structuredClone(click);edit(bad.payload);recordSlackEnvelope(db,bad,users);assert.equal(db.prepare('SELECT count(*) AS n FROM slack_question_callbacks').get()!.n,0);}
   db.prepare("UPDATE slack_outbox SET status='sending' WHERE id=?").run(q.id);assert.equal(recordSlackEnvelope(db,click,users),null);db.prepare("UPDATE slack_outbox SET status='sent' WHERE id=?").run(q.id);
   recordSlackEnvelope(db,click,users);const opposite=structuredClone(click);opposite.payload.actions=[{type:'button',action_id:buttons[1].action_id,value:buttons[1].value}];recordSlackEnvelope(db,opposite,users);assert.equal(db.prepare('SELECT answer FROM slack_question_callbacks').get()!.answer,yes);
   await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:1,enabled:false});await assert.rejects(slackAgentStep(db,users,local,remote));assert.equal(posts.filter(p=>p.path.endsWith('/answer')).length,0);assert.equal(db.prepare('SELECT status FROM slack_question_callbacks').get()!.status,'queued');await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:2,enabled:true});
   await assert.rejects(slackAgentStep(db,users,local,remote),/Lost answer/);db.close();db=new DatabaseSync(join(root,'slack.sqlite'));initializeSlack(db);
  }else{
   recordSlackEnvelope(db,envelope(3,`!answer ${q.id} Yes`,'UUSER',String(q.root)),users);await assert.rejects(slackAgentStep(db,users,local,remote),/Lost answer/);const pendingAnswer=db.prepare('SELECT turn FROM slack_inbox WHERE event=?').get('Ev3')!;recordSlackEnvelope(db,envelope(5,`!stop ${pendingAnswer.turn}`,'UUSER',String(q.root)),users);initializeSlack(db);
  }
  for(let n=0;n<100&&!sent.some(p=>p.text==='Confirmed');n++){await slackAgentStep(db,users,local,remote);await new Promise(r=>setTimeout(r,10));}const answers=posts.filter(p=>p.path.endsWith('/answer'));assert.equal(answers.length,2);assert.deepEqual(answers[0],answers[1]);assert.equal(answers[0].body.text,yes);assert.equal(calls,2);assert.deepEqual(await ui(`/api/agents/${agent}/turns`),[]);
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:useButtons?3:1,enabled:false});recordSlackEnvelope(db,envelope(4),users);await assert.rejects(slackAgentStep(db,users,local,remote));assert.equal(calls,2);
 }finally{db.close();await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(root,{recursive:true,force:true});}
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
 await Promise.all([new Promise<void>(r=>provider.listen(0,'127.0.0.1',r)),new Promise<void>(r=>slack.listen(0,'127.0.0.1',r))]);const pa=provider.address(),sa=slack.address();assert(pa&&typeof pa!=='string'&&sa&&typeof sa!=='string');const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${pa.port}/v1`,scriptDirectory:join(root,'scripts')});const timeout=setTimeout(()=>controller.abort(),10000);
 try{for(const [path,body]of [['/api/agents',{id:agent,name:'Socket',model:'fixture',instructions:'Help'}],[`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true}]]as const){const res=await fetch(app.origin+path,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});assert(res.ok);await res.json();}
  await runSlack({directory:join(root,'state'),scriptDirectory:join(root,'scripts'),agent,team:'TTEAM',app:'AAPP',botToken:'xoxb-'+'b'.repeat(24),appToken:'xapp-'+'a'.repeat(24),users:['UUSER'],origin:`http://127.0.0.1:${sa.port}`},controller.signal);assert.equal(providerCalls,1);assert.equal(delivered,1);assert(connections>=2);assert(acks>=2);assert(!existsSync(join(root,'state','owner.lock')));assert(authHeaders.some(h=>h.startsWith('Bearer xapp-')));assert(authHeaders.some(h=>h.startsWith('Bearer xoxb-')));
 }finally{clearTimeout(timeout);controller.abort();for(const socket of sockets)socket.destroy();await app.close();provider.closeAllConnections();slack.closeAllConnections();await Promise.all([new Promise<void>(r=>provider.close(()=>r())),new Promise<void>(r=>slack.close(()=>r()))]);rmSync(root,{recursive:true,force:true});}
});

test('Slack status and stop scope to requester root and preserve cancellation identity after lost responses',async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-slack-controls-')),agent=randomUUID(),users=new Set(['UUSER','UOTHER']);let sequence=0,calls=0,loseSubmit=false,loseCancel=false,loseBefore=false;
 const provider=createServer(async(req,res)=>{for await(const _ of req){}calls++;res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'ask',type:'function',function:{name:'ask_user',arguments:JSON.stringify({question:'Wait',choices:['Yes','No']})}}]}}]}));});await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const address=provider.address();assert(address&&typeof address!=='string');const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${address.port}/v1`,scriptDirectory:join(root,'scripts')});let db=new DatabaseSync(join(root,'journal.sqlite'));const requests:any[]=[],sent:any[]=[];
 const actual=localScript(join(root,'scripts')),local=async(path:string,body?:unknown,signal?:AbortSignal)=>{if(body&&loseBefore&&path.endsWith('/turns')){loseBefore=false;throw new Error('Before submission');}const value=await actual(path,body,signal);if(body){requests.push({path,body});if(loseSubmit&&path.endsWith('/turns')){loseSubmit=false;throw new Error('Lost submission');}if(loseCancel&&path.endsWith('/cancel')){loseCancel=false;throw new Error('Lost cancellation');}}return value;};
 const remote=async(_method:string,body:Record<string,unknown>)=>{sent.push(body);return {channel:body.channel,ts:`1700000003.${String(sent.length).padStart(6,'0')}`};};
 async function ui(path:string,body?:unknown):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await res.json();assert(res.ok,JSON.stringify(value));return value;}
 function incoming(text:string,parent?:string,user='UUSER',channel='DCHAT'){sequence++;const e=envelope(sequence,text,user,parent);e.payload.event.channel=channel;recordSlackEnvelope(db,e,users);return db.prepare('SELECT * FROM slack_inbox WHERE event=?').get(`Ev${sequence}`)!;}
 try{
  await ui('/api/agents',{id:agent,name:'Controls',model:'fixture',instructions:'Help'});await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true});initializeSlack(db);bindSlack(db,'TTEAM','AAPP','UBOT',agent);
  const unsent=incoming('Never execute');incoming(`!stop ${unsent.turn}`,String(unsent.root));await slackAgentStep(db,users,local,remote);assert.equal(calls,0);assert.equal(requests.filter(r=>r.path.endsWith('/turns')).length,0);assert.equal(db.prepare('SELECT status FROM slack_inbox WHERE event=?').get(unsent.event)!.status,'cancelled');
  const active=incoming('!ANSWER ordinary task');loseSubmit=true;await assert.rejects(slackAgentStep(db,users,local,remote),/Lost submission/);assert.equal(db.prepare('SELECT status FROM slack_inbox WHERE event=?').get(active.event)!.status,'submitting');
  // Simulate a journal created before submission intent existed.
  db.prepare("UPDATE slack_inbox SET status='queued' WHERE event=?").run(active.event);db.exec('PRAGMA user_version=0');db.close();db=new DatabaseSync(join(root,'journal.sqlite'));initializeSlack(db);assert.equal(db.prepare('SELECT status FROM slack_inbox WHERE event=?').get(active.event)!.status,'submitting');
  incoming(`!stop ${active.turn}`,undefined);incoming(`!stop ${active.turn}`,String(active.root),'UOTHER','DOTHER');incoming('!status',String(active.root));await slackAgentStep(db,users,local,remote);assert.equal(requests.filter(r=>r.path.endsWith('/cancel')).length,0);assert(sent.some(r=>r.text.includes(String(active.turn))&&r.text.includes('!stop')));
  const cancel=incoming(`!stop ${active.turn}`,String(active.root));loseCancel=true;await assert.rejects(slackAgentStep(db,users,local,remote),/Lost cancellation/);db.close();db=new DatabaseSync(join(root,'journal.sqlite'));initializeSlack(db);await slackAgentStep(db,users,local,remote);const cancellations=requests.filter(r=>r.path.endsWith('/cancel'));assert.equal(cancellations.length,2);assert.deepEqual(cancellations[0],cancellations[1]);assert.equal(cancellations[0].body.id,cancel.turn);assert.equal((await ui(`/api/threads/${active.thread}/turns`))[0].status,'cancelled');
  const before=incoming('Do not create');loseBefore=true;await assert.rejects(slackAgentStep(db,users,local,remote),/Before submission/);const priorCalls=calls;incoming(`!stop ${before.turn}`,String(before.root));await slackAgentStep(db,users,local,remote);assert.equal(db.prepare('SELECT status FROM slack_inbox WHERE event=?').get(before.event)!.status,'unavailable');assert.equal(calls,priorCalls);assert.deepEqual(await ui(`/api/threads/${before.thread}/turns`),[]);
  incoming('!status',String(before.root));await slackAgentStep(db,users,local,remote);assert(sent.some(r=>r.text==='Tidak ada tugas aktif di thread ini.'));
 }finally{db.close();await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});

test('Slack offline recovery pins revisions, retains confirmed chunks and requires explicit CLI confirmation',async()=>{
 const {spawnSync}=await import('node:child_process');const {connectorJournal}=await import('./connector-journal.ts');
 const directory=mkdtempSync(join(tmpdir(),'briefsip-slack-recovery-')),id=randomUUID();let owner=connectorJournal(directory,'slack.sqlite');let closed=false,calls=0;
 const cli=(...args:string[])=>spawnSync(process.execPath,['--experimental-strip-types','slack-runner.ts',...args],{cwd:import.meta.dirname,env:{...process.env,BRIEFSIP_SLACK_DIRECTORY:directory},encoding:'utf8'});
 const remote=async()=>{calls++;if(calls>1)throw new SlackError(false);return {channel:'DCHAT',ts:'1700000001.000001'};};
 try{
  initializeSlack(owner.db);owner.db.prepare('INSERT INTO slack_outbox(id,channel,sender,root,text) VALUES (?,?,?,?,?)').run(id,'DCHAT','UUSER','1700000000.000001','x'.repeat(5000));
  await deliverSlack(owner.db,id,remote,async()=>{});assert.equal(calls,2);assert.notEqual(cli('inspect',id).status,0);
  owner.close();closed=true;
  let inspected=JSON.parse(cli('inspect',id).stdout);assert.equal(inspected.reply.status,'uncertain');assert.equal(inspected.reply.part,1);assert.equal(inspected.revision,0);
  assert.notEqual(cli('recover',id,'0','retry').status,0);assert.equal(cli('recover',id,'0','retry','--accept-duplicate-risk').status,0);
  owner=connectorJournal(directory,'slack.sqlite');closed=false;initializeSlack(owner.db);await deliverSlack(owner.db,id,remote,async()=>{});assert.equal(calls,3);owner.close();closed=true;
  assert.notEqual(cli('recover',id,'0','retry','--accept-duplicate-risk').status,0);
  inspected=JSON.parse(cli('inspect',id).stdout);assert.equal(inspected.reply.part,1);assert.equal(JSON.parse(inspected.reply.timestamps).length,1);assert.equal(inspected.revision,1);
  assert.equal(cli('recover',id,'1','retry','--accept-duplicate-risk').status,0);
  owner=connectorJournal(directory,'slack.sqlite');closed=false;initializeSlack(owner.db);let authorized=false;
  await assert.rejects(deliverSlack(owner.db,id,async()=>{throw new Error('must not send');},async()=>{if(!authorized)throw new Error('revoked');}),/revoked/);
  authorized=true;await deliverSlack(owner.db,id,async(_method,body)=>{calls++;assert.equal(body.text,'x'.repeat(1000));return {channel:'DCHAT',ts:'1700000001.000002'};},async()=>{});
  assert.equal(owner.db.prepare('SELECT status FROM slack_outbox WHERE id=?').get(id)!.status,'sent');owner.db.prepare("UPDATE slack_outbox SET status='sending' WHERE id=?").run(id);owner.close();closed=true;
  inspected=JSON.parse(cli('inspect',id).stdout);assert.equal(inspected.reply.status,'uncertain');assert.equal(inspected.revision,2);
  assert.notEqual(cli('recover',id,'2','discard').status,0);assert.equal(cli('recover',id,'2','discard','--confirm').status,0);assert.notEqual(cli('recover',id,'3','retry','--accept-duplicate-risk').status,0);
  inspected=JSON.parse(cli('inspect',id).stdout);assert.equal(inspected.reply.status,'discarded');assert.equal(inspected.decisions.length,3);assert.equal(inspected.reply.part,2);
  const rejected=randomUUID();owner=connectorJournal(directory,'slack.sqlite');closed=false;initializeSlack(owner.db);
  owner.db.prepare('INSERT INTO slack_outbox(id,channel,sender,root,text) VALUES (?,?,?,?,?)').run(rejected,'DCHAT','UUSER','1700000000.000001','Rejected');
  await deliverSlack(owner.db,rejected,async()=>{throw new SlackError(true);},async()=>{});owner.close();closed=true;
  inspected=JSON.parse(cli('inspect',rejected).stdout);assert.equal(inspected.reply.status,'failed');assert.equal(inspected.reply.part,0);
  assert.equal(cli('recover',rejected,'0','retry','--accept-duplicate-risk').status,0);
  assert.equal(JSON.parse(cli('inspect',rejected).stdout).reply.status,'queued');
 }finally{if(!closed)owner.close();rmSync(directory,{recursive:true,force:true});}
});

test('Slack HTTP rate limit defers workspace delivery durably without retrying uncertain responses',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'briefsip-slack-rate-')),file=join(directory,'journal.sqlite');let db=new DatabaseSync(file),requests=0,mode='rate',retry='1';
 const server=createServer(async(req,res)=>{for await(const _ of req){}requests++;if(mode==='rate'){res.writeHead(429,{'Retry-After':retry});res.end('rate limited');}else if(mode==='lost'){req.socket.destroy();}else{res.end(JSON.stringify({ok:true,channel:'DCHAT',ts:`1700000001.${String(requests).padStart(6,'0')}`}));}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address!=='string');const remote=slackApi('xoxb-'+'b'.repeat(24),'xapp-'+'a'.repeat(24),`http://127.0.0.1:${address.port}`);
 const first=randomUUID(),second=randomUUID();const add=(id:string)=>db.prepare('INSERT INTO slack_outbox(id,channel,sender,root,text) VALUES (?,?,?,?,?)').run(id,'DCHAT','UUSER','1700000000.000001','Reply');
 try{
  initializeSlack(db);add(first);add(second);await deliverSlack(db,first,remote,async()=>{});assert.equal(requests,1);assert.equal(db.prepare('SELECT status FROM slack_outbox WHERE id=?').get(first)!.status,'queued');
  const until=Number(db.prepare('SELECT until FROM slack_delivery_cooldown').get()!.until);assert(until>Date.now());db.close();db=new DatabaseSync(file);initializeSlack(db);
  await deliverSlack(db,second,remote,async()=>{});assert.equal(requests,1);
  await new Promise(r=>setTimeout(r,Math.max(0,until-Date.now())+10));mode='ok';await assert.rejects(deliverSlack(db,first,remote,async()=>{throw new Error('revoked');}),/revoked/);assert.equal(requests,1);
  await deliverSlack(db,first,remote,async()=>{});assert.equal(requests,2);assert.equal(db.prepare('SELECT status FROM slack_outbox WHERE id=?').get(first)!.status,'sent');
  mode='lost';await deliverSlack(db,second,remote,async()=>{});assert.equal(requests,3);initializeSlack(db);await deliverSlack(db,second,remote,async()=>{});assert.equal(requests,3);assert.equal(db.prepare('SELECT status FROM slack_outbox WHERE id=?').get(second)!.status,'uncertain');
  for(const header of ['0','-1','1.5','bad','999999999999999999999']){mode='rate';retry=header;const id=randomUUID();add(id);await deliverSlack(db,id,remote,async()=>{});assert.equal(db.prepare('SELECT status FROM slack_outbox WHERE id=?').get(id)!.status,'failed');}
  const multipart=randomUUID();add(multipart);db.prepare('UPDATE slack_outbox SET text=? WHERE id=?').run('x'.repeat(5000),multipart);mode='ok';retry='1';
  await deliverSlack(db,multipart,async(method,body,signal)=>{const result=await remote(method,body,signal);mode='rate';return result;},async()=>{});
  const partial=db.prepare('SELECT * FROM slack_outbox WHERE id=?').get(multipart)!;assert.equal(partial.status,'queued');assert.equal(partial.part,1);assert.equal(JSON.parse(String(partial.timestamps)).length,1);
  const resume=Number(db.prepare('SELECT until FROM slack_delivery_cooldown').get()!.until);await new Promise(r=>setTimeout(r,Math.max(0,resume-Date.now())+10));mode='ok';const before=requests;
  await deliverSlack(db,multipart,async(method,body,signal)=>{assert.equal(body.text,'x'.repeat(1000));return remote(method,body,signal);},async()=>{});assert.equal(requests,before+1);assert.equal(db.prepare('SELECT part FROM slack_outbox WHERE id=?').get(multipart)!.part,2);
 }finally{db.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(directory,{recursive:true,force:true});}
});

test('Slack session cooldown survives abort and reopen without blocking other methods',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'briefsip-slack-session-')),file=join(directory,'journal.sqlite');let db=new DatabaseSync(file),calls=0;
 try{
  initializeSlack(db);const stop=new AbortController();
  const pending=slackSessionRequest(db,async()=>{calls++;setTimeout(()=>stop.abort(),20);throw new SlackError(true,1);},'auth.test',stop.signal);
  await assert.rejects(pending);assert.equal(calls,1);const until=Number(db.prepare("SELECT until FROM slack_session_cooldowns WHERE method='auth.test'").get()!.until);
  db.close();db=new DatabaseSync(file);initializeSlack(db);
  await slackSessionRequest(db,async()=>{calls++;return {};},'apps.connections.open',new AbortController().signal);assert.equal(calls,2);
  await slackSessionRequest(db,async()=>{assert(Date.now()>=until);calls++;return {};},'auth.test',new AbortController().signal);assert.equal(calls,3);
  await assert.rejects(slackSessionRequest(db,async()=>{calls++;throw new SlackError(false);},'auth.test',new AbortController().signal));assert.equal(calls,4);
  const stopped=AbortSignal.abort();await assert.rejects(slackSessionRequest(db,async()=>{calls++;return {};},'auth.test',stopped));assert.equal(calls,4);
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});

test('Slack startup cancellation releases lock and status retains authentication cooldown',async()=>{
 const {spawnSync}=await import('node:child_process');const root=mkdtempSync(join(tmpdir(),'briefsip-slack-start-stop-')),directory=join(root,'state'),controller=new AbortController();let requests=0;
 const server=createServer(async(req,res)=>{for await(const _ of req){}requests++;res.writeHead(429,{'Retry-After':'60'});res.end('Wait');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address!=='string');
 const timeout=setTimeout(()=>controller.abort(),5000);
 try{
  const running=runSlack({directory,scriptDirectory:join(root,'unused'),agent:randomUUID(),team:'TTEAM',app:'AAPP',botToken:'xoxb-'+'b'.repeat(24),appToken:'xapp-'+'a'.repeat(24),users:['UUSER'],origin:`http://127.0.0.1:${address.port}`},controller.signal);
  let recorded=false;for(let i=0;i<100&&!recorded;i++){await new Promise(r=>setTimeout(r,10));if(!existsSync(join(directory,'slack.sqlite')))continue;const db=new DatabaseSync(join(directory,'slack.sqlite'));try{recorded=!!db.prepare("SELECT until FROM slack_session_cooldowns WHERE method='auth.test'").get();}finally{db.close();}}
  assert(recorded);controller.abort();await running;assert.equal(requests,1);assert(!existsSync(join(directory,'owner.lock')));
  const status=spawnSync(process.execPath,['--experimental-strip-types','slack-runner.ts','status'],{cwd:import.meta.dirname,env:{...process.env,BRIEFSIP_SLACK_DIRECTORY:directory},encoding:'utf8'});assert.equal(status.status,0,status.stderr);const rows=JSON.parse(status.stdout).sessionCooldowns;assert.equal(rows.length,1);assert.equal(rows[0].method,'auth.test');assert(rows[0].until>Date.now());
 }finally{clearTimeout(timeout);controller.abort();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});

test('Slack interactive Socket Mode withholds early ACK and commits one decision before redelivery ACK',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'briefsip-slack-button-socket-')),file=join(directory,'journal.sqlite'),db=new DatabaseSync(file),controller=new AbortController();let socket:any,pending=Buffer.alloc(0),release:()=>void=()=>{},connected:()=>void=()=>{};
 const connectedPromise=new Promise<void>(r=>connected=r),responseGate=new Promise<void>(r=>release=r),acks:string[]=[];let notice='',run='',observedCommitted=false;
 const click=(id:string,choice='yes')=>({type:'interactive',envelope_id:id,payload:{type:'block_actions',team:{id:'TTEAM'},api_app_id:'AAPP',user:{id:'UUSER'},channel:{id:'DCHAT'},container:{channel_id:'DCHAT',message_ts:'1700000001.000001'},message:{user:'UBOT',ts:'1700000001.000001'},actions:[{type:'button',action_id:`briefsip_approve_${choice}`,value:`approval:${notice}:${choice}`}]}});
 const server=createServer(async(req,res)=>{for await(const _ of req){}socket.write(frame(click('early')));socket.write(frame({type:'probe',envelope_id:'barrier'}));await responseGate;res.end(JSON.stringify({ok:true,channel:'DCHAT',ts:'1700000001.000001'}));});
 server.on('upgrade',(req,client)=>{socket=client;const accept=createHash('sha1').update(String(req.headers['sec-websocket-key'])+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');client.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);client.write(frame({type:'hello',connection_info:{app_id:'AAPP'}}));connected();
  client.on('data',chunk=>{pending=Buffer.concat([pending,chunk]);while(pending.length>=6){const opcode=pending[0]&15,size=pending[1]&127;if(size>=126||pending.length<6+size)return;const mask=pending.subarray(2,6),body=Buffer.from(pending.subarray(6,6+size));pending=pending.subarray(6+size);for(let i=0;i<body.length;i++)body[i]^=mask[i%4];if(opcode===8){client.end(Buffer.from([0x88,0]));continue;}if(opcode!==1)continue;const id=JSON.parse(body.toString()).envelope_id;acks.push(id);if(id==='retry'){const reader=new DatabaseSync(file);try{observedCommitted=reader.prepare('SELECT count(*) AS n FROM slack_callbacks').get()!.n===1;}finally{reader.close();}}}});
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address!=='string');let listening:Promise<void>|undefined,delivery:Promise<void>|undefined;
 async function waitFor(predicate:()=>boolean){for(let i=0;i<200&&!predicate();i++)await new Promise(r=>setTimeout(r,10));assert(predicate(),'Socket fixture condition timed out');}
 try{
  initializeSlack(db);bindSlack(db,'TTEAM','AAPP','UBOT',randomUUID());run=randomUUID();notice=randomUUID();db.prepare('INSERT INTO slack_workflows VALUES (?,?,?,?,?)').run(run,'DCHAT','UUSER','1700000000.000001',randomUUID());db.prepare('INSERT INTO slack_approvals VALUES (?,?,?)').run(run,1,notice);finishSlack(db,{turn:run,channel:'DCHAT',sender:'UUSER',root:'1700000000.000001'},'Proceed?',notice);
  listening=slackSocket(db,`ws://127.0.0.1:${address.port}/socket`,'AAPP',new Set(['UUSER']),controller.signal,true);await connectedPromise;
  delivery=deliverSlack(db,notice,slackApi('xoxb-'+'b'.repeat(24),'xapp-'+'a'.repeat(24),`http://127.0.0.1:${address.port}`),async()=>{});
  await waitFor(()=>acks.includes('barrier'));assert(!acks.includes('early'));assert.equal(db.prepare('SELECT count(*) AS n FROM slack_callbacks').get()!.n,0);release();await delivery;
  socket.write(frame(click('retry')));await waitFor(()=>acks.includes('retry'));assert(observedCommitted);const first=db.prepare('SELECT id,accepted FROM slack_callbacks').get()!;
  socket.write(frame(click('retry')));await waitFor(()=>acks.filter(id=>id==='retry').length===2);assert.deepEqual(db.prepare('SELECT id,accepted FROM slack_callbacks').get(),first);
  socket.write(frame(click('duplicate','no')));await waitFor(()=>acks.includes('duplicate'));assert.deepEqual(db.prepare('SELECT id,accepted FROM slack_callbacks').get(),first);assert.equal(first.accepted,1);
 }finally{release();controller.abort();socket?.destroy();await Promise.allSettled([...(listening?[listening]:[]),...(delivery?[delivery]:[])]);server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();rmSync(directory,{recursive:true,force:true});}
});


test('Slack legacy question notice retains text and snapshots choices without redelivery',async()=>{
 const db=setup();try{
  recordSlackEnvelope(db,envelope(1),new Set(['UUSER']));const row=db.prepare('SELECT * FROM slack_inbox').get()!,question=randomUUID();db.prepare("UPDATE slack_inbox SET status='running'").run();
  db.prepare('INSERT INTO slack_questions VALUES (?,?,?,?,?,?)').run(question,row.channel,row.sender,row.root,row.thread,row.turn);finishSlack(db,row,'Proceed?\nPilihan: Yes | No',question);db.prepare("UPDATE slack_outbox SET status='sent',part=1,timestamps=?").run(JSON.stringify(['1700000001.000001']));let remote=0;
  const local=async(path:string)=>path.includes('/turns?')?[{id:row.turn,status:'waiting',questions:[{id:question,prompt:'Proceed?',choices:['Yes','No'],answer:null}]}]:[];
  await slackAgentStep(db,new Set(['UUSER']),local,async()=>{remote++;return {};});assert.equal(remote,0);assert.equal(db.prepare('SELECT text FROM slack_outbox').get()!.text,'Proceed?\nPilihan: Yes | No');assert.deepEqual(JSON.parse(String(db.prepare('SELECT choices FROM slack_question_choices').get()!.choices)),['Yes','No']);
 }finally{db.close();}
});
