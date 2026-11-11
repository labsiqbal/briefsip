import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';
import { DatabaseSync } from 'node:sqlite';

test('provider account switch requires scoped browser consent and survives restart without replay', async () => {
  const directory=mkdtempSync(join(tmpdir(),'briefsip-account-consent-')),calls:{path:string;model:string}[]=[];
  let command:unknown, advertised=false, toolName='set_provider_account', hold=false;
  const provider=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);
    const target=req.url!.startsWith('/b/');assert.equal(req.headers.authorization,target?'Bearer secret-b':'Bearer secret-a');
    calls.push({path:req.url!,model:body.model});advertised=body.tools.some((tool:any)=>tool.function.name==='set_provider_account');
    if(hold)return;
    const result=body.messages.findLast((row:any)=>row.role==='tool');
    res.end(JSON.stringify({choices:[{finish_reason:result?'stop':'tool_calls',message:result?{content:'Account decision recorded'}:{tool_calls:[{id:'account',type:'function',function:{name:toolName,arguments:JSON.stringify(command)}}]}}]}));
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();assert(address&&typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}`,accounts=[{id:'a',name:'Account A',provider:'openai-compatible',baseURL:base+'/a/v1',apiKey:'secret-a'},{id:'b',name:'Account B',provider:'openai-compatible',baseURL:base+'/b/v1',apiKey:'secret-b'}];
  const options={database:join(directory,'db.sqlite'),port:0,accounts,scriptToken:'script-secret-abcdefghijklmnopqrstuvwxyz'};let app=await startApp(options);
  async function request(path:string,body?:unknown,status=200,script=false){const response=await fetch(app.origin+path,{method:body?'POST':'GET',headers:script?{Authorization:'Bearer script-secret-abcdefghijklmnopqrstuvwxyz','Content-Type':'application/json'}:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await response.json();assert(status===200 ? response.ok : response.status===status,JSON.stringify(data));return data;}
  async function until(path:string,id:string,predicate:(row:any)=>boolean){for(let n=0;n<300;n++){const row=(await request(path+'/turns')).find((item:any)=>item.id===id);if(row&&predicate(row))return row;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out');}
  try {
    const agent=await request('/api/agents',{id:randomUUID(),name:'Owner',instructions:'Help',model:'old',backupModel:'fallback',providerAccount:'a'}),path=`/api/agents/${agent.id}`;
    const profile=async()=>(await request('/api/agents')).agents.find((row:any)=>row.id===agent.id);
    async function pending(revision:number,location=path){command={revision,providerAccount:'b',model:'new'};const id=randomUUID();await request(location+'/turns',{id,text:'Switch to B'});const row=await until(location,id,row=>row.questions?.length||row.status==='failed');return {id,row,answerPath:`${location}/turns/${id}/questions/${row.questions?.[0]?.id}/answer`};}
    const first=await pending(1);assert(advertised);assert.equal(first.row.paused,1);assert.match(first.row.questions[0].prompt,/Account B/);assert.match(first.row.questions[0].prompt,/Riwayat dan lampiran/);assert(!JSON.stringify(first.row.questions).includes('secret-b'));
    assert.equal((await profile()).provider_account,'a');assert(calls.every(call=>call.path.startsWith('/a/')));
    await request(path+'/scripts',{id:randomUUID(),revision:0,enabled:true});
    await request(`/api/scripts/agents/${agent.id}/turns/${first.id}/questions/${first.row.questions[0].id}/answer`,{id:randomUUID(),text:'Setujui perpindahan'},403,true);
    const busySide=await request(path+'/threads',{id:randomUUID(),name:'Busy'}),busyPath=`/api/threads/${busySide.id}`,busy=randomUUID();hold=true;
    await request(busyPath+'/turns',{id:busy,text:'Hold'});await until(busyPath,busy,row=>row.status==='running');
    await request(first.answerPath,{id:randomUUID(),text:'Setujui perpindahan'},409);assert.equal((await profile()).provider_account,'a');
    await request(`${busyPath}/turns/${busy}/cancel`,{id:randomUUID()});hold=false;
    await app.close();
    let db=new DatabaseSync(options.database);db.exec("CREATE TRIGGER reject_consent_receipt BEFORE INSERT ON question_answers BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END");db.close();
    app=await startApp(options);
    const answer={id:randomUUID(),text:'Setujui perpindahan',acknowledgeUncertain:true};
    await request(first.answerPath,answer,500);assert.equal((await profile()).provider_account,'a');assert.equal((await profile()).backup_model,'fallback');assert.equal((await profile()).revision,1);
    assert.equal((await request(path+'/turns')).find((row:any)=>row.id===first.id).questions[0].answer,null);assert(calls.every(call=>call.path.startsWith('/a/')));
    await app.close();db=new DatabaseSync(options.database);db.exec('DROP TRIGGER reject_consent_receipt');db.close();app=await startApp(options);
    await request(first.answerPath,answer);
    await until(path,first.id,row=>row.status==='done');assert.equal((await profile()).provider_account,'b');assert.equal((await profile()).model,'new');assert.equal((await profile()).backup_model,'');assert.deepEqual(calls.at(-1),{path:'/b/v1/chat/completions',model:'new'});
    const count=calls.length;await request(first.answerPath,answer);assert.equal(calls.length,count);assert.equal((await profile()).revision,2);
    await request(path+'/edit',{id:randomUUID(),revision:2,name:'Owner',instructions:'Help',model:'old',providerAccount:'a'});
    const side=await request(path+'/threads',{id:randomUUID(),name:'Side'}),sidePath=`/api/threads/${side.id}`,rejected=await pending(3,sidePath);
    await request(rejected.answerPath,{id:randomUUID(),text:'Batal'});await until(sidePath,rejected.id,row=>row.status==='done');assert.equal((await profile()).provider_account,'a');
    const stale=await pending(3);
    toolName='set_provider_model';command={revision:3,model:'changed'};const editing=randomUUID();await request(sidePath+'/turns',{id:editing,text:'Change model'});await until(sidePath,editing,row=>row.status==='done');toolName='set_provider_account';
    await request(stale.answerPath,{id:randomUUID(),text:'Setujui perpindahan',acknowledgeUncertain:true},409);assert.equal((await profile()).provider_account,'a');
    await request(stale.answerPath,{id:randomUUID(),text:'Batal',acknowledgeUncertain:true});await until(path,stale.id,row=>row.status==='done');
    const changed=await pending(4);await app.close();app=await startApp({...options,accounts:[accounts[0],{...accounts[1],baseURL:base+'/changed/v1'}]});
    await request(changed.answerPath,{id:randomUUID(),text:'Setujui perpindahan',acknowledgeUncertain:true},409);assert.equal((await profile()).revision,4);
    await request(changed.answerPath,{id:randomUUID(),text:'Batal',acknowledgeUncertain:true});await until(path,changed.id,row=>row.status==='done');
    const room=await request('/api/channels',{id:randomUUID(),name:'Room',members:[agent.id],lead:agent.id,instructions:'Help'});
    const denied=await pending(4,`/api/channels/${room.id}`);assert.equal(denied.row.status,'failed');assert(!advertised);assert.equal((await profile()).revision,4);
  } finally {await app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});}
});
