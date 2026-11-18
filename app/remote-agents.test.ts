import { remoteRoster, peerAgentRole } from './remote-agents.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './test-bridge.ts';
import { restoreRemoteMessage } from './remote-message-command.ts';

type App=Awaited<ReturnType<typeof startApp>>;
test('remote message recovery keeps exact target, ID and payload and rejects corrupt storage',()=>{
  const machine=randomUUID(),agent=randomUUID(),command={id:randomUUID(),machine,agent,text:'Keep this request.'};
  assert.equal(restoreRemoteMessage(null,machine,agent),null);
  assert.deepEqual(restoreRemoteMessage(JSON.stringify(command),machine,agent),command);
  for(const raw of ['{bad','null','[]',JSON.stringify({...command,machine:randomUUID()}),JSON.stringify({...command,agent:randomUUID()}),JSON.stringify({...command,id:'bad'}),JSON.stringify({...command,text:' '.repeat(16)}),JSON.stringify({...command,text:'x'.repeat(16_001)}),JSON.stringify({...command,extra:true})])assert.throws(()=>restoreRemoteMessage(raw,machine,agent));
});
async function api(app:App,path:string,body?:unknown,status=200):Promise<any>{const r=await fetch(app.origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:app.origin,'Content-Type':'application/json',Connection:'close'},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;}
async function until(check:()=>Promise<any>){const end=Date.now()+20000;while(Date.now()<end){const result=await check();if(result)return result;await new Promise(r=>setTimeout(r,30));}assert.fail('Remote fixture timed out');}
async function fixture(script:(body:any)=>any,limits={}){
  const dir=mkdtempSync(join(tmpdir(),'briefsip-remote-agents-'));
  const provider=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;try{const result=await script(JSON.parse(raw)),message=typeof result==='string'?{content:result}:{tool_calls:[{id:randomUUID(),type:'function',function:{name:result.name,arguments:JSON.stringify(result.args)}}]};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:typeof result==='string'?'stop':'tool_calls',message}]}));}catch{res.writeHead(500);res.end('{}');}});
  await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const address=provider.address();assert(address&&typeof address!=='string');
  const common={baseURL:`http://127.0.0.1:${address.port}/v1`,agentLimits:limits}, aOptions={...common,database:join(dir,'a.sqlite')},bOptions={...common,database:join(dir,'b.sqlite')};let a=await startApp(aOptions),b=await startApp(bOptions);
  await api(a,'/api/environment',{id:randomUUID(),name:'A'});await api(b,'/api/environment',{id:randomUUID(),name:'B'});
  const alpha=await api(a,'/api/agents',{runtime:'api', id:randomUUID(),name:'Alpha',model:'Alpha',instructions:'Help.'},201),beta=await api(b,'/api/agents',{runtime:'api', id:randomUUID(),name:'Beta',role:'Personal agent',model:'Beta',instructions:'Help.'},201);
  const code=await api(b,'/api/pairing-codes',{id:randomUUID()});const machine=await api(a,'/api/machines',{id:randomUUID(),origin:b.origin,code:code.code});
  return {dir,alpha,beta,machine,get a(){return a;},get b(){return b;},aOptions,bOptions,async restartA(){const port=Number(new URL(a.origin).port);await a.close();a=await startApp({...aOptions,port});},async restartB(){const port=Number(new URL(b.origin).port);await b.close();b=await startApp({...bOptions,port});},async close(){await a.close().catch(()=>{});await b.close().catch(()=>{});provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(dir,{recursive:true,force:true});}};
}
const tools=(body:any)=>body.messages.filter((row:any)=>row.role==='tool').map((row:any)=>JSON.parse(row.content));
for(const mode of ['message','wait','completion','restart-a','restart-b'])test(`paired real MCP remote agents: ${mode}`,async()=>{
  let release=()=>{},calls=0,wakes=0;const held=new Promise<void>(r=>release=r);let beta='';
  const f=await fixture(async body=>{if(body.model==='Beta'){calls++;await held;return 'Remote Beta reply';}if(JSON.stringify(body.messages).includes('Delegated task completed')){wakes++;return 'Completion received';}const results=tools(body);if(!results.length)return mode==='message'?{name:'send_message',args:{recipients:['Beta@B'],text:'Remote work',expects_reply:true}}:{name:'delegate_task',args:{agent:'Beta@B',task:'Remote work',wait:mode!=='completion'&&mode!=='wait'}};if(mode==='wait'&&results.at(-1).status==='queued')return {name:'wait_task',args:{taskId:results.at(-1).taskId,timeoutSeconds:600}};return JSON.stringify(results.at(-1));});
  beta=f.beta.id;
  try{
    const id=randomUUID(),path=`/api/agents/${f.alpha.id}/turns`;await api(f.a,path,{id,text:'Start'},202);
    await until(async()=>calls===1);
    const inbound=await until(async()=>{const threads=await api(f.b,`/api/agents/${beta}/threads`);if(!threads.length)return null;const rows=await api(f.b,`/api/threads/${threads[0].id}/turns`);return rows.find((row:any)=>row.origin==='peer:Briefsip: A')});assert.equal(inbound.message_depth,1);
    const inboundThreads=await api(f.b,`/api/agents/${beta}/threads`);assert.equal(inboundThreads[0].delivery,true);assert.equal(inboundThreads[0].name,'Briefsip on A: Remote work');
    const outboundThreads=await api(f.a,`/api/agents/${f.alpha.id}/threads`);assert.equal(outboundThreads[0].delivery,true);assert.equal(outboundThreads[0].name,'Beta on B: Remote work');
    assert.equal(f.machine.agents[0].role, 'Personal agent');
    await until(async()=>{return (await api(f.a,path)).some((row:any)=>row.id===id&&row.agentMessages?.length);});
    if(mode==='restart-a')await f.restartA();if(mode==='restart-b')await f.restartB();release();
    const row=await until(async()=>{const rows=await api(f.a,path);return rows.find((row:any)=>mode==='completion'?row.reply==='Completion received':row.id===id&&row.status==='done');});
    if(mode==='completion'){assert.equal(wakes,1);await f.restartA();assert.equal((await api(f.a,path)).filter((r:any)=>r.reply==='Completion received').length,1);}else if(mode==='restart-b')assert.match(row.reply,/uncertain/);else assert.match(row.reply,/Remote Beta reply/);
    assert.equal(calls,1);assert.equal(row.agentMessages?.[0]?.name ?? 'Beta on B','Beta on B');
  }finally{release();await f.close();}
});

test('remote cancel stops peer delivery, is peer-scoped, and unpaired addresses are unreachable',async()=>{
  let target='',childCalls=0,release=()=>{};const held=new Promise<void>(r=>release=r);
  const f=await fixture(async body=>{if(body.model==='Beta'){childCalls++;await held;return 'Too late';}const rs=tools(body);if(!rs.length)return {name:'delegate_task',args:{agent:'Beta@B',task:'Cancel work'}};if(rs.length===1){await until(async()=>childCalls===1);return {name:'cancel_task',args:{taskId:rs[0].taskId}};}return JSON.stringify(rs.at(-1));});
  try{const path=`/api/agents/${f.alpha.id}/turns`,id=randomUUID();await api(f.a,path,{id,text:'Cancel'},202);const row=await until(async()=>{const rows=await api(f.a,path);return rows.find((r:any)=>r.id===id&&r.status==='done');});assert.match(row.reply,/cancelled/);await until(async()=>{const threads=await api(f.b,`/api/agents/${f.beta.id}/threads`);if(!threads.length)return false;return (await api(f.b,`/api/threads/${threads[0].id}/turns`))[0]?.status==='cancelled';});
    await api(f.a,'/api/remote-agents/messages',{id:randomUUID(),machine:randomUUID(),agent:f.beta.id,text:'Unpaired'},409);
  }finally{release();await f.close();}
});

test('kill switch rejects immediately and loop limits count peer and agent across requests',async()=>{
  const f=await fixture(()=> 'Reply',{rate:2,depth:2});
  const send=async(text:string)=>{const id=randomUUID();await api(f.a,'/api/remote-agents/messages',{id,machine:f.machine.id,agent:f.beta.id,text});return until(async()=>{const rs=await api(f.a,`/api/remote-agents/messages?machine=${f.machine.id}&agent=${f.beta.id}`);return rs.messages.find((r:any)=>r.id===id&&['done','failed','interrupted'].includes(r.status));});};
  try{const back=(await api(f.b,'/api/machines')).machines[0];assert.equal(back.allowAgentMessaging,true);await api(f.b,'/api/machines/agent-messaging',{id:randomUUID(),environmentId:back.id,allowed:false});await f.a.refreshMachines();assert.equal((await api(f.a,'/api/machines')).machines[0].remoteAgentMessaging,false);const blocked=await send('Blocked');assert.equal(blocked.status,'failed');assert.match(blocked.error,/disabled/);assert.equal((await api(f.b,`/api/agents/${f.beta.id}/threads`)).length,0);
    await api(f.b,'/api/machines/agent-messaging',{id:randomUUID(),environmentId:back.id,allowed:true});await f.a.refreshMachines();assert.equal((await api(f.a,'/api/machines')).machines[0].remoteAgentMessaging,true);assert.equal((await send('One')).status,'done');assert.equal((await send('Two')).status,'done');const rate=await send('Three');assert.equal(rate.status,'failed');assert.match(rate.error,/rate limit/);await f.restartB();const cool=await send('Four');assert.equal(cool.status,'failed');assert.match(cool.error,/rate limit/);
  }finally{await f.close();}
});

test('delegation depth travels across machines and stops ping-pong',async()=>{
  let requests=0;
  const f=await fixture(body=>{requests++;const rs=tools(body);if(rs.length)return JSON.stringify(rs.at(-1));return {name:'delegate_task',args:{agent:body.model==='Alpha'?'Beta@B':'Alpha@A',task:'Continue',wait:true}};},{depth:2,rate:10});
  try{await f.b.refreshMachines();const id=randomUUID(),path=`/api/agents/${f.alpha.id}/turns`;await api(f.a,path,{id,text:'Start loop'},202);const row=await until(async()=>{const rows=await api(f.a,path);return rows.find((r:any)=>r.id===id&&r.status==='done');});assert.match(row.reply,/depth/);assert.equal(requests,6);}
  finally{await f.close();}
});

test('offline send remains explicitly uncertain across caller restart without replay',async()=>{
  let requests=0;
  const f=await fixture(()=>{requests++;return 'Reply';});
  try{await f.b.close();const id=randomUUID();await api(f.a,'/api/remote-agents/messages',{id,machine:f.machine.id,agent:f.beta.id,text:'Offline'});const uncertain=await until(async()=>{const rows=(await api(f.a,`/api/remote-agents/messages?machine=${f.machine.id}&agent=${f.beta.id}`)).messages;return rows.find((r:any)=>r.id===id&&r.state==='uncertain');});assert.match(uncertain.error,/uncertain/);await f.restartA();await api(f.a,'/api/remote-agents/messages',{id,machine:f.machine.id,agent:f.beta.id,text:'Offline'});await new Promise(r=>setTimeout(r,500));assert.equal(requests,0);
  }finally{await f.close();}
});

for(const mode of ['lost-ack','restart-sending'])test(`accepted remote send is never replayed: ${mode}`,async()=>{
  let requests=0,acceptedResolve=()=>{},release=()=>{};const accepted=new Promise<void>(r=>acceptedResolve=r),held=new Promise<void>(r=>release=r);
  const f=await fixture(()=>{requests++;return 'Accepted once';});const original=globalThis.fetch;let intercepted=false;
  globalThis.fetch=async(input,init)=>{const response=await original(input,init);if(!intercepted&&String(input)===f.b.origin+'/mcp'&&typeof init?.body==='string'){const body=JSON.parse(init.body);if(body.method==='tools/call'&&body.params.name==='send_message'){intercepted=true;await response.text();acceptedResolve();if(mode==='restart-sending')await held;throw new Error('Fixture lost acknowledgement');}}return response;};
  try{const id=randomUUID(),command={id,machine:f.machine.id,agent:f.beta.id,text:'Once'};await api(f.a,'/api/remote-agents/messages',command);await accepted;
    if(mode==='restart-sending'){const restart=f.restartA();release();await restart;}else await until(async()=>{const rows=(await api(f.a,`/api/remote-agents/messages?machine=${f.machine.id}&agent=${f.beta.id}`)).messages;return rows.some((r:any)=>r.id===id&&r.state==='uncertain');});
    globalThis.fetch=original;await f.restartA();await api(f.a,'/api/remote-agents/messages',command);await new Promise(r=>setTimeout(r,500));assert.equal(requests,1);assert.equal((await api(f.b,`/api/agents/${f.beta.id}/threads`)).length,1);const messages=(await api(f.a,`/api/remote-agents/messages?machine=${f.machine.id}&agent=${f.beta.id}`)).messages;assert.equal(messages[0].state,'uncertain');
  }finally{globalThis.fetch=original;release();await f.close();}
});

test('peer tokens never enter database bytes, logs, or outbound message responses',async()=>{
  const tokens:string[]=[],logs:string[]=[];const original=globalThis.fetch,log=console.error;
  globalThis.fetch=async(input,init)=>{const response=await original(input,init);if(String(input).endsWith('/api/pairing/redeem')){const value=await response.clone().json();if(value.token)tokens.push(value.token);}if(String(input).endsWith('/api/machines/reciprocal')&&typeof init?.body==='string')tokens.push(JSON.parse(init.body).token);return response;};console.error=(...args)=>{logs.push(args.map(String).join(' '));};
  const f=await fixture(()=> 'Safe reply');
  try{const id=randomUUID();await api(f.a,'/api/remote-agents/messages',{id,machine:f.machine.id,agent:f.beta.id,text:'Canary'});const response=await until(async()=>{const rows=(await api(f.a,`/api/remote-agents/messages?machine=${f.machine.id}&agent=${f.beta.id}`)).messages;return rows.find((r:any)=>r.status==='done');});assert.equal(tokens.length,2);for(const token of tokens){assert(!JSON.stringify(response).includes(token));assert(!logs.join('\n').includes(token));}await f.a.close();await f.b.close();for(const file of readdirSync(f.dir).filter(file=>!file.endsWith('-key'))){const bytes=readFileSync(join(f.dir,file));for(const token of tokens)assert(!bytes.includes(Buffer.from(token)),`Token leaked into ${file}`);}}
  finally{globalThis.fetch=original;console.error=log;await f.close();}
});

test('kill switch cancels an active peer turn before any more remote work is admitted',async()=>{
  let started=false,release=()=>{};const held=new Promise<void>(r=>release=r);const f=await fixture(async()=>{started=true;await held;return 'Old work';});
  try{const id=randomUUID();await api(f.a,'/api/remote-agents/messages',{id,machine:f.machine.id,agent:f.beta.id,text:'Running'});await until(async()=>started);const peer=(await api(f.b,'/api/machines')).machines[0];await api(f.b,'/api/machines/agent-messaging',{id:randomUUID(),environmentId:peer.id,allowed:false});const row=await until(async()=>{const rows=(await api(f.a,`/api/remote-agents/messages?machine=${f.machine.id}&agent=${f.beta.id}`)).messages;return rows.find((r:any)=>r.id===id&&r.status==='cancelled');});assert.match(row.error,/disabled/);}
  finally{release();await f.close();}
});

import { resolveAgentTarget } from './test-support/agent-delegation.ts';
test('address resolution keeps exact IDs, refuses ambiguous names and excludes offline rosters',()=>{
  const db=new DatabaseSync(':memory:'),agent=randomUUID(),host=randomUUID();
  try{db.exec('CREATE TABLE agents(id TEXT,name TEXT); CREATE TABLE paired_machines(environment_id TEXT,name TEXT,state TEXT,status TEXT,agents TEXT)');db.prepare('INSERT INTO paired_machines VALUES (?,?,?,?,?)').run(host,'B','paired','online',JSON.stringify([{id:agent,name:'Beta',role:'Personal agent',model:'fixture',status:'idle'}]));assert.deepEqual(resolveAgentTarget('Beta@B',db),{kind:'remote',machine:host,agent});assert.deepEqual(resolveAgentTarget(`${agent}@${host}`,db),{kind:'remote',machine:host,agent});assert.equal(resolveAgentTarget('Beta@Unpaired',db),null);assert.equal(remoteRoster(db)[0].online,true);assert.equal(remoteRoster(db)[0].machine,'B');db.prepare('UPDATE paired_machines SET status=?').run('offline');assert.deepEqual(remoteRoster(db),[]);assert.equal(resolveAgentTarget('Beta@B',db)?.kind,'remote');db.prepare('INSERT INTO paired_machines VALUES (?,?,?,?,?)').run(randomUUID(),'B','paired','online','[]');assert.equal(resolveAgentTarget('Beta@B',db),null);assert.equal(resolveAgentTarget(`${agent}@${host}`,db)?.kind,'remote');}
  finally{db.close();}
});


test('peer roles sanitize bounded text and old cached summaries default empty', () => {
  assert.equal(peerAgentRole(undefined), ''); assert.equal(peerAgentRole(null), '');
  assert.equal(peerAgentRole('  Personal\n agent\u0085\u2028  '), 'Personal agent');
  assert.equal(peerAgentRole('x'.repeat(100)), 'x'.repeat(60));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE paired_machines(environment_id TEXT,name TEXT,status TEXT,state TEXT,agents TEXT)');
    const agent = { id: randomUUID(), name: 'Odd', model: 'fixture', status: 'idle' };
    db.prepare('INSERT INTO paired_machines VALUES (?,?,?,?,?)').run(randomUUID(), 'Peer', 'online', 'paired', JSON.stringify([agent]));
    assert.equal(remoteRoster(db)[0].role, '');
  } finally { db.close(); }
});


test('remote role reaches local discovery and team prompt through paired peer summaries', async () => {
  let system = '';
  const f = await fixture(body => {
    system = body.messages[0].content;
    const results = tools(body);
    return results.length ? JSON.stringify(results.at(-1)) : { name: 'list_agents', args: {} };
  });
  try {
    const id = randomUUID(), path = `/api/agents/${f.alpha.id}/turns`;
    await api(f.a, path, { id, text: 'List teammates' }, 202);
    const row = await until(async () => (await api(f.a, path)).find((row: any) => row.id === id && row.status === 'done'));
    const remote = JSON.parse(row.reply).agents.find((agent: any) => agent.id === `${f.beta.id}@${f.machine.id}`);
    assert.equal(remote.role, 'Personal agent'); assert(remote.description);
    assert(system.includes('Beta on B - Personal agent'));
  } finally { await f.close(); }
});
