import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeSlack,bindSlack,recordSlackEnvelope,finishSlack,deliverSlack,slackApi,SlackError} from './slack.ts';
import {runSlack,slackAgentStep,slackSocket} from './slack-runner.ts';
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

test('Slack actual agent API retries one task and isolates requester question answers',async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-slack-bridge-')),agent=randomUUID(),db=setup(),users=new Set(['UUSER','UOTHER']);let calls=0,lost=true,answerLost=true;
 const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const data=JSON.parse(raw);calls++;const answered=data.messages.some((m:any)=>m.role==='tool');res.end(JSON.stringify({choices:[{finish_reason:answered?'stop':'tool_calls',message:answered?{content:'Confirmed'}:{tool_calls:[{id:'question',type:'function',function:{name:'ask_user',arguments:JSON.stringify({question:'Proceed?',choices:['Yes','No']})}}]}}]}));});await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const address=provider.address();assert(address&&typeof address!=='string');const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${address.port}/v1`,scriptDirectory:join(root,'scripts')});const posts:any[]=[],sent:any[]=[];
 const actual=localScript(join(root,'scripts')),local=async(path:string,body?:unknown,signal?:AbortSignal)=>{const result=await actual(path,body,signal);if(body){posts.push({path,body});if(lost&&path.endsWith('/turns')){lost=false;throw new Error('Lost message');}if(answerLost&&path.endsWith('/answer')){answerLost=false;throw new Error('Lost answer');}}return result;};
 const remote=async(_method:string,body:Record<string,unknown>)=>{sent.push(body);return {channel:body.channel,ts:`1700000002.${String(sent.length).padStart(6,'0')}`};};
 async function ui(path:string,body?:unknown){const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await res.json();assert(res.ok,JSON.stringify(value));return value;}
 try{db.prepare('UPDATE slack_binding SET agent=?').run(agent);await ui('/api/agents',{id:agent,name:'Slack',model:'fixture',instructions:'Help'});await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true});recordSlackEnvelope(db,envelope(1),users);await assert.rejects(slackAgentStep(db,users,local,remote),/Lost message/);initializeSlack(db);
  for(let n=0;n<100&&!db.prepare('SELECT 1 FROM slack_questions').get();n++){await slackAgentStep(db,users,local,remote);await new Promise(r=>setTimeout(r,10));}
  const q=db.prepare('SELECT * FROM slack_questions').get()!;assert(q);const messages=posts.filter(p=>p.path.endsWith('/turns'));assert.equal(messages.length,2);assert.deepEqual(messages[0],messages[1]);assert.equal(calls,1);
  const foreign=envelope(2,`!answer ${q.id} Yes`,'UOTHER',String(q.root));foreign.payload.event.channel='DOTHER';recordSlackEnvelope(db,foreign,users);await slackAgentStep(db,users,local,remote);assert.equal(posts.filter(p=>p.path.endsWith('/answer')).length,0);
  recordSlackEnvelope(db,envelope(3,`!answer ${q.id} Yes`,'UUSER',String(q.root)),users);await assert.rejects(slackAgentStep(db,users,local,remote),/Lost answer/);initializeSlack(db);
  for(let n=0;n<100&&!sent.some(p=>p.text==='Confirmed');n++){await slackAgentStep(db,users,local,remote);await new Promise(r=>setTimeout(r,10));}const answers=posts.filter(p=>p.path.endsWith('/answer'));assert.equal(answers.length,2);assert.deepEqual(answers[0],answers[1]);assert.equal(calls,2);assert.deepEqual(await ui(`/api/agents/${agent}/turns`),[]);
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:1,enabled:false});recordSlackEnvelope(db,envelope(4),users);await assert.rejects(slackAgentStep(db,users,local,remote));assert.equal(calls,2);
 }finally{db.close();await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});

// Minimal fixture framing; production uses Node's native WebSocket implementation.
function frame(value:unknown){const bytes=Buffer.from(JSON.stringify(value)),head=bytes.length<126?Buffer.from([0x81,bytes.length]):Buffer.from([0x81,126,bytes.length>>8,bytes.length&255]);return Buffer.concat([head,bytes]);}
test('Slack Socket Mode runner acknowledges journaled event and delivers once after reconnect',async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-slack-run-')),agent=randomUUID(),controller=new AbortController(),sockets=new Set<any>();let providerCalls=0,connections=0,acks=0,delivered=0;const authHeaders:string[]=[];const finish=()=>{if(delivered&&acks>=2)setTimeout(()=>controller.abort(),20);};
 const provider=createServer(async(req,res)=>{for await(const _ of req){}providerCalls++;res.end(JSON.stringify({choices:[{message:{content:'Socket reply'},finish_reason:'stop'}]}));});
 const slack=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);authHeaders.push(String(req.headers.authorization));let result:any;
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
