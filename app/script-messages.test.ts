import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';

test('script messages and answers share grants, scope, receipts, redaction and rate admission', async t => {
  // Keep admission checks within one rate window even on a busy host.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-script-messages-')), token = randomBytes(32).toString('base64url'); let calls = 0;
  const provider = createServer(async (req,res) => {
    let raw=''; for await (const chunk of req) raw+=chunk; calls++;
    const messages=JSON.parse(raw).messages;
    const asking=messages.at(-1).content === 'ASK';
    res.end(JSON.stringify({ choices: [{ finish_reason: asking ? 'tool_calls' : 'stop', message: asking ? { tool_calls: [{ id: 'ask', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: 'Proceed?', choices: ['Yes','No'] }) } }] } : { content: `Done ${token}` } }] }));
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const address=provider.address(); assert(address && typeof address!=='string');
  const options={ database:join(dir,'db.sqlite'),baseURL:`http://127.0.0.1:${address.port}/v1`,scriptToken:token };
  let app=await startApp(options);
  const auth={ Authorization:`Bearer ${token}`,'Content-Type':'application/json' };
  async function request(path:string,body?:unknown,status?:number,headers?:Record<string,string>):Promise<any> {
    const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:headers??{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    const result=await res.json(); if(status) assert.equal(res.status,status,JSON.stringify(result)); else assert(res.ok,JSON.stringify(result)); return result;
  }
  async function until(check:()=>Promise<boolean>){for(let n=0;n<200;n++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out');}
  try {
    const a=await request('/api/agents',{runtime:'api', id:randomUUID(),name:'A',model:'fixture',instructions:'Help'});
    const b=await request('/api/agents',{runtime:'api', id:randomUUID(),name:'B',model:'fixture',instructions:'Help'});
    const path=`/api/scripts/agents/${a.id}/turns`, uiPath=`/api/agents/${a.id}/turns`, permission=`/api/agents/${a.id}/scripts`;
    const command={id:randomUUID(),text:'ASK'};
    await request(path,command,403,auth);
    await request(permission,{id:randomUUID(),revision:0,enabled:true});
    await request(path,command,403,{...auth,Origin:app.origin});
    await request(path,command,403,{'Content-Type':'application/json',Authorization:'Bearer wrong'});
    await request(path,command,202,auth);
    await until(async()=>!!(await request(path,undefined,200,auth))[0]?.questions?.length);
    const turn=(await request(path,undefined,200,auth))[0]; const question=turn.questions[0];
    const answerPath=`${path}/${turn.id}/questions/${question.id}/answer`, answer={id:randomUUID(),text:'Yes'};
    await request(`/api/agents/${b.id}/scripts`,{id:randomUUID(),revision:0,enabled:true});
    await request(`/api/scripts/agents/${b.id}/turns/${turn.id}/questions/${question.id}/answer`,answer,404,auth);
    await request(permission,{id:randomUUID(),revision:1,enabled:false});
    await request(answerPath,answer,403,auth); await request(path,undefined,403,auth);
    await request(permission,{id:randomUUID(),revision:2,enabled:true});
    const accepted=await request(answerPath,answer,200,auth); assert.deepEqual(await request(answerPath,answer,200,auth),accepted);
    await until(async()=>(await request(path,undefined,200,auth))[0]?.status==='done');
    const result=(await request(path,undefined,200,auth))[0]; assert.equal(result.reply,'Done [redacted]'); assert.equal(calls,2);
    await app.close();app=await startApp(options);
    await request(path,command,202,auth); assert.deepEqual(await request(answerPath,answer,200,auth),accepted);assert.equal(calls,2);
    await request(answerPath,{...answer,text:'No'},409,auth);
    await request(`/api/agents/${a.id}/visibility`,{id:randomUUID(),revision:0,hidden:true});
    await request(path,{id:randomUUID(),text:'Hidden'},409,auth);
    await request(`/api/agents/${a.id}/visibility`,{id:randomUUID(),revision:1,hidden:false});
    let release!:()=>void;
    const streamed=new Promise<number|undefined>((resolve,reject)=>{
      const req=httpRequest(app.origin+path,{method:'POST',headers:auth},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));}); req.on('error',reject);
      req.write('{"id":"'+randomUUID()+'","text":'); release=()=>req.end('"Too late"}');
    });
    await request(permission,{id:randomUUID(),revision:3,enabled:false}); release(); assert.equal(await streamed,403);
    await request(permission,{id:randomUUID(),revision:4,enabled:true});
    const routine=await request(`/api/agents/${a.id}/routines`,{id:randomUUID(),name:'Script',prompt:'RUN',nextAt:Date.now()+3600000,intervalSeconds:null,enabled:false});
    await request(`/api/scripts/routines/${routine.id}/run`,{id:randomUUID(),revision:routine.revision,payload:''},200,auth);
    for(let n=0;n<58;n++) await request(path,{id:randomUUID(),text:`Message ${n}`},202,auth);
    await request(path,{id:randomUUID(),text:'Limited'},429,auth);
    await request(path,command,202,auth);
    assert((await request(uiPath)).length<=59);
    const threadsPath=`/api/scripts/agents/${b.id}/threads`, createSide={id:randomUUID(),name:'Script side'};
    const side=await request(threadsPath,createSide,200,auth);assert.deepEqual(await request(threadsPath,createSide,200,auth),side);
    assert((await request(threadsPath,undefined,200,auth)).some((row:any)=>row.id===side.id));
    const sidePath=`${threadsPath}/${side.id}/turns`, sideMessage={id:randomUUID(),text:'ASK'};
    await request(`/api/scripts/agents/${a.id}/threads/${side.id}/turns`,sideMessage,404,auth);
    await request(sidePath,sideMessage,202,auth);
    await until(async()=>!!(await request(sidePath,undefined,200,auth))[0]?.questions?.length);
    const sideTurn=(await request(sidePath,undefined,200,auth))[0], sideAnswer={id:randomUUID(),text:'No'};
    await request(`/api/scripts/agents/${b.id}/turns/${sideTurn.id}/questions/${sideTurn.questions[0].id}/answer`,sideAnswer,404,auth);
    const sideAnswerPath=`${sidePath}/${sideTurn.id}/questions/${sideTurn.questions[0].id}/answer`;
    await request(sideAnswerPath,sideAnswer,200,auth);
    await until(async()=>(await request(sidePath,undefined,200,auth))[0]?.status==='done');
    assert.deepEqual(await request(`/api/scripts/agents/${b.id}/turns`,undefined,200,auth),[]);
    await until(async()=>(await request(uiPath)).every((row:any)=>['done','failed','cancelled','interrupted'].includes(row.status)));
    const sideCalls=calls;await app.close();app=await startApp(options);
    await request(sidePath,sideMessage,202,auth);await request(sideAnswerPath,sideAnswer,200,auth);assert.equal(calls,sideCalls);
    const stopTurn={id:randomUUID(),text:'ASK'};await request(sidePath,stopTurn,202,auth);
    await until(async()=>(await request(sidePath,undefined,200,auth)).some((row:any)=>row.id===stopTurn.id&&row.questions?.length));
    const stopPath=`${sidePath}/${stopTurn.id}/cancel`,stopBody={id:randomUUID()};
    await request(stopPath,undefined,405,auth);
    await request(`/api/scripts/agents/${a.id}/threads/${side.id}/turns/${stopTurn.id}/cancel`,stopBody,404,auth);
    assert.equal((await request(stopPath,stopBody,200,auth)).status,'cancelled');
    assert.equal((await request(stopPath,stopBody,200,auth)).status,'cancelled');
    let finishDeletedReplay!:()=>void;
    const deletedReplay=new Promise<number|undefined>((resolve,reject)=>{
      const req=httpRequest(app.origin+sidePath,{method:'POST',headers:auth},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);
      req.write('{"id":"'+sideMessage.id+'","text":');finishDeletedReplay=()=>req.end('"ASK"}');
    });
    await request(`/api/threads/${side.id}/edit`,{id:randomUUID(),revision:side.revision,name:side.name,archived:true});
    await request(sidePath,{id:randomUUID(),text:'Archived'},409,auth);
    await request(`/api/threads/${side.id}/delete`,{id:randomUUID(),revision:side.revision+1});
    finishDeletedReplay();assert.equal(await deletedReplay,404);
    await request(sidePath,undefined,404,auth);await request(sidePath,sideMessage,404,auth);
    await request(`/api/agents/${b.id}/scripts`,{id:randomUUID(),revision:1,enabled:false});
    await request(threadsPath,createSide,403,auth);await request(threadsPath,undefined,403,auth);
  } finally {await app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
