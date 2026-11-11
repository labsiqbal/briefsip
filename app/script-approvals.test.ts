import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';

test('script approval binds agent and revision, preserves receipts and refuses revoked or deleted streamed retries', async () => {
  const dir=mkdtempSync(join(tmpdir(),'briefsip-script-approval-')), token=randomBytes(32).toString('base64url');
  const options={database:join(dir,'db.sqlite'),scriptToken:token};let app=await startApp(options);
  const auth={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  async function request(path:string,body?:unknown,status?:number,headers?:Record<string,string>):Promise<any>{
    const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:headers??{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await res.json();
    if(status)assert.equal(res.status,status,JSON.stringify(result));else assert(res.ok,JSON.stringify(result));return result;
  }
  function streamed(path:string,body:Record<string,unknown>){let finish!:()=>void;const result=new Promise<number|undefined>((resolve,reject)=>{const req=httpRequest(app.origin+path,{method:'POST',headers:auth},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);const raw=JSON.stringify(body);req.write(raw.slice(0,-1));finish=()=>req.end('}');});return {finish,result};}
  try {
    const a=await request('/api/agents',{id:randomUUID(),name:'A',model:'fixture',instructions:'Help'}),b=await request('/api/agents',{id:randomUUID(),name:'B',model:'fixture',instructions:'Help'});
    const list=`/api/scripts/agents/${a.id}/approvals`,permission=`/api/agents/${a.id}/scripts`;
    await request(list,undefined,403,auth);await request(permission,{id:randomUUID(),revision:0,enabled:true});await request(`/api/agents/${b.id}/scripts`,{id:randomUUID(),revision:0,enabled:true});
    const graph={entry:'first',maxSteps:3,nodes:[{id:'first',kind:'approval',prompt:'First?',yes:'second'},{id:'second',kind:'approval',prompt:'Second?',yes:'out'},{id:'out',kind:'output'}]};
    const workflow=await request(`/api/agents/${a.id}/workflows`,{id:randomUUID(),revision:0,name:'Review',graph});
    const run=await request(`/api/workflows/${workflow.id}/run`,{id:randomUUID(),revision:1,input:'Safe input'});
    const pending=(await request(list,undefined,200,auth)).approvals[0];assert.equal(pending.run,run.id);assert.equal(pending.prompt,'First?');assert.equal(pending.input,'Safe input');
    assert.deepEqual((await request(`/api/scripts/agents/${b.id}/approvals`,undefined,200,auth)).approvals,[]);
    const path=`/api/scripts/agents/${a.id}/workflow-runs/${run.id}/approve`, decision={id:randomUUID(),revision:pending.revision,accepted:true};
    await request(path,decision,403,{...auth,Origin:app.origin});await request(`/api/scripts/agents/${b.id}/workflow-runs/${run.id}/approve`,decision,404,auth);
    await request(path,{...decision,accepted:'yes'},400,auth);await request(path,{...decision,extra:true},400,auth);
    const result=await request(path,decision,200,auth);assert.deepEqual(await request(path,decision,200,auth),result);
    const next=(await request(list,undefined,200,auth)).approvals[0];assert.equal(next.step,'second');assert.notEqual(next.revision,pending.revision);
    await request(path,{...decision,id:randomUUID()},409,auth);
    await app.close();app=await startApp(options);assert.deepEqual(await request(path,decision,200,auth),result);
    assert.equal((await request(list,undefined,200,auth)).approvals[0].step,'second');
    const held=streamed(path,{id:randomUUID(),revision:next.revision,accepted:true});
    await request(permission,{id:randomUUID(),revision:1,enabled:false});held.finish();assert.equal(await held.result,403);
    await request(list,undefined,403,auth);await request(path,decision,403,auth);
    await request(permission,{id:randomUUID(),revision:2,enabled:true});
    const reject={id:randomUUID(),revision:next.revision,accepted:false};await request(path,reject,200,auth);
    assert.equal((await request(`/api/workflow-runs/${run.id}`)).status,'failed');assert.deepEqual((await request(list,undefined,200,auth)).approvals,[]);
    const deleted=streamed(path,reject);await request(`/api/workflows/${workflow.id}/delete`,{id:randomUUID(),revision:1});deleted.finish();assert.equal(await deleted.result,404);
  } finally {await app.close();rmSync(dir,{recursive:true,force:true});}
});
