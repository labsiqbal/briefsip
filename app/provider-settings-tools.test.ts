import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';

test('provider settings read stays private and excludes endpoint and credentials', async () => {
  const directory=mkdtempSync(join(tmpdir(),'briefsip-provider-read-')), secret=randomUUID();
  let args:unknown={},result:any,advertised=false;
  const provider=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,`Bearer ${secret}`);
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw),last=body.messages.findLast((row:any)=>row.role==='tool');
    advertised=body.tools.some((row:any)=>row.function.name==='read_provider_settings');
    if(last)result=JSON.parse(last.content);
    res.end(JSON.stringify({choices:[{finish_reason:last?'stop':'tool_calls',message:last?{content:'Configuration read.'}:{tool_calls:[{id:'settings',type:'function',function:{name:'read_provider_settings',arguments:JSON.stringify(args)}}]}}]}));
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();assert(address&&typeof address!=='string');
  const baseURL=`http://127.0.0.1:${address.port}/v1`,app=await startApp({database:join(directory,'db.sqlite'),port:0,baseURL,apiKey:secret});
  async function request(path:string,body?:unknown){const response=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await response.json();assert(response.ok,JSON.stringify(data));return data;}
  async function run(path:string,status='done'){const id=randomUUID();await request(path+'/turns',{id,text:'Read settings'});for(let n=0;n<200;n++){const row=(await request(path+'/turns')).find((entry:any)=>entry.id===id);if(row?.status===status)return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out');}
  try {
    const agent=await request('/api/agents',{id:randomUUID(),name:'Reader',model:'fixture',backupModel:'backup',instructions:'Help'}),path=`/api/agents/${agent.id}`;
    const side=await request(path+'/threads',{id:randomUUID(),name:'Side'}),room=await request('/api/channels',{id:randomUUID(),name:'Room',members:[agent.id],lead:agent.id,instructions:'Help'});
    for(const location of [path,`/api/threads/${side.id}`]){await run(location);assert(advertised);assert.deepEqual(result,{revision:1,providerAccount:'',model:'fixture',backupModel:'backup',configured:true});assert(!JSON.stringify(result).includes(secret));assert(!JSON.stringify(result).includes(baseURL));}
    args={agent:randomUUID()};await run(path,'failed');args={};await run(`/api/channels/${room.id}`,'failed');assert.equal(advertised,false);
    assert.equal((await request('/api/agents')).agents[0].revision,1);
  } finally {await app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});}
});
