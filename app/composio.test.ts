import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './server.ts';
import { createComposio, composioToolName } from './composio.ts';
import { restoreConnectedAppCommand } from './connected-app-command.ts';
const canary='COMPOSIO_CANARY_6vR9pX8m7Q4b';
const schema={type:'object',properties:{target:{type:'string'},text:{type:'string'}},required:['target'],additionalProperties:false};
const rawTool=(slug:string,tags:string[]=[])=>({slug,name:slug,description:`${slug} ${canary}`,toolkit:{slug:'gmail'},version:'20261113_00',input_parameters:schema,tags});
async function listen(server:ReturnType<typeof createServer>){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
const stop=(server:ReturnType<typeof createServer>)=>new Promise<void>(resolve=>server.close(()=>resolve()));
async function body(req:AsyncIterable<Uint8Array>){const chunks=[];for await(const chunk of req)chunks.push(chunk);return chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};}

test('connected apps end to end: catalog, accounts, grants, tools, approvals, receipts and no secrets',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'briefsip-composio-')),database=join(dir,'workspace.sqlite'),priorKey=process.env.COMPOSIO_API_KEY;delete process.env.COMPOSIO_API_KEY;
  const calls:{path:string;method:string;body:any}[]=[],providerBodies:any[]=[],effects:string[]=[],logs:string[]=[],responses:string[]=[];
  let connected=true,connectionPage=false,mode='read',fail=0,tags=['readOnlyHint'];
  const originalError=console.error,originalLog=console.log;console.error=(...args)=>logs.push(args.join(' '));console.log=(...args)=>logs.push(args.join(' '));
  const remote=createServer((req,res)=>{void(async()=>{
    assert.equal(req.headers['x-api-key'],canary);const url=new URL(req.url!,'http://fake'),data=await body(req);calls.push({path:req.url!,method:req.method!,body:data});
    const send=(status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if(fail===1)return send(401,{error:{message:canary}});
    if(fail===2){res.writeHead(200);res.end('x'.repeat(512*1024+1));return;}
    if(fail===3){res.writeHead(302,{location:'https://example.com/'});res.end();return;}
    if(fail===4){res.writeHead(200);res.end('broken '+canary);return;}
    if(url.pathname==='/api/v3.1/toolkits/categories')return send(200,{items:[{id:'communication',name:'Communication'}]});
    if(url.pathname==='/api/v3.1/toolkits')return send(200,{items:[{slug:url.searchParams.has('cursor')?'slack':'gmail',name:url.searchParams.has('cursor')?'Slack':'Gmail',meta:{description:canary},composio_managed_auth_schemes:['OAUTH2']}],next_cursor:url.searchParams.has('cursor')?null:'catalog-page-2'});
    if(url.pathname==='/api/v3.1/toolkits/gmail')return send(200,{slug:'gmail',composio_managed_auth_schemes:['OAUTH2']});
    if(url.pathname==='/api/v3.1/auth_configs')return send(201,{auth_config:{id:'ac_gmail'},credentials:{api_key:canary}});
    if(url.pathname==='/api/v3.1/connected_accounts/link'){assert.equal(data.auth_config_id,'ac_gmail');return send(201,{redirect_url:'https://connect.composio.dev/link/test',api_key:canary});}
    if(url.pathname==='/api/v3.1/connected_accounts'){
      assert(url.searchParams.get('user_ids')?.startsWith('briefsip-'));
      if(connectionPage&&!url.searchParams.has('cursor'))return send(200,{items:[],next_cursor:'accounts-2'});
      return send(200,{items:connected?[{id:'ca_1',toolkit:{slug:'gmail'},status:'ACTIVE',state:{token:canary},connection_data:{api_key:canary}}]:[]});
    }
    if(url.pathname==='/api/v3.1/connected_accounts/ca_1'&&req.method==='DELETE'){connected=false;return send(200,{deleted:true,token:canary});}
    if(url.pathname==='/api/v3.1/tools')return send(200,{items:[rawTool('GMAIL_FETCH_EMAILS',tags),rawTool('GMAIL_SEND_EMAIL',['createHint']),rawTool('GMAIL_GET_AND_DELETE',[])]});
    if(url.pathname.startsWith('/api/v3.1/tools/execute/')){assert.equal(data.version,'20261113_00');assert.equal(data.connected_account_id,'ca_1');assert(!('api_key' in data));effects.push(url.pathname.split('/').at(-1)!);return send(200,{successful:true,data:{target:data.arguments.target,result:canary,[canary]:canary},error:null});}
    send(404,{});
  })().catch(error=>{res.writeHead(500);res.end(JSON.stringify({error:String(error)}));});});
  const remoteOrigin=await listen(remote);
  const provider=createServer((req,res)=>{void(async()=>{
    const data=await body(req);providerBodies.push(data);const current=data.messages.findLast((row:any)=>row.role==='user')?.content,results=data.messages.filter((row:any)=>row.role==='tool');
    const tool=mode==='read'?'GMAIL_FETCH_EMAILS':mode==='unknown'?'GMAIL_GET_AND_DELETE':'GMAIL_SEND_EMAIL';
    const call={id:`call-${String(current).slice(0,40)}`,type:'function',function:{name:composioToolName(tool),arguments:JSON.stringify({target:'recipient@example.test',text:'Synthetic message'})}};
    const message=results.length?{role:'assistant',content:JSON.stringify(results.at(-1).content)}:{role:'assistant',content:null,tool_calls:[call]};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message,finish_reason:results.length?'stop':'tool_calls'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  })();});
  const providerOrigin=await listen(provider),options={database,baseURL:providerOrigin+'/v1',apiKey:'FAKE_PROVIDER_KEY',defaultModel:'fake',port:0,composio:{baseURL:remoteOrigin+'/api/v3.1'}};
  let app=await startApp(options),origin=app.origin,closed=false;
  const request=async(path:string,data?:unknown,status=200)=>{const res=await fetch(origin+path,data?{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(data)}:{}),raw=await res.text();responses.push(raw);assert.equal(res.status,status,`${path}: ${raw}`);return JSON.parse(raw);};
  const wait=async(path:string,id:string,predicate:(row:any)=>boolean)=>{for(let n=0;n<400;n++){const row=(await request(path)).find((row:any)=>row.id===id);if(row&&predicate(row))return row;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Turn did not settle: '+id+' last='+JSON.stringify((await request(path)).find((row:any)=>row.id===id)));};
  try{
    const noConfig=await request('/api/connected-apps');assert.equal(noConfig.configured,false);assert.deepEqual(noConfig.items,[]);assert.equal(calls.length,0);
    await request('/api/connected-apps/connect/gmail',{id:randomUUID()},503);
    const agent=await request('/api/agents',{id:randomUUID(),name:'Connected Apps Tester',model:'fake',instructions:'Use the offered app tool.'},201),other=await request('/api/agents',{id:randomUUID(),name:'No Apps',model:'fake',instructions:'No apps.'},201);
    const turns=`/api/agents/${agent.id}/turns`,access=`/api/agents/${agent.id}/connected-apps/gmail`;
    const noKey=randomUUID();await request(turns,{id:noKey,text:'unconfigured'},202);await wait(turns,noKey,row=>row.status==='failed');assert(!providerBodies.at(-1).tools.some((tool:any)=>tool.function.name.startsWith('composio__')));assert.equal(calls.length,0);
    await app.close();process.env.COMPOSIO_API_KEY=canary;app=await startApp(options);origin=app.origin;
    await request('/api/connected-apps/key',{id:randomUUID(),revision:0,key:canary});
    const catalog=await request('/api/connected-apps?search=mail&category=communication');assert.equal(catalog.items[0].name,'Gmail');assert.equal(catalog.items[0].description,'[REDACTED]');assert(calls.some(row=>row.path.includes('search=mail')&&row.path.includes('category=communication')));
    assert.equal((await request('/api/connected-apps?after=catalog-page-2')).items[0].name,'Slack');
    const connect={id:randomUUID()},link=await request('/api/connected-apps/connect/gmail',connect);assert.equal(link.redirect_url,'https://connect.composio.dev/link/test');assert.deepEqual(await request('/api/connected-apps/connect/gmail',connect),link);assert.equal(calls.filter(row=>row.path.endsWith('/connected_accounts/link')).length,1);await request('/api/connected-apps/connect/slack',connect,409);
    connectionPage=true;assert.deepEqual((await request('/api/connected-apps/accounts')).items,[{id:'ca_1',toolkit:'gmail',status:'ACTIVE'}]);connectionPage=false;
    assert.deepEqual((await request(`/api/agents/${agent.id}/connected-apps`)).items,[]);
    const grant={id:randomUUID(),revision:0,enabled:true};assert.equal((await request(access,grant)).revision,1);assert.equal((await request(access,grant)).revision,1);await request(access,{...grant,enabled:false},409);await request(access,{id:randomUUID(),revision:0,enabled:false},409);
    const read=randomUUID();await request(turns,{id:read,text:'read'},202);await wait(turns,read,row=>row.status==='done');assert.deepEqual(effects,['GMAIL_FETCH_EMAILS']);assert(providerBodies.at(-1).tools.some((tool:any)=>tool.function.name===composioToolName('GMAIL_FETCH_EMAILS')));assert(!JSON.stringify(providerBodies).includes(canary));
    const otherTurn=randomUUID();await request(`/api/agents/${other.id}/turns`,{id:otherTurn,text:'other'},202);await wait(`/api/agents/${other.id}/turns`,otherTurn,row=>row.status==='failed');assert(!providerBodies.at(-1).tools.some((tool:any)=>tool.function.name.startsWith('composio__')));
    mode='write';const send=async(label:string)=>{const id=randomUUID();await request(turns,{id,text:label},202);return {id,waiting:await wait(turns,id,row=>row.approvals?.some((a:any)=>a.state==='approval'))};};
    const first=await send('allow once');assert.equal(effects.length,1);await app.close();app=await startApp(options);origin=app.origin;assert.equal((await request(turns)).find((row:any)=>row.id===first.id).approvals[0].state,'approval');assert.equal(effects.length,1);
    const approval=first.waiting.approvals[0],approvePath=`${turns}/${first.id}/app-approvals/${encodeURIComponent(approval.id)}`,allow={id:randomUUID(),revision:approval.revision,decision:'allow'};
    await request(`/api/agents/${other.id}/turns/${first.id}/app-approvals/${encodeURIComponent(approval.id)}`,allow,404);await request(approvePath,{...allow,id:randomUUID(),revision:999},409);await request(approvePath,allow);assert.deepEqual(await request(approvePath,allow),{id:approval.id,decision:'allow'});await request(approvePath,{...allow,decision:'deny'},409);await wait(turns,first.id,row=>row.status==='done');assert.equal(effects.filter(row=>row==='GMAIL_SEND_EMAIL').length,1);
    const second=await send('always'),always=second.waiting.approvals[0];await request(`${turns}/${second.id}/app-approvals/${always.id}`,{id:randomUUID(),revision:always.revision,decision:'always'});await wait(turns,second.id,row=>row.status==='done');
    await app.close();app=await startApp(options);origin=app.origin;
    const auto=randomUUID();await request(turns,{id:auto,text:'always persisted'},202);const automated=await wait(turns,auto,row=>row.status==='done');assert.equal(automated.approvals.length,0);assert.equal(effects.filter(row=>row==='GMAIL_SEND_EMAIL').length,3);
    const peer=await request('/api/mcp-server/peer-tokens',{id:randomUUID(),name:'Peer',scopes:['agents:message']});
    const receipt=await fetch(origin+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${peer.token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'send_message',arguments:{requestId:randomUUID(),recipient:agent.id,text:'Peer write with saved policy'}}})}).then(response=>response.json());
    const delivery=receipt.result.structuredContent,peerTurns=`/api/threads/${delivery.thread}/turns`,peerTurn=await wait(peerTurns,delivery.turn,row=>row.approvals?.some((a:any)=>a.state==='approval'));
    assert.equal(effects.filter(row=>row==='GMAIL_SEND_EMAIL').length,3);const peerApproval=peerTurn.approvals[0];
    await request(`${peerTurns}/${delivery.turn}/app-approvals/${peerApproval.id}`,{id:randomUUID(),revision:peerApproval.revision,decision:'deny'});await wait(peerTurns,delivery.turn,row=>row.status==='done');
    const policyPath=`/api/agents/${agent.id}/connected-app-policies`,policies=(await request(policyPath)).items;assert.equal(policies.length,1);await request(policyPath,{id:randomUUID(),fingerprint:policies[0].fingerprint});
    const preflight=await send('account lookup temporarily fails'),preflightApproval=preflight.waiting.approvals[0];fail=1;
    await request(`${turns}/${preflight.id}/app-approvals/${preflightApproval.id}`,{id:randomUUID(),revision:preflightApproval.revision,decision:'allow'});
    const failedReady=await wait(turns,preflight.id,row=>row.status==='failed');assert.equal(failedReady.approvals[0].state,'ready');assert.equal(effects.filter(row=>row==='GMAIL_SEND_EMAIL').length,3);fail=0;
    await request(`${turns}/${preflight.id}/resume`,{id:randomUUID(),revision:failedReady.revision,acknowledgeUncertain:true});await wait(turns,preflight.id,row=>row.status==='done');
    const denied=await send('deny'),denial=denied.waiting.approvals[0];await request(`${turns}/${denied.id}/app-approvals/${denial.id}`,{id:randomUUID(),revision:denial.revision,decision:'deny'});const declined=await wait(turns,denied.id,row=>row.status==='done');assert.match(declined.reply,/did not allow/);assert.equal(effects.filter(row=>row==='GMAIL_SEND_EMAIL').length,4);
    mode='unknown';const unknown=await send('unknown metadata');assert.equal(unknown.waiting.approvals[0].slug,'GMAIL_GET_AND_DELETE');await request(`${turns}/${unknown.id}/app-approvals/${unknown.waiting.approvals[0].id}`,{id:randomUUID(),revision:unknown.waiting.approvals[0].revision,decision:'deny'});await wait(turns,unknown.id,row=>row.status==='done');
    mode='read';tags=['readOnlyHint','destructiveHint'];const conflict=await send('conflicting metadata');assert.equal(conflict.waiting.approvals[0].slug,'GMAIL_FETCH_EMAILS');await request(`${turns}/${conflict.id}/app-approvals/${conflict.waiting.approvals[0].id}`,{id:randomUUID(),revision:conflict.waiting.approvals[0].revision,decision:'deny'});await wait(turns,conflict.id,row=>row.status==='done');tags=['readOnlyHint'];
    mode='write';const revoked=await send('revoke before approval');const revokedApproval=revoked.waiting.approvals[0],revokedPath=`${turns}/${revoked.id}/app-approvals/${revokedApproval.id}`;
    await request(access,{id:randomUUID(),revision:1,enabled:false});await request(revokedPath,{id:randomUUID(),revision:revokedApproval.revision,decision:'allow'},409);await request(revokedPath,{id:randomUUID(),revision:revokedApproval.revision,decision:'deny'});await wait(turns,revoked.id,row=>row.status==='done');
    await request(access,grant);assert.equal((await request(`/api/agents/${agent.id}/connected-apps`)).items[0].enabled,false);await request(access,{id:randomUUID(),revision:2,enabled:true});
    const disconnect={id:randomUUID()};await request('/api/connected-apps/disconnect/foreign',{id:randomUUID()},404);await request('/api/connected-apps/disconnect/ca_1',disconnect);await request('/api/connected-apps/disconnect/ca_1',disconnect);assert.equal(calls.filter(row=>row.method==='DELETE').length,1);assert.equal((await request(`/api/agents/${agent.id}/connected-apps`)).items[0].enabled,false);assert.deepEqual((await request('/api/connected-apps/accounts')).items,[]);
    for(fail of [1,2,3,4]){const error=await request('/api/connected-apps',undefined,502);assert(!JSON.stringify(error).includes(canary));}fail=0;
    assert(!responses.join('').includes(canary));assert(!logs.join('').includes(canary));await app.close();closed=true;assert(!readFileSync(database).includes(Buffer.from(canary)));
    const db=new DatabaseSync(database),installation=db.prepare('SELECT user_id FROM composio_installation').get()!.user_id;assert(String(installation).startsWith('briefsip-'));assert(!String(installation).includes('@'));db.close();
  }finally{console.error=originalError;console.log=originalLog;if(!closed)await app.close().catch(()=>{});await stop(provider);await stop(remote);if(priorKey===undefined)delete process.env.COMPOSIO_API_KEY;else process.env.COMPOSIO_API_KEY=priorKey;rmSync(dir,{recursive:true,force:true});}
});

test('approved call recovery never replays an uncertain write; argument validation and saved command bounds',async()=>{
  const prior=process.env.COMPOSIO_API_KEY;process.env.COMPOSIO_API_KEY=canary;
  const dir=mkdtempSync(join(tmpdir(),'briefsip-composio-crash-')),path=join(dir,'db');let executed=0;
  const remote=createServer((req,res)=>{void(async()=>{const data=await body(req),url=new URL(req.url!,'http://fake');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(url.pathname.endsWith('/connected_accounts')?{items:[{id:'ca_1',toolkit:{slug:'gmail'},status:'ACTIVE'}]}:url.pathname.endsWith('/tools')?{items:[rawTool('GMAIL_SEND_EMAIL',['createHint'])]}:(executed++,{successful:true,data})));})();});
  const origin=await listen(remote),agent=randomUUID(),turn=randomUUID();let db=new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE agents(id TEXT PRIMARY KEY); CREATE TABLE turns(id TEXT PRIMARY KEY,agent TEXT,status TEXT,paused INTEGER,revision INTEGER); CREATE TABLE generated_files(turn TEXT); CREATE TABLE flow_tool_calls(turn TEXT,call_id TEXT,call TEXT,result TEXT,after_output INTEGER,after_action INTEGER,UNIQUE(turn,call_id));");db.prepare('INSERT INTO agents VALUES(?)').run(agent);db.prepare("INSERT INTO turns VALUES(?,?,'running',0,1)").run(turn,agent);
  const tx=<T>(run:()=>T)=>{db.exec('BEGIN IMMEDIATE');try{const result=run();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
  let client=createComposio(db,tx,{baseURL:origin+'/api/v3.1'});
  try{
    client.grant(randomUUID(),agent,'gmail',{revision:0,enabled:true});const tools=await client.tools(agent),call={id:'write',type:'function' as const,function:{name:composioToolName('GMAIL_SEND_EMAIL'),arguments:JSON.stringify({target:'test'})}};
    await assert.rejects(client.call(turn,agent,{...call,function:{...call.function,arguments:'{"unexpected":1}'}},0,new AbortController().signal,tools),/schema/);assert.deepEqual(await client.call(turn,agent,call,0,new AbortController().signal,tools),{paused:true});assert.equal(executed,0);
    const approval=client.approvals(turn)[0];client.decide(randomUUID(),turn,call.id,{revision:approval.revision,decision:'allow'},()=>true);
    // Persisted dispatch intent simulates death after approval and before result commit.
    db.prepare("UPDATE composio_calls SET state='running' WHERE turn=?").run(turn);client.close();db.close();db=new DatabaseSync(path);client=createComposio(db,tx,{baseURL:origin+'/api/v3.1'});db.prepare("UPDATE turns SET status='running' WHERE id=?").run(turn);
    await assert.rejects(client.resume(turn,agent,new AbortController().signal),/uncertain/);assert.equal(executed,0);assert.equal(client.approvals(turn)[0].state,'uncertain');assert(!JSON.stringify(db.prepare('SELECT * FROM composio_calls').all()).includes(canary));
    assert(restoreConnectedAppCommand(JSON.stringify({path:`/api/agents/${agent}/connected-apps/gmail`,body:{id:randomUUID(),revision:0,enabled:true}})));assert.throws(()=>restoreConnectedAppCommand('{bad'));assert.throws(()=>restoreConnectedAppCommand(JSON.stringify({path:'/api/agents',body:{id:randomUUID()}})));
  }finally{client.close();db.close();await stop(remote);rmSync(dir,{recursive:true,force:true});if(prior===undefined)delete process.env.COMPOSIO_API_KEY;else process.env.COMPOSIO_API_KEY=prior;}
});

test('SIGKILL after Composio accepts write marks it uncertain without replay', { timeout: 15000 }, async () => {
  const prior=process.env.COMPOSIO_API_KEY; process.env.COMPOSIO_API_KEY=canary;
  const dir=mkdtempSync(join(tmpdir(),'briefsip-composio-process-')), database=join(dir,'db'), agent=randomUUID(), turn=randomUUID();
  let effects=0, accepted!:()=>void;
  const acceptedEffect=new Promise<void>(resolve=>{accepted=resolve;});
  const remote=createServer((req,res)=>{void(async()=>{const url=new URL(req.url!,'http://fake'); await body(req);
    res.setHeader('Content-Type','application/json');
    if(url.pathname.endsWith('/connected_accounts')) return res.end(JSON.stringify({items:[{id:'ca_1',toolkit:{slug:'gmail'},status:'ACTIVE'}]}));
    if(url.pathname.endsWith('/tools')) return res.end(JSON.stringify({items:[rawTool('GMAIL_SEND_EMAIL',['createHint'])]}));
    if(url.pathname.includes('/tools/execute/')) { effects++; accepted(); return; }
    res.end(JSON.stringify({}));
  })().catch(()=>{res.statusCode=500;res.end('{}');});});
  await listen(remote); const address=remote.address(); assert(address&&typeof address!=='string');
  const source=new URL('./composio.ts',import.meta.url).href;
  const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',`
    import { DatabaseSync } from 'node:sqlite';
    import { createComposio, composioToolName } from ${JSON.stringify(source)};
    const db=new DatabaseSync(process.env.BRIEFSIP_DB);
    db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY); CREATE TABLE turns(id TEXT PRIMARY KEY,agent TEXT,status TEXT,paused INTEGER,revision INTEGER); CREATE TABLE generated_files(turn TEXT); CREATE TABLE flow_tool_calls(turn TEXT,call_id TEXT,call TEXT,result TEXT,after_output INTEGER,after_action INTEGER,UNIQUE(turn,call_id)); INSERT INTO agents VALUES ('${agent}'); INSERT INTO turns VALUES ('${turn}','${agent}','running',0,1);");
    const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const out=fn();db.exec('COMMIT');return out;}catch(error){db.exec('ROLLBACK');throw error;}};
    const client=createComposio(db,tx,{baseURL:process.env.BRIEFSIP_COMPOSIO});
    client.grant(crypto.randomUUID(),'${agent}','gmail',{revision:0,enabled:true});
    const tools=await client.tools('${agent}');
    const call={id:'write',type:'function',function:{name:composioToolName('GMAIL_SEND_EMAIL'),arguments:'{"target":"victim@example.test"}'}};
    await client.call('${turn}','${agent}',call,0,new AbortController().signal,tools);
    const approval=client.approvals('${turn}')[0]; client.decide(crypto.randomUUID(),'${turn}','write',{revision:approval.revision,decision:'allow'},()=>true);
    db.prepare("UPDATE turns SET status='running' WHERE id=?").run('${turn}');
    console.log('approved'); await client.resume('${turn}','${agent}',new AbortController().signal);
  `],{env:{...process.env,BRIEFSIP_DB:database,BRIEFSIP_COMPOSIO:`http://127.0.0.1:${address.port}`},stdio:['ignore','pipe','pipe']});
  const output=createInterface({input:child.stdout}); child.stderr.resume(); const exited=once(child,'exit');
  try {
    await Promise.race([once(output,'line'),exited.then(()=>{throw new Error('Composio child exited before approval');})]);
    await Promise.race([acceptedEffect,exited.then(()=>{throw new Error('Composio child exited before dispatch');})]); child.kill('SIGKILL'); assert.equal((await exited)[1],'SIGKILL'); assert.equal(effects,1);
    const db=new DatabaseSync(database),tx=<T>(fn:()=>T)=>{db.exec('BEGIN IMMEDIATE');try{const out=fn();db.exec('COMMIT');return out;}catch(error){db.exec('ROLLBACK');throw error;}};
    const client=createComposio(db,tx,{baseURL:`http://127.0.0.1:${address.port}`});
    await assert.rejects(client.resume(turn,agent,new AbortController().signal),/uncertain/);
    assert.equal(client.approvals(turn)[0].state,'uncertain'); assert.equal(effects,1);
    client.close(); db.close();
  } finally {
    output.close(); if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL'); await exited.catch(()=>{});
    await stop(remote); rmSync(dir,{recursive:true,force:true}); if(prior===undefined)delete process.env.COMPOSIO_API_KEY;else process.env.COMPOSIO_API_KEY=prior;
  }
});

test('installation API key: validation, encrypted persistence, receipts, runtime precedence and restart', async () => {
  const savedEnv=process.env.COMPOSIO_API_KEY; delete process.env.COMPOSIO_API_KEY;
  const directory=mkdtempSync(join(tmpdir(),'briefsip-installation-key-')),database=join(directory,'app.sqlite');
  const storedKey='INSTALLATION_CANARY_KEY_K9m2s8v4', replacement='REPLACEMENT_CANARY_KEY_V7r8b9n2', environment='ENVIRONMENT_CANARY_KEY_T8n5z2p4';
  const remoteCalls:{key:string;path:string}[]=[],responses:string[]=[];
  const remote=createServer((req,res)=>{const key=String(req.headers['x-api-key']);remoteCalls.push({key,path:req.url!});res.setHeader('Content-Type','application/json');if(![storedKey,replacement,environment].includes(key)){res.statusCode=401;return res.end(JSON.stringify({error:key}));}res.end(JSON.stringify(req.url!.endsWith('/toolkits/categories')?{items:[]}:{items:[{slug:'gmail',name:'Gmail',meta:{description:key},composio_managed_auth_schemes:['OAUTH2']}]}));});
  const remoteOrigin=await listen(remote),options={database,composio:{baseURL:remoteOrigin+'/api/v3.1'}};
  let app=await startApp(options),origin=app.origin,closed=false;
  const request=async(path:string,data?:unknown,status=200,headers?:Record<string,string>)=>{const response=await fetch(origin+path,data?{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(data)}:{});const raw=await response.text();responses.push(raw);assert.equal(response.status,status,raw);return JSON.parse(raw);};
  try {
    assert.deepEqual(await request('/api/connected-apps/key'),{source:'none',revision:0});
    const invalid={id:randomUUID(),revision:0,key:'REJECTED_CANARY'};
    await request('/api/connected-apps/key',invalid,400);assert.deepEqual(await request('/api/connected-apps/key'),{source:'none',revision:0});
    assert.equal(remoteCalls.length,1);
    for(const key of ['', 'x\ny', 'x\u0085y','x'.repeat(4097)])await request('/api/connected-apps/key',{id:randomUUID(),revision:0,key},400);
    await request('/api/connected-apps/key',{id:randomUUID(),revision:-1,key:storedKey},400);
    await request('/api/connected-apps/key',{id:randomUUID(),revision:0,key:storedKey},403,{Origin:'https://attacker.example'});
    await request('/api/connected-apps/key',{id:randomUUID(),revision:0,key:storedKey},403,{'Content-Type':'text/plain'});
    assert.equal(remoteCalls.length,1);
    process.env.COMPOSIO_API_KEY=environment;
    assert.deepEqual(await request('/api/connected-apps/key'),{source:'environment',revision:0});
    await request('/api/connected-apps');assert.equal(remoteCalls.at(-1)!.key,environment);
    const save={id:randomUUID(),revision:0,key:`  ${storedKey}  `},receipt=await request('/api/connected-apps/key',save);
    assert.deepEqual(receipt,{source:'settings',revision:1});const count=remoteCalls.length;
    assert.deepEqual(await request('/api/connected-apps/key',save),receipt);assert.equal(remoteCalls.length,count,'Exact retry must not verify or save twice');
    await request('/api/connected-apps/key',{...save,key:replacement},409);assert.equal(remoteCalls.length,count);
    await request('/api/connected-apps/key',{id:randomUUID(),revision:0,key:replacement},409);assert.equal(remoteCalls.length,count);
    assert.deepEqual(await request('/api/connected-apps/key'),receipt);
    const catalog=await request('/api/connected-apps');assert.equal(catalog.items[0].description,'[REDACTED]');assert(remoteCalls.slice(count).every(row=>row.key===storedKey));
    await app.close();app=await startApp(options);origin=app.origin;
    assert.deepEqual(await request('/api/connected-apps/key'),receipt);await request('/api/connected-apps');assert.equal(remoteCalls.at(-1)!.key,storedKey);
    const replaced=await request('/api/connected-apps/key',{id:randomUUID(),revision:1,key:replacement});assert.equal(replaced.revision,2);await request('/api/connected-apps');assert.equal(remoteCalls.at(-1)!.key,replacement);
    const remove={id:randomUUID(),revision:2},removed=await request('/api/connected-apps/key/remove',remove);assert.deepEqual(removed,{source:'environment',revision:3});assert.deepEqual(await request('/api/connected-apps/key/remove',remove),removed);
    await request('/api/connected-apps/key/remove',{...remove,revision:3},409);
    await request('/api/connected-apps/key',{...remove,key:storedKey},409);
    await request('/api/connected-apps');assert.equal(remoteCalls.at(-1)!.key,environment);
    await app.close();app=await startApp(options);origin=app.origin;assert.deepEqual(await request('/api/connected-apps/key'),removed);
    delete process.env.COMPOSIO_API_KEY;assert.deepEqual(await request('/api/connected-apps/key'),{source:'none',revision:3});
    await request('/api/connected-apps/key',{id:randomUUID(),revision:0,key:storedKey},409);
    await request('/api/connected-apps/key',{id:randomUUID(),revision:3,key:storedKey});
    await app.close();closed=true;
    for(const key of [storedKey,replacement,environment,'REJECTED_CANARY']) {assert(!responses.join('').includes(key));assert(!readFileSync(database).includes(Buffer.from(key)));}
    const db=new DatabaseSync(database);assert(!JSON.stringify(db.prepare('SELECT * FROM composio_commands').all()).includes(storedKey));assert(!String(db.prepare('SELECT ciphertext FROM composio_settings').get()!.ciphertext).includes(storedKey));db.close();
    assert.equal((await import('node:fs')).statSync(database+'.composio-key').mode & 0o777,0o600);
  } finally {if(!closed)await app.close();await stop(remote);rmSync(directory,{recursive:true,force:true});if(savedEnv===undefined)delete process.env.COMPOSIO_API_KEY;else process.env.COMPOSIO_API_KEY=savedEnv;}
});

test('key replacement and removal atomically reset identity, grants, policies and pending calls without replay', async()=>{
  const savedEnv=process.env.COMPOSIO_API_KEY;process.env.COMPOSIO_API_KEY=canary;
  const directory=mkdtempSync(join(tmpdir(),'briefsip-key-reset-')),database=join(directory,'db'),db=new DatabaseSync(database),agent=randomUUID();
  db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY); CREATE TABLE turns(id TEXT PRIMARY KEY,agent TEXT,status TEXT,paused INTEGER,revision INTEGER); CREATE TABLE generated_files(turn TEXT); CREATE TABLE flow_tool_calls(turn TEXT,call_id TEXT,call TEXT,result TEXT,after_output INTEGER,after_action INTEGER,UNIQUE(turn,call_id));");db.prepare('INSERT INTO agents VALUES(?)').run(agent);
  const tx=<T>(run:()=>T)=>{db.exec('BEGIN IMMEDIATE');try{const value=run();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
  let dispatches=0,validation=0;
  const remote=createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url!.includes('/tools/execute/'))dispatches++;if(req.url!.endsWith('/toolkits/categories'))validation++;res.end(JSON.stringify(req.url!.includes('/connected_accounts')?{items:[{id:'ca_1',toolkit:{slug:'gmail'},status:'ACTIVE'}]}:req.url!.includes('/tools?')?{items:[rawTool('GMAIL_SEND_EMAIL',['createHint'])]}:{items:[]}));});
  const origin=await listen(remote),client=createComposio(db,tx,{database,baseURL:origin+'/api/v3.1'}),signal=new AbortController().signal;
  const identity=()=>String(db.prepare('SELECT user_id FROM composio_installation').get()!.user_id);
  try {
    for(const remove of [false,true]) {
      const revision=client.keyStatus().revision,oldIdentity=identity();
      const grantRevision=client.grants(agent)[0]?.revision??0;client.grant(randomUUID(),agent,'gmail',{revision:grantRevision,enabled:true});
      db.prepare("INSERT OR REPLACE INTO composio_auth_configs VALUES('gmail','ac_old')").run();
      const offered=await client.tools(agent),tool=offered[0];
      db.prepare('INSERT OR REPLACE INTO composio_policies VALUES(?,?,?,?,?)').run(agent,'old-policy','old-tool','ca_1','gmail');
      const pending:string[]=[];
      for(const state of ['approval','ready','running','uncertain']) {
        const turn=randomUUID();pending.push(turn);db.prepare("INSERT INTO turns VALUES(?,?,'running',0,1)").run(turn,agent);
        await client.call(turn,agent,{id:'call',type:'function',function:{name:composioToolName(tool.slug),arguments:'{"target":"test"}'}},0,signal,offered);
        if(state!=='approval')db.prepare('UPDATE composio_calls SET state=?,decision=? WHERE turn=?').run(state,'allow',turn);
      }
      // A failed transaction must keep the previous key, identity and permissions intact.
      db.exec("CREATE TRIGGER reject_key_reset BEFORE DELETE ON composio_policies BEGIN SELECT RAISE(ABORT,'synthetic reset failure'); END;");
      if(remove)assert.throws(()=>client.removeKey(randomUUID(),{revision}),/synthetic reset failure/);else await assert.rejects(client.saveKey(randomUUID(),{revision,key:'installation-key-one'}),/synthetic reset failure/);
      assert.equal(identity(),oldIdentity);assert.equal(client.keyStatus().revision,revision);assert.equal(client.grants(agent)[0].enabled,true);db.exec('DROP TRIGGER reject_key_reset');
      const id=randomUUID(),data={revision,...(remove?{}:{key:'installation-key-one'})};
      const result=remove?client.removeKey(id,data):await client.saveKey(id,data);
      assert.equal(result.revision,revision+1);assert.notEqual(identity(),oldIdentity);
      assert.equal(db.prepare('SELECT count(*) n FROM composio_auth_configs').get()!.n,0);assert.equal(db.prepare('SELECT count(*) n FROM composio_policies').get()!.n,0);
      assert.deepEqual(client.grants(agent),[{toolkit:'gmail',enabled:false,revision:grantRevision+2}]);
      const newGrant=client.grants(agent)[0];client.grant(randomUUID(),agent,'gmail',{revision:newGrant.revision,enabled:true});
      for(const turn of pending.slice(0,2)) {db.prepare("UPDATE turns SET status='running' WHERE id=?").run(turn);await client.resume(turn,agent,signal);assert.match(String(db.prepare('SELECT result FROM flow_tool_calls WHERE turn=?').get(turn)!.result),/access was removed/);await client.resume(turn,agent,signal);}
      for(const turn of pending.slice(2)) {assert.equal(db.prepare('SELECT state FROM composio_calls WHERE turn=?').get(turn)!.state,'uncertain');await assert.rejects(client.resume(turn,agent,signal),/uncertain/);}
      const turn=randomUUID();db.prepare("INSERT INTO turns VALUES(?,?,'running',0,1)").run(turn,agent);await assert.rejects(client.call(turn,agent,{id:'stale-offer',type:'function',function:{name:composioToolName(tool.slug),arguments:'{"target":"test"}'}},0,signal,offered),/revoked/);
      assert.equal(dispatches,0);
    }
    assert(validation>=2);
    for(const path of ['/api/connected-apps/key','/api/connected-apps/key/remove']) {const command={path,body:{id:randomUUID(),revision:3}};assert.deepEqual(restoreConnectedAppCommand(JSON.stringify(command)),command);assert.throws(()=>restoreConnectedAppCommand(JSON.stringify({...command,body:{...command.body,key:canary}})),/invalid/);}
  } finally {client.close();db.close();await stop(remote);rmSync(directory,{recursive:true,force:true});if(savedEnv===undefined)delete process.env.COMPOSIO_API_KEY;else process.env.COMPOSIO_API_KEY=savedEnv;}
});
