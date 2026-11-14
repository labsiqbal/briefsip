import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startApp } from './server.ts';
import { mcpScopes, defaultSessionScopes, type McpScope } from './t3/mcp-session-registry.ts';
async function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'briefsip-m4-')),database=join(dir,'state.sqlite'),clients:Client[]=[];
 const held: (()=>void)[]=[]; const provider=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;
 if(req.url?.startsWith('/connected_accounts')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({items:[{id:'account_fixture',status:'ACTIVE',toolkit:{slug:'gmail'},connection_data:{token:'COMPOSIO_KEY_CANARY'},secret:'COMPOSIO_KEY_CANARY'}]}));return;}
 if(req.url==='/mcp'){const data=raw?JSON.parse(raw):{};if(data.id===undefined){res.writeHead(202);res.end();return;}const result=data.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:data.method==='tools/list'?{tools:[]}:{};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:data.id,result}));return;}
 if(raw.includes('ACTIVE_M4_TURN')) await new Promise<void>(resolve=>held.push(resolve)); res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Fixture reply'}}]}));});
 await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const address=provider.address();assert(address&&typeof address!=='string');const app=await startApp({database,baseURL:`http://127.0.0.1:${address.port}/v1`,composio:{baseURL:`http://127.0.0.1:${address.port}`}});
 const api=async(path:string,body?:unknown)=>{const r=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const v=await r.json();assert(r.ok,JSON.stringify(v));return v;};
 const a=await api('/api/agents',{id:randomUUID(),name:'A',role:'Agent A',model:'fixture',instructions:'Help A.'}),b=await api('/api/agents',{id:randomUUID(),name:'B',role:'Agent B',model:'fixture',instructions:'PRIVATE_B_INSTRUCTIONS'});
 const p=await api('/api/projects',{id:randomUUID(),name:'Project A',members:[{agent:a.id,write:false}]}),q=await api('/api/projects',{id:randomUUID(),name:'PRIVATE_PROJECT_B',members:[{agent:b.id,write:false}]});
 const thread=await api(`/api/agents/${a.id}/threads`,{id:randomUUID(),name:'Current A'}),privateThread=await api(`/api/agents/${b.id}/threads`,{id:randomUUID(),name:'PRIVATE_B_CONVERSATION'}),turn=randomUUID();
 await api(`/api/threads/${thread.id}/turns`,{id:turn,text:'ACTIVE_M4_TURN'});
 for(let n=0;n<200;n++){const rows=await api(`/api/threads/${thread.id}/turns`);if(rows.some((t:any)=>t.id===turn&&t.status==='running'))break;await new Promise(r=>setTimeout(r,10));}
 const peer=(scopes:McpScope[]=[...mcpScopes])=>app.mcpServer.createPeerToken({id:randomUUID(),name:'Owner',scopes});
 const session=(scopes:McpScope[]=[...defaultSessionScopes])=>app.mcpServer.mintAgentSession({agent:a.id,turn,scopes,ttlMs:60000});
 const client=async(token:string)=>{const c=new Client({name:'m4-test',version:'1'});clients.push(c);await c.connect(new StreamableHTTPClientTransport(new URL(app.origin+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));return c;};
 const rpc=(token:string,name:string,args:Record<string,unknown>)=>fetch(app.origin+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
 return {app,a,b,p,q,turn,thread,privateThread,api,peer,session,client,rpc,remote:`http://127.0.0.1:${address.port}/mcp`,async close(){for(const release of held)release();await Promise.all(clients.map(c=>c.close()));await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(dir,{recursive:true,force:true});}};
}
async function call(c:Client,name:string,args:Record<string,unknown>={}){const r=await c.callTool({name,arguments:args});assert(!r.isError,JSON.stringify(r));return r.structuredContent as Record<string,any>;}
const spec=()=>({kind:'instant',at:Date.now()+3600000});
const graph={entry:'out',maxSteps:1,nodes:[{id:'out',kind:'output'}]};
test('M4 real owner and session MCP HTTP clients read and write feature families',async()=>{
 const f=await fixture();try{
  const owner=await f.client(f.peer().token!),session=await f.client(f.session().token);
  assert((await owner.listTools()).tools.some(t=>t.name==='delegate_task'));assert((await session.listTools()).tools.some(t=>t.name==='create_routine'));
  assert.equal((await call(owner,'read_agent',{agent:f.a.id})).name,'A');
  const agent=await call(owner,'create_agent',{requestId:randomUUID(),name:'MCP agent',model:'fixture',instructions:'Help.'});
  await call(owner,'update_agent',{requestId:randomUUID(),agent:agent.id,revision:1,role:'New role'});
  const hidden=await call(owner,'hide_agent',{requestId:randomUUID(),agent:f.b.id,revision:0,confirmed:true});assert.equal(hidden.hidden,true);
  const open=await owner.callTool({name:'open_computer',arguments:{requestId:randomUUID(),agent:f.a.id}});assert(open.isError);assert(JSON.stringify(open).includes('403'));
  const side=await call(owner,'create_conversation',{requestId:randomUUID(),agent:agent.id,name:'MCP side'});
  await call(owner,'list_conversations',{agent:agent.id});await call(owner,'read_conversation',{kind:'thread',conversation:side.id});
  await call(owner,'rename_conversation',{requestId:randomUUID(),thread:side.id,revision:1,name:'Renamed'});
  await call(owner,'archive_conversation',{requestId:randomUUID(),thread:side.id,revision:2});await call(owner,'restore_conversation',{requestId:randomUUID(),thread:side.id,revision:3});
  const project=await call(owner,'create_project',{requestId:randomUUID(),name:'MCP project',members:[{agent:agent.id,write:false}]});
  await call(owner,'list_projects');await call(owner,'read_project',{project:project.id});const section=await call(owner,'add_project_section',{requestId:randomUUID(),project:project.id,revision:1,name:'research'});assert.equal(section.sections.length,2);
  const r=await call(owner,'create_routine',{requestId:randomUUID(),agent:agent.id,name:'MCP routine',prompt:'Work',schedule:spec(),enabled:false,trigger:'manual',project:project.id,reportTo:'direct'});
  await call(owner,'list_routines',{project:project.id});await call(owner,'read_routine',{routine:r.id});await call(owner,'resume_routine',{requestId:randomUUID(),routine:r.id,revision:1});await call(owner,'pause_routine',{requestId:randomUUID(),routine:r.id,revision:2});await call(owner,'update_routine',{requestId:randomUUID(),routine:r.id,revision:3,name:'Changed'});await call(owner,'run_routine',{requestId:randomUUID(),routine:r.id,revision:4});
  const wf=await f.api(`/api/agents/${agent.id}/workflows`,{id:randomUUID(),revision:0,name:'MCP workflow',graph});
  await call(owner,'list_workflows');await call(owner,'read_workflow',{workflow:wf.id});const run=await call(owner,'start_workflow',{requestId:randomUUID(),workflow:wf.id,revision:1,input:'Input'});await call(owner,'read_workflow_run',{run:run.id});
  for(const c of [owner,session]){await call(c,'list_machines');await call(c,'read_update_status');await call(c,'list_connected_apps',{project:f.p.id});await call(c,'list_mcp_connections',{project:f.p.id});await call(c,'list_project_environment',{project:f.p.id});await call(c,'read_computer_status',{agent:f.a.id});await call(c,'read_usage');await call(c,'list_skills');}
  await call(session,'read_agent',{agent:f.a.id});assert.equal((await call(session,'list_conversations',{agent:f.a.id})).items.length,1);await call(session,'read_conversation',{kind:'thread',conversation:f.thread.id});
  await call(session,'rename_conversation',{requestId:randomUUID(),thread:f.thread.id,revision:1,name:'Session title'});await call(session,'create_conversation',{requestId:randomUUID(),agent:f.a.id,name:'Agent side'});
  await call(session,'list_projects');await call(session,'read_project',{project:f.p.id});await call(session,'add_project_section',{requestId:randomUUID(),project:f.p.id,revision:1,name:'planning'});
  const sr=await call(session,'create_routine',{requestId:randomUUID(),agent:f.a.id,name:'Session routine',prompt:'Work',schedule:spec(),enabled:false,trigger:'manual',project:f.p.id});await call(session,'list_routines');await call(session,'read_routine',{routine:sr.id});await call(session,'pause_routine',{requestId:randomUUID(),routine:sr.id,revision:1});
  const sw=await f.api(`/api/agents/${f.a.id}/workflows`,{id:randomUUID(),revision:0,name:'Session workflow',graph});await call(session,'list_workflows');await call(session,'read_workflow',{workflow:sw.id});const swr=await call(session,'start_workflow',{requestId:randomUUID(),workflow:sw.id,revision:1,input:'Session input'});await call(session,'read_workflow_run',{run:swr.id});
 }finally{await f.close();}
});
test('M4 scope families and session resource isolation',async()=>{
 const f=await fixture();try{
  const limited=f.peer(['agents:read']),session=await f.client(f.session(mcpScopes.filter(s=>s!=='machine:update')).token);
  for(const name of ['read_agent','create_agent','list_conversations','create_conversation','list_projects','create_project','list_routines','create_routine','list_workflows','start_workflow','list_machines','list_project_environment','read_usage','list_skills','read_computer_status','open_computer','delegate_task'])assert.equal((await f.rpc(limited.token!,name,{})).status,403,name);
  const denied:[string,Record<string,unknown>][]=[['read_agent',{agent:f.b.id}],['list_conversations',{agent:f.b.id}],['read_conversation',{kind:'thread',conversation:f.privateThread.id}],['read_project',{project:f.q.id}],['add_project_section',{requestId:randomUUID(),project:f.q.id,revision:1,name:'Bad'}],['list_project_environment',{project:f.q.id}],['list_connected_apps',{project:f.q.id}],['list_mcp_connections',{project:f.q.id}],['create_routine',{requestId:randomUUID(),agent:f.a.id,name:'Bad',prompt:'Bad',schedule:spec(),enabled:false,project:f.q.id}],['add_project_member',{requestId:randomUUID(),project:f.p.id,agent:f.b.id,revision:1,write:true,confirmWrite:true}],['create_agent',{requestId:randomUUID(),name:'Bad',model:'x',instructions:'x'}]];
  for(const [name,args] of denied)await assert.rejects(()=>session.callTool({name,arguments:args}),/MCP authorization failed/);
  const projects=await call(session,'list_projects');assert.deepEqual(projects.items.map((p:any)=>p.id),[f.p.id]);assert(!JSON.stringify(projects).includes('PRIVATE_PROJECT_B'));
  const other=await f.api(`/api/agents/${f.a.id}/threads`,{id:randomUUID(),name:'Other same agent'});await assert.rejects(()=>session.callTool({name:'read_conversation',arguments:{kind:'thread',conversation:other.id}}),/MCP authorization failed/);
 }finally{await f.close();}
});
test('M4 idempotency, confirmed deletes, active-work guard and cursor bounds',async()=>{
 const f=await fixture();try{
  const p=f.peer(),c=await f.client(p.token!),second=await f.client(f.peer().token!),input={requestId:randomUUID(),agent:f.b.id,name:'Idempotent'};
  const first=await call(c,'create_conversation',input);assert.deepEqual(await call(c,'create_conversation',input),first);assert.notEqual((await call(second,'create_conversation',input)).id,first.id);
  const conflict=await c.callTool({name:'create_conversation',arguments:{...input,name:'Drift'}});assert(conflict.isError);assert(JSON.stringify(conflict).includes('409'));
  assert.equal((await f.rpc(p.token!,'delete_conversation',{requestId:randomUUID(),thread:first.id,revision:1})).status,400);
  const deletion={requestId:randomUUID(),thread:first.id,revision:1,confirmed:true};const deleted=await call(c,'delete_conversation',deletion);assert.deepEqual(await call(c,'delete_conversation',deletion),deleted);
  const busy=await c.callTool({name:'delete_conversation',arguments:{requestId:randomUUID(),thread:f.thread.id,revision:1,confirmed:true}});assert(busy.isError);assert(JSON.stringify(busy).includes('409'));
  for(let i=0;i<24;i++)await call(c,'create_conversation',{requestId:randomUUID(),agent:f.b.id,name:'Page '+i});
  const page=await call(c,'list_conversations',{agent:f.b.id,limit:10});assert.equal(page.items.length,10);assert(page.next_after);const next=await call(c,'list_conversations',{agent:f.b.id,limit:10,after:page.next_after});assert(!next.items.some((r:any)=>page.items.some((p:any)=>p.id===r.id)));
  for(const limit of [0,1,9,51])assert.equal((await f.rpc(p.token!,'list_projects',{limit})).status,400);
  assert.equal((await f.rpc(p.token!,'create_project',{requestId:randomUUID(),name:'Nested bad',members:[{agent:f.a.id,write:false,token:'SECRET'}]})).status,400);
 }finally{await f.close();}
});

test('M4 secret-free listings and revocation before receipt replay',async()=>{
 const f=await fixture();try{
  const token=f.peer(),owner=await f.client(token.token!),session=await f.client(f.session().token),environment='ENVIRONMENT_CANARY_with_quote"and_newline\n';
  await f.api(`/api/projects/${f.p.id}/environment`,{id:randomUUID(),name:'SERVICE_TOKEN',value:environment});
  await f.api('/api/connected-apps/key',{id:randomUUID(),revision:0,key:'COMPOSIO_KEY_CANARY'});
  const tested=await f.api(`/api/projects/${f.p.id}/mcp/test`,{id:randomUUID(),name:'Fixture MCP',url:f.remote,token:'MCP_TOKEN_CANARY'});
  await f.api(`/api/projects/${f.p.id}/mcp`,{id:randomUUID(),test:tested.id});
  await f.api(`/api/agents/${f.b.id}/edit`,{id:randomUUID(),revision:1,name:'B',model:'fixture',instructions:'COMPOSIO_KEY_CANARY MCP_TOKEN_CANARY '+environment});
  const results=[await call(owner,'read_agent',{agent:f.b.id}),await call(session,'read_agent',{agent:f.a.id})];
  for(const client of [owner,session])for(const name of ['list_project_environment','list_connected_apps','list_mcp_connections'])results.push(await call(client,name,{project:f.p.id}));
  const encoded=JSON.stringify(results);for(const secret of [environment,'COMPOSIO_KEY_CANARY','MCP_TOKEN_CANARY',token.token!])assert(!encoded.includes(secret));assert(encoded.includes('SERVICE_TOKEN'));
  const command={requestId:randomUUID(),project:f.p.id,revision:1,name:'Scope receipt'};await call(session,'add_project_section',command);
  const changed=await call(owner,'remove_project_member',{requestId:randomUUID(),project:f.p.id,agent:f.a.id,revision:2});assert.equal(changed.members.length,0);
  await assert.rejects(()=>session.callTool({name:'add_project_section',arguments:command}),/MCP authorization failed/);
  await assert.rejects(()=>session.callTool({name:'list_project_environment',arguments:{project:f.p.id}}),/MCP authorization failed/);
 }finally{await f.close();}
});
test('M4 delegation MCP tools preserve parent session and caller receipts',async()=>{
 const f=await fixture();try{
  const c=await f.client(f.session().token),args={requestId:randomUUID(),agent:f.b.id,task:'Delegated fixture'};
  const delegated=await call(c,'delegate_task',args);assert(delegated.taskId);assert.deepEqual(await call(c,'delegate_task',args),delegated);
  await call(c,'task_status',{taskId:delegated.taskId});const wait={requestId:randomUUID(),taskId:delegated.taskId,timeoutSeconds:2};const waited=await call(c,'wait_task',wait);assert.deepEqual(await call(c,'wait_task',wait),waited);
  const cancel={requestId:randomUUID(),taskId:delegated.taskId};const cancelled=await call(c,'cancel_task',cancel);assert.deepEqual(await call(c,'cancel_task',cancel),cancelled);
  const drift=await c.callTool({name:'delegate_task',arguments:{...args,task:'Changed'}});assert(drift.isError);assert(JSON.stringify(drift).includes('409'));
 }finally{await f.close();}
});

test('M4 route-backed workflow and MCP cursors do not skip ten-item page tails',async()=>{
 const f=await fixture();try{
  const c=await f.client(f.peer().token!),expected:string[]=[];
  for(let n=0;n<25;n++){const w=await f.api(`/api/agents/${f.a.id}/workflows`,{id:randomUUID(),revision:0,name:'Page '+n,graph});expected.push(w.id);}
  const found:string[]=[];let after:string|null=null;
  do{const page=await call(c,'list_workflows',{limit:10,...(after?{after}:{})});assert(page.items.length<=10);found.push(...page.items.map((w:any)=>w.id));after=page.next_after;}while(after);
  assert.deepEqual(found,expected.sort());
  const connections:string[]=[];
  for(let n=0;n<15;n++){const tested=await f.api(`/api/projects/${f.p.id}/mcp/test`,{id:randomUUID(),name:'Page '+n,url:f.remote,token:'fixture-token'});const saved=await f.api(`/api/projects/${f.p.id}/mcp`,{id:randomUUID(),test:tested.id});connections.push(saved.id);}
  const first=await call(c,'list_mcp_connections',{project:f.p.id,limit:10});assert.equal(first.items.length,10);assert(first.next_after);
  const second=await call(c,'list_mcp_connections',{project:f.p.id,limit:10,after:first.next_after});assert.equal(second.items.length,5);assert.equal(second.next_after,null);
  assert.deepEqual([...first.items,...second.items].map((i:any)=>i.id),connections.sort());
 }finally{await f.close();}
});
