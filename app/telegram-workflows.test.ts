import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startApp} from './server.ts';
import {initializeTelegram,bindTelegram,recordTelegramUpdates,queueTelegramReply,deliverTelegramReply} from './telegram.ts';
import {telegramLocal,telegramAgentStep,pollTelegram} from './telegram-bridge.ts';

test('Telegram retains early button clicks until multipart delivery is confirmed',async()=>{
  const db=new DatabaseSync(':memory:'),agent=randomUUID(),run=randomUUID(),notice=randomUUID(),users=new Set([4]);
  const update={update_id:1,callback_query:{id:'early',data:`a:${notice}:y`,from:{id:4,is_bot:false},message:{message_id:99,chat:{id:4,type:'private'},from:{id:123,is_bot:true}}}};
  const acks:any[]=[];let release!:()=>void,exposed!:()=>void;
  const response=new Promise<void>(resolve=>release=resolve),visible=new Promise<void>(resolve=>exposed=resolve);
  try{
    initializeTelegram(db);bindTelegram(db,123,agent);db.prepare('INSERT INTO telegram_workflows VALUES (?,?,?,?)').run(run,4,randomUUID(),1);db.prepare('INSERT INTO telegram_approvals VALUES (?,?,?)').run(run,1,notice);
    queueTelegramReply(db,notice,4,2,'a'.repeat(4096)+'Approve?');let part=0;
    const sending=deliverTelegramReply(db,notice,async(_method,body)=>{part++;if(part===1){assert.equal(body.reply_markup,undefined);return {message_id:98,chat:{id:4}};}assert(body.reply_markup);exposed();await response;return {message_id:99,chat:{id:4}};});
    await visible;
    const remote=async(method:string,body:Record<string,unknown>)=>{if(method==='getUpdates')return [update];acks.push(body);return true;};
    assert.equal(await pollTelegram(db,users,remote),0);assert.equal(acks.length,0);assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_callbacks').get()!.n,0);
    release();await sending;
    assert.equal(await pollTelegram(db,users,remote),2);assert.equal(acks.length,1);assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_callbacks').get()!.n,1);
    assert.equal(await pollTelegram(db,users,remote),2);assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_callbacks').get()!.n,1);
  }finally{release();db.close();}
});

test('Telegram inline approvals validate message ownership and persist the first decision before acknowledgement',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'briefsip-telegram-buttons-')),agent=randomUUID(),users=new Set([4,5]);
  const app=await startApp({database:join(dir,'app.sqlite'),scriptDirectory:join(dir,'scripts')});
  let db=new DatabaseSync(join(dir,'journal.sqlite')),sequence=0,updates:any[]=[],lost=false,ackLost=false;
  const sent:any[]=[],decisions:any[]=[],acks:any[]=[];
  async function ui(path:string,body?:unknown):Promise<any>{const response=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await response.json();assert(response.ok,JSON.stringify(result));return result;}
  const real=telegramLocal(join(dir,'scripts'));
  const local=async(path:string,body?:unknown,signal?:AbortSignal)=>{const result=await real(path,body,signal);if(path.endsWith('/approve')){decisions.push({path,body});if(lost){lost=false;throw new Error('Lost decision');}}return result;};
  const remote=async(method:string,body:Record<string,unknown>)=>{
    if(method==='getUpdates'){assert.deepEqual(body.allowed_updates,['message','callback_query']);const batch=updates;updates=[];return batch;}
    if(method==='answerCallbackQuery'){assert.equal(db.prepare('SELECT offset FROM telegram_binding').get()!.offset,sequence+1);acks.push(body);if(ackLost){ackLost=false;throw new Error('Lost ack');}return true;}
    const message_id=sent.length+100;sent.push({...body,message_id});return {message_id,chat:{id:body.chat_id}};
  };
  function click(notice:any,accepted:boolean,change:Record<string,any>={}){sequence++;const query={id:`click-${sequence}`,data:`a:${notice.id}:${accepted?'y':'n'}`,from:{id:4,is_bot:false},message:{message_id:notice.message_id,chat:{id:4,type:'private'},from:{id:123,is_bot:true}},...change};updates.push({update_id:sequence,callback_query:query});}
  async function start(){sequence++;recordTelegramUpdates(db,[{update_id:sequence,message:{message_id:sequence,chat:{id:4,type:'private'},from:{id:4,is_bot:false},text:`/workflow ${workflow.id} 1 Button result`}}],users);const row=db.prepare('SELECT * FROM telegram_inbox WHERE update_id=?').get(sequence)!;await telegramAgentStep(db,users,local,remote);const notice=db.prepare('SELECT notice FROM telegram_approvals WHERE run=?').get(row.turn)!;const delivered=sent.find(item=>item.reply_markup?.inline_keyboard[0][0].callback_data===`a:${notice.notice}:y`);assert(delivered);return {id:notice.notice,message_id:delivered.message_id,run:row.turn};}
  let workflow:any;
  try{
    await ui('/api/agents',{id:agent,name:'Buttons',model:'fixture',instructions:'Help'});await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true});
    workflow=await ui(`/api/agents/${agent}/workflows`,{id:randomUUID(),revision:0,name:'Buttons',graph:{entry:'approve',maxSteps:2,nodes:[{id:'approve',kind:'approval',prompt:'Proceed?',yes:'out'},{id:'out',kind:'output'}]}});
    initializeTelegram(db);bindTelegram(db,123,agent);const notice=await start();
    for(const change of [
      {from:{id:5,is_bot:false}},
      {from:{id:5,is_bot:false},message:{message_id:notice.message_id,chat:{id:5,type:'private'},from:{id:123,is_bot:true}}},
      {message:{message_id:notice.message_id+1,chat:{id:4,type:'private'},from:{id:123,is_bot:true}}},
      {message:{message_id:notice.message_id,chat:{id:4,type:'group'},from:{id:123,is_bot:true}}},
      {message:{message_id:notice.message_id,chat:{id:4,type:'private'},from:{id:999,is_bot:true}}},
      {data:`a:${randomUUID()}:y`},{from:{id:4,is_bot:true}},
    ])click(notice,true,change);
    await pollTelegram(db,users,remote);await telegramAgentStep(db,users,local,remote);assert.equal(decisions.length,0);assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_callbacks').get()!.n,0);
    click(notice,true);click(notice,false);ackLost=true;await pollTelegram(db,users,remote);
    assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_callbacks').get()!.n,1);assert.equal(db.prepare('SELECT selection FROM telegram_callbacks').get()!.selection,1);
    const command=db.prepare('SELECT id FROM telegram_callbacks').get()!.id;
    db.close();db=new DatabaseSync(join(dir,'journal.sqlite'));initializeTelegram(db);
    lost=true;await assert.rejects(telegramAgentStep(db,users,local,remote),/Lost decision/);
    db.close();db=new DatabaseSync(join(dir,'journal.sqlite'));initializeTelegram(db);await telegramAgentStep(db,users,local,remote);await telegramAgentStep(db,users,local,remote);
    assert.equal(decisions.length,2);assert.deepEqual(decisions[0],decisions[1]);assert.equal(decisions[0].body.id,command);assert.equal((await ui(`/api/workflow-runs/${notice.run}`)).status,'done');
    const total=sent.length;click(notice,true);await pollTelegram(db,users,remote);await telegramAgentStep(db,users,local,remote);assert.equal(decisions.length,2);assert.equal(sent.length,total);
    const rejected=await start();click(rejected,false);await pollTelegram(db,users,remote);await telegramAgentStep(db,users,local,remote);assert.equal((await ui(`/api/workflow-runs/${rejected.run}`)).status,'failed');
    const stale=await start();await ui(`/api/workflow-runs/${stale.run}/approve`,{id:randomUUID(),revision:(await ui(`/api/workflow-runs/${stale.run}`)).revision,accepted:false});click(stale,true);await pollTelegram(db,users,remote);await telegramAgentStep(db,users,local,remote);assert.equal((await ui(`/api/workflow-runs/${stale.run}`)).status,'failed');assert(sent.some(item=>item.text.includes('Persetujuan tidak dapat diterapkan')));
    const revoked=await start();click(revoked,true);await pollTelegram(db,users,remote);await telegramAgentStep(db,new Set([5]),local,remote);assert.equal(db.prepare('SELECT status FROM telegram_callbacks WHERE notice=?').get(revoked.id)!.status,'revoked');assert.equal((await ui(`/api/workflow-runs/${revoked.run}`)).status,'approval');
    assert(acks.some(item=>item.text.includes('pilihan sebelumnya')));
  }finally{db.close();await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('Telegram workflow approval binds requester and recovers lost run and decision responses',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'briefsip-telegram-flow-')),agent=randomUUID(),users=new Set([4,5]);
  const app=await startApp({database:join(dir,'app.sqlite'),scriptDirectory:join(dir,'scripts')});
  const db=new DatabaseSync(':memory:'),sent:any[]=[],requests:any[]=[];let sequence=0,loseRun=true,loseApproval=true,loseCancel=true;
  async function ui(path:string,body?:unknown):Promise<any>{const response=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await response.json();assert(response.ok,JSON.stringify(result));return result;}
  const real=telegramLocal(join(dir,'scripts'));
  const local=async(path:string,body?:unknown,signal?:AbortSignal)=>{const result=await real(path,body,signal);if(body){requests.push({path,body});if(loseRun&&path.endsWith('/run')){loseRun=false;throw new Error('lost run');}if(loseCancel&&path.endsWith('/cancel')){loseCancel=false;throw new Error('lost cancel');}if(loseApproval&&path.endsWith('/approve')){loseApproval=false;throw new Error('lost approval');}}return result;};
  const remote=async(_method:string,body:Record<string,unknown>)=>{sent.push(body);return {message_id:sent.length,chat:{id:body.chat_id}};};
  function incoming(user:number,text:string){sequence++;recordTelegramUpdates(db,[{update_id:sequence,message:{message_id:sequence,chat:{id:user,type:'private'},from:{id:user,is_bot:false},text}}],users);return db.prepare('SELECT * FROM telegram_inbox WHERE update_id=?').get(sequence)!;}
  try{
    await ui('/api/agents',{id:agent,name:'Workflow',model:'fixture',instructions:'Help'});await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true});
    const workflow=await ui(`/api/agents/${agent}/workflows`,{id:randomUUID(),revision:0,name:'Approval',graph:{entry:'approve',maxSteps:2,nodes:[{id:'approve',kind:'approval',prompt:'Proceed?',yes:'out'},{id:'out',kind:'output'}]}});
    initializeTelegram(db);bindTelegram(db,123,agent);
    incoming(4,'/workflows');await telegramAgentStep(db,users,local,remote);assert(sent[0].text.includes(workflow.id));
    const start=incoming(4,`/workflow ${workflow.id} 1 Exact input`);
    await assert.rejects(telegramAgentStep(db,users,local,remote),/lost run/);
    initializeTelegram(db);await telegramAgentStep(db,users,local,remote);
    const runs=requests.filter(row=>row.path.endsWith('/run'));assert.equal(runs.length,2);assert.deepEqual(runs[0],runs[1]);
    assert.equal((await ui(`/api/workflows/${workflow.id}/runs`)).length,1);
    const approval=db.prepare('SELECT * FROM telegram_approvals WHERE run=?').get(start.turn)!;
    const count=sent.length;await telegramAgentStep(db,users,local,remote);assert.equal(sent.length,count);
    incoming(5,`/approve ${start.turn} ${approval.revision} yes`);await telegramAgentStep(db,users,local,remote);assert.equal(requests.filter(row=>row.path.endsWith('/approve')).length,0);
    incoming(4,`/approve ${start.turn} ${approval.revision} yes`);await assert.rejects(telegramAgentStep(db,users,local,remote),/lost approval/);
    initializeTelegram(db);await telegramAgentStep(db,users,local,remote);await telegramAgentStep(db,users,local,remote);
    const decisions=requests.filter(row=>row.path.endsWith('/approve'));assert.equal(decisions.length,2);assert.deepEqual(decisions[0],decisions[1]);
    assert.equal((await ui(`/api/workflow-runs/${start.turn}`)).status,'done');assert(sent.some(row=>row.chat_id===4&&row.text==='Exact input'));
    const stopped=incoming(4,`/workflow ${workflow.id} 1 Stop input`);await telegramAgentStep(db,users,local,remote);
    incoming(5,`/stop ${stopped.turn}`);await telegramAgentStep(db,users,local,remote);assert.equal(requests.filter(row=>row.path.endsWith('/cancel')).length,0);
    incoming(4,`/stop ${stopped.turn}`);await assert.rejects(telegramAgentStep(db,users,local,remote),/lost cancel/);
    initializeTelegram(db);await telegramAgentStep(db,users,local,remote);
    const cancels=requests.filter(row=>row.path.endsWith('/cancel'));assert.equal(cancels.length,2);assert.deepEqual(cancels[0],cancels[1]);
    assert.equal((await ui(`/api/workflow-runs/${stopped.turn}`)).status,'cancelled');
    const rejected=incoming(4,`/workflow ${workflow.id} 1 Reject input`);await telegramAgentStep(db,users,local,remote);
    const pending=db.prepare('SELECT revision FROM telegram_approvals WHERE run=?').get(rejected.turn)!;
    incoming(4,`/approve ${rejected.turn} ${pending.revision} no`);await telegramAgentStep(db,users,local,remote);await telegramAgentStep(db,users,local,remote);
    assert.equal((await ui(`/api/workflow-runs/${rejected.turn}`)).status,'failed');
    incoming(4,`/approve ${rejected.turn} ${pending.revision} yes`);await telegramAgentStep(db,users,local,remote);
    assert.equal((await ui(`/api/workflow-runs/${rejected.turn}`)).status,'failed');assert(sent.some(row=>row.text.includes('Permintaan workflow ditolak')));
    for(let i=0;i<20;i++)await ui(`/api/agents/${agent}/workflows`,{id:randomUUID(),revision:0,name:`Page ${i}`,graph:{entry:'out',maxSteps:1,nodes:[{id:'out',kind:'output'}]}});
    incoming(4,'/workflows');await telegramAgentStep(db,users,local,remote);
    const first=sent.at(-1).text;assert.equal((first.match(/\/workflow /g)||[]).length,20);
    const cursor=/Halaman berikut: \/workflows ([a-f0-9-]{36})/.exec(first)![1];
    incoming(4,`/workflows ${cursor}`);await telegramAgentStep(db,users,local,remote);
    assert.equal((sent.at(-1).text.match(/\/workflow /g)||[]).length,1);


  }finally{db.close();await app.close();rmSync(dir,{recursive:true,force:true});}
});
