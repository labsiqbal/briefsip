import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startApp} from './server.ts';
import {initializeSlack,bindSlack,recordSlackEnvelope,finishSlack,deliverSlack} from './slack.ts';
import {slackAgentStep} from './slack-runner.ts';
import {localScript} from './script-client.ts';

for(const shared of [false,true])test(`Slack workflow commands bind requester root and retry run, approval and cancellation across restart (shared=${shared})`,async()=>{
 const selectedChannel=shared?'CROOM':'DCHAT',channels=new Set(shared?[selectedChannel]:[]);
 const dir=mkdtempSync(join(tmpdir(),'briefsip-slack-workflows-')),agent=randomUUID(),users=new Set(['UUSER','UOTHER']);
 const app=await startApp({database:join(dir,'app.sqlite'),scriptDirectory:join(dir,'scripts')});let db=new DatabaseSync(join(dir,'slack.sqlite')),sequence=0,loseRun=true,loseApprove=true,loseCancel=true;
 const sent:any[]=[],requests:any[]=[];const actual=localScript(join(dir,'scripts'));
 const local=async(path:string,body?:unknown,signal?:AbortSignal)=>{const value=await actual(path,body,signal);if(body){requests.push({path,body});if(loseRun&&path.endsWith('/run')){loseRun=false;throw new Error('Lost run');}if(loseApprove&&path.endsWith('/approve')){loseApprove=false;throw new Error('Lost approval');}if(loseCancel&&path.endsWith('/cancel')){loseCancel=false;throw new Error('Lost cancellation');}}return value;};
 const remote=async(_method:string,body:Record<string,unknown>)=>{sent.push(body);return {channel:body.channel,ts:`1700000002.${String(sent.length).padStart(6,'0')}`};};
 async function ui(path:string,body?:unknown):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await res.json();assert(res.ok,JSON.stringify(value));return value;}
 function incoming(text:string,root?:string,user='UUSER',channel=selectedChannel){sequence++;recordSlackEnvelope(db,{type:'events_api',envelope_id:`envelope-${sequence}`,payload:{type:'event_callback',team_id:'TTEAM',api_app_id:'AAPP',event_id:`Ev${sequence}`,authorizations:[{team_id:'TTEAM',user_id:'UBOT',is_bot:true}],event:{type:'message',channel_type:shared?'channel':'im',channel,user,text:shared&&!root?`<@UBOT> ${text}`:text,ts:`1700000000.${String(sequence).padStart(6,'0')}`,...(root?{thread_ts:root}:{})}}},users,channels);return db.prepare('SELECT * FROM slack_inbox WHERE event=?').get(`Ev${sequence}`)!;}
 function restart(){db.close();db=new DatabaseSync(join(dir,'slack.sqlite'));initializeSlack(db);}
 try{
  await ui('/api/agents',{runtime:'api', id:agent,name:'Workflows',model:'fixture',instructions:'Help'});await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true});
  const workflow=await ui(`/api/agents/${agent}/workflows`,{id:randomUUID(),revision:0,name:'Approval',graph:{entry:'ask',maxSteps:2,nodes:[{id:'ask',kind:'approval',prompt:'Proceed?',yes:'out'},{id:'out',kind:'output'}]}});
  initializeSlack(db);bindSlack(db,'TTEAM','AAPP','UBOT',agent);incoming('!workflows');await slackAgentStep(db,users,local,remote,undefined,channels);assert(sent.at(-1).text.includes(workflow.id));
  const start=incoming(`!workflow ${workflow.id} 1 Exact input`);await assert.rejects(slackAgentStep(db,users,local,remote,undefined,channels),/Lost run/);restart();await slackAgentStep(db,users,local,remote,undefined,channels);const runs=requests.filter(r=>r.path.endsWith('/run'));assert.equal(runs.length,2);assert.deepEqual(runs[0],runs[1]);assert.equal((await ui(`/api/workflows/${workflow.id}/runs`)).length,1);
  const approval=db.prepare('SELECT * FROM slack_approvals WHERE run=?').get(start.turn)!;const count=sent.length;await slackAgentStep(db,users,local,remote,undefined,channels);assert.equal(sent.length,count);
  incoming(`!approve ${start.turn} ${approval.revision} yes`);incoming(`!approve ${start.turn} ${approval.revision} yes`,String(start.root),'UOTHER',shared?selectedChannel:'DOTHER');incoming(`!stop ${start.turn}`);await slackAgentStep(db,users,local,remote,undefined,channels);assert.equal(requests.filter(r=>r.path.endsWith('/approve')||r.path.endsWith('/cancel')).length,0);
  incoming('!status',String(start.root));await slackAgentStep(db,users,local,remote,undefined,channels);assert(sent.at(-1).text.includes(String(start.turn)));
  const posted=sent.find(message=>message.blocks?.some((block:any)=>block.type==='actions'));
  assert(posted);const buttons=posted.blocks.at(-1).elements;assert.equal(buttons.length,2);assert.notEqual(buttons[0].action_id,buttons[1].action_id);
  const notice=db.prepare('SELECT * FROM slack_outbox WHERE id=?').get(approval.notice)!;const ts=JSON.parse(String(notice.timestamps)).at(-1);
  const click={type:'interactive',envelope_id:'click-1',payload:{type:'block_actions',team:{id:'TTEAM'},api_app_id:'AAPP',user:{id:'UUSER'},channel:{id:selectedChannel},container:{channel_id:selectedChannel,message_ts:ts},message:{user:'UBOT',ts},actions:[{type:'button',action_id:buttons[0].action_id,value:buttons[0].value}]}};
  for(const change of [(p:any)=>p.user.id='UOTHER',(p:any)=>p.team.id='TOTHER',(p:any)=>p.api_app_id='AOTHER',(p:any)=>p.message.user='UOTHER',(p:any)=>p.message.ts='1700000009.000001',(p:any)=>p.channel.id='DOTHER']){const wrong=structuredClone(click);change(wrong.payload);assert.equal(recordSlackEnvelope(db,wrong,users,channels),'click-1');assert.equal(db.prepare('SELECT count(*) AS n FROM slack_callbacks').get()!.n,0);}
  db.prepare("UPDATE slack_outbox SET status='sending' WHERE id=?").run(approval.notice);assert.equal(recordSlackEnvelope(db,click,users,channels),null);assert.equal(db.prepare('SELECT count(*) AS n FROM slack_callbacks').get()!.n,0);
  db.prepare("UPDATE slack_outbox SET status='sent' WHERE id=?").run(approval.notice);assert.equal(recordSlackEnvelope(db,click,users,channels),'click-1');const opposite=structuredClone(click);opposite.payload.actions=[{type:'button',action_id:buttons[1].action_id,value:buttons[1].value}];recordSlackEnvelope(db,opposite,users,channels);assert.equal(db.prepare('SELECT accepted FROM slack_callbacks').get()!.accepted,1);
  await assert.rejects(slackAgentStep(db,users,local,remote,undefined,channels),/Lost approval/);restart();await slackAgentStep(db,users,local,remote,undefined,channels);await slackAgentStep(db,users,local,remote,undefined,channels);const approvals=requests.filter(r=>r.path.endsWith('/approve'));assert.equal(approvals.length,2);assert.deepEqual(approvals[0],approvals[1]);assert.equal((await ui(`/api/workflow-runs/${start.turn}`)).status,'done');assert(sent.some(r=>r.thread_ts===start.root&&r.text==='Exact input'));
  const stopped=incoming(`!workflow ${workflow.id} 1 Stop input`);await slackAgentStep(db,users,local,remote,undefined,channels);incoming(`!stop ${stopped.turn}`,String(stopped.root));await assert.rejects(slackAgentStep(db,users,local,remote,undefined,channels),/Lost cancellation/);restart();await slackAgentStep(db,users,local,remote,undefined,channels);const cancels=requests.filter(r=>r.path.endsWith('/cancel'));assert.equal(cancels.length,2);assert.deepEqual(cancels[0],cancels[1]);assert.equal((await ui(`/api/workflow-runs/${stopped.turn}`)).status,'cancelled');
  const rejected=incoming(`!workflow ${workflow.id} 1 Reject input`);await slackAgentStep(db,users,local,remote,undefined,channels);const rejectNotice=db.prepare('SELECT * FROM slack_approvals WHERE run=?').get(rejected.turn)!;const revision=rejectNotice.revision;const rejectOut=db.prepare('SELECT * FROM slack_outbox WHERE id=?').get(rejectNotice.notice)!;const rejectClick=structuredClone(click);rejectClick.envelope_id='reject-1';rejectClick.payload.message.ts=JSON.parse(String(rejectOut.timestamps)).at(-1);rejectClick.payload.container.message_ts=rejectClick.payload.message.ts;rejectClick.payload.actions=[{type:'button',action_id:'briefsip_approve_no',value:`approval:${rejectNotice.notice}:no`}];recordSlackEnvelope(db,rejectClick,users,channels);
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:1,enabled:false});await assert.rejects(slackAgentStep(db,users,local,remote,undefined,channels));assert.equal((await ui(`/api/workflow-runs/${rejected.turn}`)).status,'approval');assert.equal(db.prepare('SELECT status FROM slack_callbacks WHERE notice=?').get(rejectNotice.notice)!.status,'queued');
  await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:2,enabled:true});await slackAgentStep(db,users,local,remote,undefined,channels);incoming(`!approve ${rejected.turn} ${revision} yes`,String(rejected.root));await slackAgentStep(db,users,local,remote,undefined,channels);assert.equal((await ui(`/api/workflow-runs/${rejected.turn}`)).status,'failed');assert.equal(db.prepare('SELECT count(*) AS n FROM slack_closed_threads').get()!.n,0);
  const unsent=incoming(`!workflow ${workflow.id} 1 Never start`);incoming(`!stop ${unsent.turn}`,String(unsent.root));const runCount=requests.filter(r=>r.path.endsWith('/run')).length;await slackAgentStep(db,users,local,remote,undefined,channels);assert.equal(requests.filter(r=>r.path.endsWith('/run')).length,runCount);assert.equal(db.prepare('SELECT status FROM slack_inbox WHERE turn=?').get(unsent.turn)!.status,'cancelled');
  const before=incoming(`!workflow ${workflow.id} 1 Not accepted`);await assert.rejects(slackAgentStep(db,users,async(path,body,signal)=>{if(path.endsWith('/run'))throw new Error('Before run');return local(path,body,signal);},remote,undefined,channels),/Before run/);incoming(`!stop ${before.turn}`,String(before.root));await slackAgentStep(db,users,local,remote,undefined,channels);assert.equal(db.prepare('SELECT status FROM slack_inbox WHERE turn=?').get(before.turn)!.status,'unavailable');
  for(let i=0;i<20;i++)await ui(`/api/agents/${agent}/workflows`,{id:randomUUID(),revision:0,name:`Page ${i}`,graph:{entry:'out',maxSteps:1,nodes:[{id:'out',kind:'output'}]}});incoming('!workflows');await slackAgentStep(db,users,local,remote,undefined,channels);const first=sent.at(-1).text;assert.equal((first.match(/!workflow /g)||[]).length,20);const cursor=/!workflows ([a-f0-9-]{36})/.exec(first)![1];incoming(`!workflows ${cursor}`);await slackAgentStep(db,users,local,remote,undefined,channels);assert.equal((sent.at(-1).text.match(/!workflow /g)||[]).length,1);
 }finally{db.close();await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('Slack journals distinguish new workflow commands without reinterpreting legacy pending prompts',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec("CREATE TABLE slack_inbox(event TEXT PRIMARY KEY,channel TEXT NOT NULL,sender TEXT NOT NULL,ts TEXT NOT NULL,root TEXT NOT NULL,text TEXT NOT NULL,thread TEXT NOT NULL,turn TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'queued',checked INTEGER NOT NULL DEFAULT 0,UNIQUE(channel,ts)) STRICT; PRAGMA user_version=1;");
  db.prepare('INSERT INTO slack_inbox VALUES (?,?,?,?,?,?,?,?,?,?)').run('EvOld','DCHAT','UUSER','1700000000.000001','1700000000.000001','!workflow old ordinary input',randomUUID(),randomUUID(),'queued',0);initializeSlack(db);assert.equal(db.prepare('SELECT kind FROM slack_inbox').get()!.kind,'message');
 }finally{db.close();}
});


test('Slack approval buttons appear only on final chunk and keep prompt as plain text',async()=>{
 const db=new DatabaseSync(':memory:');try{
  initializeSlack(db);const run=randomUUID(),notice=randomUUID(),agent=randomUUID();bindSlack(db,'TTEAM','AAPP','UBOT',agent);
  db.prepare('INSERT INTO slack_workflows VALUES (?,?,?,?,?)').run(run,'DCHAT','UUSER','1700000000.000001',randomUUID());db.prepare('INSERT INTO slack_approvals VALUES (?,?,?)').run(run,1,notice);
  const text='x'.repeat(4100)+'<@UUSER> & <script>';
  finishSlack(db,{turn:run,channel:'DCHAT',sender:'UUSER',root:'1700000000.000001'},text,notice);const sent:any[]=[];
  await deliverSlack(db,notice,async(_method,body)=>{sent.push(body);return {channel:'DCHAT',ts:`1700000001.${String(sent.length).padStart(6,'0')}`};},async()=>{});
  assert.equal(sent.length,2);assert.equal(sent[0].blocks,undefined);const blocks=sent[1].blocks;assert.equal(blocks.at(-1).type,'actions');assert(blocks.slice(0,-1).every((b:any)=>b.text.type==='plain_text'&&b.text.text.length<=2000));assert.equal(blocks.slice(0,-1).map((b:any)=>b.text.text).join(''),text.slice(4000));
 }finally{db.close();}
});
