import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startApp} from './server.ts';
import {initializeTelegram,bindTelegram,recordTelegramUpdates} from './telegram.ts';
import {telegramLocal,telegramAgentStep} from './telegram-bridge.ts';

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
    assert.equal((await ui(`/api/workflow-runs/${rejected.turn}`)).status,'failed');assert(sent.some(row=>row.text.includes('Workflow request denied')));
    for(let i=0;i<20;i++)await ui(`/api/agents/${agent}/workflows`,{id:randomUUID(),revision:0,name:`Page ${i}`,graph:{entry:'out',maxSteps:1,nodes:[{id:'out',kind:'output'}]}});
    incoming(4,'/workflows');await telegramAgentStep(db,users,local,remote);
    const first=sent.at(-1).text;assert.equal((first.match(/\/workflow /g)||[]).length,20);
    const cursor=/Next page: \/workflows ([a-f0-9-]{36})/.exec(first)![1];
    incoming(4,`/workflows ${cursor}`);await telegramAgentStep(db,users,local,remote);
    assert.equal((sent.at(-1).text.match(/\/workflow /g)||[]).length,1);


  }finally{db.close();await app.close();rmSync(dir,{recursive:true,force:true});}
});
