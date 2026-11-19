import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { testDatabase } from './test-support/database.ts';
import { startApp } from './test-bridge.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, hub = false) {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-delete-')), database = join(dir, 'state.sqlite');
  const options = { database, ...(hub ? {hubLink: {origin:'https://hub.example.test',hubSigningPublicKey:generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).toString('base64url')}} : {}) };
  let app = await startApp(options);
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  async function request(path: string, body?: unknown, status = 200, headers: Record<string,string> = {}) {
    const res = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type':'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json(); assert.equal(res.status, status, JSON.stringify(data)); return data;
  }
  const create = (name: string) => request('/api/agents', { runtime: 'api', id: randomUUID(), name, model:'fixture', instructions:'Help' }, 201);
  return { dir, database, request, create, async seed(fn: (db: DatabaseSync) => void) { await app.close(); const db = testDatabase(database); db.exec('PRAGMA foreign_keys=ON'); try { fn(db); } finally { db.close(); app = await startApp(options); } } };
}

test('delete cascades every agent FK, scoped data, workflows, desktop and journals, preserving room history and shared resources', async t => {
  const f = await fixture(t), a = await f.create('Delete me'), b = await f.create('Keep me');
  const thread = await f.request(`/api/agents/${a.id}/threads`, {id:randomUUID(),name:'Private'});
  const channel = await f.request('/api/channels', {id:randomUUID(),name:'Room',instructions:'Help',lead:a.id,members:[a.id,b.id]}, 201);
  const direct=randomUUID(), room=randomUUID(), file=randomUUID(), routine=randomUUID(), workflow=randomUUID(), run=randomUUID(), connection=randomUUID();
  const desktop=join(f.dir,'agent-desktops',a.id); mkdirSync(desktop,{recursive:true});writeFileSync(join(desktop,'profile'),'synthetic');
  await f.seed(db => {
    db.prepare("INSERT INTO turns(id,agent,thread,text,reply,status,created) VALUES (?,?,?,'private','private reply','done','fixture')").run(direct,a.id,thread.id);
    db.prepare("INSERT INTO turns(id,agent,channel,text,reply,status,created) VALUES (?,?,?,'shared','past answer','done','fixture')").run(room,a.id,channel.id);
    db.prepare('INSERT INTO room_discussions(root,members,lead,mentioned,fallback) VALUES (?,?,?,0,1)').run(room,JSON.stringify([a.id,b.id]),a.id);
    db.prepare('INSERT INTO room_turns(turn,root,round,processed) VALUES (?,?,0,1)').run(room,room);
    db.prepare("INSERT INTO room_messages(root,turn,kind,agent,text) VALUES (?,?,'reply',?,'past answer')").run(room,room,a.id);
    db.prepare("INSERT INTO files(id,scope,name,digest,bytes,created) VALUES (?,?,'private.txt','digest',?,'fixture')").run(file,`threads:${thread.id}`,Buffer.from('secret'));
    db.prepare("INSERT INTO generated_files(turn,file,call_id,call,after_action) VALUES (?,?,'file','{}',0)").run(direct,file);
    db.prepare("INSERT INTO memories(scope,id,text,essential,revision,removed) VALUES (?,?,'private memory',1,1,0)").run(`agents:${a.id}`,randomUUID());
    db.prepare("INSERT INTO routines(id,agent,name,prompt,next_at,interval_ms,enabled,revision,trigger) VALUES (?,?,'Timer','Help',0,NULL,0,1,'schedule')").run(routine,a.id);
    db.prepare("INSERT INTO routine_runs(routine,turn,missed,source) VALUES (?,?,0,'test')").run(routine,direct);
    db.prepare("INSERT INTO workflows(id,agent,name,revision,deleted) VALUES (?,?,'Flow',1,0)").run(workflow,a.id);
    const graph=JSON.stringify({entry:'out',maxSteps:1,nodes:[{id:'out',kind:'output'}]});
    db.prepare('INSERT INTO workflow_versions VALUES (?,1,?)').run(workflow,graph);
    db.prepare("INSERT INTO workflow_runs(id,workflow,version,agent,graph,input,last,cursor,steps,revision,status,created) VALUES (?,?,1,?,?,'input','result','out',1,1,'done','fixture')").run(run,workflow,a.id,graph);
    db.prepare("INSERT INTO workflow_steps(run,seq,node,turn,status) VALUES (?,1,'out',?,'done')").run(run,direct);
    db.prepare("INSERT INTO workflow_schedules VALUES (?,1,0,NULL,'input',0)").run(workflow);
    db.prepare('INSERT INTO agent_avatars VALUES (?,1,?)').run(a.id,Buffer.from('image'));
    db.prepare('INSERT INTO agent_visibility VALUES (?,1,1)').run(a.id);
    db.prepare('UPDATE sidebar SET sections=? WHERE id=1').run(JSON.stringify([{id:randomUUID(),name:'Team',agents:[a.id,b.id]}]));
    db.prepare('INSERT INTO agent_computers VALUES (?,1,1)').run(a.id);
    db.prepare("INSERT INTO computer_control VALUES (?,'agent',?,'fixture',1)").run(a.id,a.id);
    db.prepare("INSERT INTO mcp_connections VALUES (?,'Shared','https://example.test','encrypted','[]',0,1)").run(connection);
    db.prepare("INSERT INTO mcp_grants VALUES (?,?,1,'[]')").run(a.id,connection);
    db.prepare("INSERT INTO composio_grants VALUES (?,'github',1,1)").run(a.id);
    db.prepare("INSERT INTO composio_policies VALUES (?,'fingerprint','tool','account','github')").run(a.id);
    db.prepare("INSERT INTO composio_policy_projects VALUES ('fingerprint','project')").run();
    for (const agent of [a.id,b.id]) db.prepare("INSERT INTO composio_policies VALUES (?,'shared','tool','account','github')").run(agent);
    db.prepare("INSERT INTO composio_policy_projects VALUES ('shared','shared-project')").run();
    db.prepare('INSERT INTO queue_positions VALUES (?,1)').run(direct);
    db.prepare("INSERT INTO workspace_checkpoints VALUES (?,?,'/synthetic','refs/briefsip/checkpoints/synthetic','hash','pruned',0)").run(direct,a.id);
    db.prepare('INSERT INTO memory_commands VALUES (?,?,?)').run(randomUUID(),JSON.stringify({scope:`agents:${a.id}`,agent:a.id}),JSON.stringify({id:file}));
  });
  const command={id:randomUUID()}, path=`/api/agents/${a.id}/delete`;
  assert.deepEqual(await f.request(path,command),{deleted:true});
  assert.deepEqual(await f.request(path,command),{deleted:true});
  assert.deepEqual(await f.request(path,{id:randomUUID()}),{deleted:true});
  assert(!existsSync(desktop));
  assert.deepEqual((await f.request('/api/agents')).agents.map((agent:any)=>agent.id),[b.id]);
  await f.request(`/api/agents/${a.id}/turns`,undefined,404); await f.request(`/api/threads/${thread.id}`,undefined,404);
  const turns=await f.request(`/api/channels/${channel.id}/turns`);
  assert.equal(turns.length,1); assert.equal(turns[0].reply,'past answer');assert.equal(turns[0].agent_name,'Deleted agent');assert.equal(turns[0].room.messages[0].name,'Deleted agent');
  await f.request('/api/agents',{runtime:'api', id:a.id,name:'Revive',model:'fixture',instructions:'Help'},409);
  await f.seed(db => {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    // Across every referencing FK, not just the known populated examples.
    for(const {name} of db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()) for(const fk of db.prepare(`PRAGMA foreign_key_list("${name}")`).all()) if(fk.table==='agents') assert.equal(db.prepare(`SELECT count(*) n FROM "${name}" WHERE "${fk.from}"=?`).get(a.id)!.n,0,`${name}.${fk.from}`);
    for(const table of ['threads','routines','workflow_runs','workflow_steps','workflow_schedules','workflows','files','memories','memory_commands','workspace_checkpoints']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0,table);
    assert.deepEqual(db.prepare('SELECT fingerprint,project FROM composio_policy_projects').all().map(row=>({...row})),[{fingerprint:'shared',project:'shared-project'}]);
    assert.equal(db.prepare('SELECT agent FROM composio_policies').get()!.agent,b.id);
    assert.deepEqual(JSON.parse(String(db.prepare('SELECT sections FROM sidebar').get()!.sections))[0].agents,[b.id]);
    assert.equal(db.prepare('SELECT count(*) n FROM mcp_connections').get()!.n,1);
    assert.equal(db.prepare('SELECT count(*) n FROM channels').get()!.n,1);
  });
});

test('delete guards last agent, active/paused/queued work, unknown IDs, cross origin, bearer/peer/script views and hub grant ownership', async t => {
  const f=await fixture(t,true),a=await f.create('Owner agent');
  const path=`/api/agents/${a.id}/delete`, command={id:randomUUID()};
  await f.request(path,command,409);const b=await f.create('Other');
  await f.request(path,command,403,{Origin:'https://foreign.test'});
  await f.request(path,command,403,{Authorization:'Bearer peer-token'});
  await f.request(`/api/peer/agents/${a.id}/delete`,command,404,{Authorization:'Bearer peer-token'});
  await f.request(`/api/scripts/agents/${a.id}/delete`,command,403);
  await f.request(path,{...command,force:true},400);
  await f.request(`/api/agents/${randomUUID()}/delete`,command,404);
  const turn=randomUUID();
  await f.seed(db=>db.prepare("INSERT INTO turns(id,agent,text,status,created,paused) VALUES (?,?,'waiting','queued','fixture',1)").run(turn,a.id));
  await f.request(path,command,409);
  await f.seed(db=>db.prepare("UPDATE turns SET status='cancelled',paused=0 WHERE id=?").run(turn));
  const projectId=randomUUID(),participationId=randomUUID(),otherParticipation=randomUUID();
  await f.seed(db=>{
    db.prepare('INSERT INTO hub_link_grants VALUES (?,?,?,1)').run(projectId,participationId,JSON.stringify({projectId,participationId,localAgentId:a.id,agentId:a.id,revision:1}));
    db.prepare('INSERT INTO hub_link_grants VALUES (?,?,?,1)').run(projectId,otherParticipation,JSON.stringify({projectId,participationId:otherParticipation,localAgentId:b.id,agentId:b.id,revision:1}));
  });
  await f.request(path,command);
  await f.seed(db=>{
    assert.equal(db.prepare('SELECT count(*) n FROM hub_link_grants').get()!.n,1);
    assert.equal(db.prepare('SELECT participation_id FROM hub_link_withdrawals').get()!.participation_id,participationId);
  });
});

test('delete preserves coordination journals until another agent finishes its dependent work', async t => {
  const f = await fixture(t), a = await f.create('Target'), b = await f.create('Working'), turn = randomUUID();
  await f.seed(db => {
    db.prepare("INSERT INTO turns(id,agent,text,status,created,paused) VALUES (?,?,'waiting','queued','fixture',1)").run(turn,b.id);
    db.prepare("INSERT INTO coordination(turn,owner,target,kind,prompt,call) VALUES (?,?,?,'message','help','{}')").run(turn,b.id,a.id);
  });
  const path = `/api/agents/${a.id}/delete`, command = {id:randomUUID()};
  await f.request(path,command,409);
  await f.seed(db => {
    assert.equal(db.prepare('SELECT count(*) n FROM coordination').get()!.n,1);
    assert(db.prepare('SELECT 1 FROM agents WHERE id=?').get(a.id));
    db.prepare("UPDATE turns SET status='cancelled',paused=0 WHERE id=?").run(turn);
  });
  await f.request(path,command);
  await f.seed(db => {
    assert(db.prepare('SELECT 1 FROM turns WHERE id=?').get(turn));
    assert.equal(db.prepare('SELECT count(*) n FROM coordination').get()!.n,0);
  });
});

test('running provider work must settle before delete; transactional failure preserves agent and desktop for retry', async t => {
  const {createServer}=await import('node:http');
  let release: (()=>void)|undefined, started=false;
  const provider=createServer(async (req,res)=>{
    for await(const chunk of req) { void chunk; }
    started=true;await new Promise<void>(resolve=>{release=resolve;});
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Finished'}}]}));
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const address=provider.address();assert(address&&typeof address!=='string');
  const dir=mkdtempSync(join(tmpdir(),'briefsip-delete-running-')),database=join(dir,'state.sqlite');
  let app=await startApp({database,baseURL:`http://127.0.0.1:${address.port}/v1`}, { directory: dir, servers: [provider] });
  t.after(async()=>{release?.();await app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});});
  async function post(path:string,body:unknown,status=200){const res=await fetch(app.origin+path,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await res.json();assert.equal(res.status,status,JSON.stringify(data));return data;}
  const agent=randomUUID(),other=randomUUID(),turn=randomUUID(),command={id:randomUUID()},path=`/api/agents/${agent}/delete`;
  for(const id of [agent,other])await post('/api/agents',{runtime:'api', id,name:'Agent',model:'fixture',instructions:'Help'},201);
  await post(`/api/agents/${agent}/turns`,{id:turn,text:'Hold'},202);
  for(let n=0;n<100&&!started;n++)await new Promise(resolve=>setTimeout(resolve,20));assert(started);
  await post(path,command,409);release!();
  for(let n=0;n<100;n++){const turns=await(await fetch(app.origin+`/api/agents/${agent}/turns`)).json();if(turns[0].status==='done')break;await new Promise(resolve=>setTimeout(resolve,20));}
  await app.close();
  const desktop=join(dir,'agent-desktops',agent);mkdirSync(desktop,{recursive:true});writeFileSync(join(desktop,'synthetic'),'saved');
  const db=testDatabase(database);db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON agents BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");db.close();
  app=await startApp({database});await post(path,command,500);assert(existsSync(desktop));await app.close();
  const retry=testDatabase(database);assert(retry.prepare('SELECT 1 FROM agents WHERE id=?').get(agent));assert(retry.prepare('SELECT 1 FROM turns WHERE id=?').get(turn));retry.exec('DROP TRIGGER fail_delete');retry.close();
  app=await startApp({database});await post(path,command);assert(!existsSync(desktop));
});

test('paired peer cannot delete owner agents; deletion on owner refreshes peer roster', async t=>{
  const {fakePeerTokenIssuer}=await import('./test-support/peer-token-issuer.ts');
  const dir=mkdtempSync(join(tmpdir(),'briefsip-delete-peer-')),issuer=fakePeerTokenIssuer();
  const owner=await startApp({database:join(dir,'owner.sqlite'),peerTokenIssuer:issuer}),peer=await startApp({database:join(dir,'peer.sqlite'),peerTokenIssuer:fakePeerTokenIssuer()});
  t.after(async()=>{await owner.close();await peer.close();rmSync(dir,{recursive:true,force:true});});
  async function post(app:{origin:string},path:string,body:unknown,status=200,token?:string){const res=await fetch(app.origin+path,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});assert.equal(res.status,status,await res.clone().text());return res.json();}
  const agent=randomUUID();for(const id of [agent,randomUUID()])await post(owner,'/api/agents',{runtime:'api', id,name:'Owner',model:'fixture',instructions:'Help'},201);
  const code=await post(owner,'/api/pairing-codes',{id:randomUUID()});await post(peer,'/api/machines',{id:randomUUID(),origin:owner.origin,code:code.code});
  const token=issuer.issued[0];assert(token);
  await post(owner,`/api/agents/${agent}/delete`,{id:randomUUID()},403,token);
  await post(owner,`/api/peer/agents/${agent}/delete`,{id:randomUUID()},404,token);
  await post(owner,`/api/agents/${agent}/delete`,{id:randomUUID()});await peer.refreshMachines();
  const machines=await(await fetch(peer.origin+'/api/machines')).json();assert(!machines.machines[0].agents.some((item:any)=>item.id===agent));
});

test('owned Git checkpoint refs clean up durably without removing project files; failed cleanup retries',async t=>{
  const {execFileSync}=await import('node:child_process');
  const f=await fixture(t),a=await f.create('Delete'),b=await f.create('Keep');void b;
  const workspace=join(f.dir,'project');mkdirSync(workspace);writeFileSync(join(workspace,'keep.txt'),'Shared project');
  const git=(...args:string[])=>execFileSync('git',['-C',workspace,...args],{encoding:'utf8'}).trim();
  git('init','--quiet');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--quiet','-m','Synthetic');
  const hash=git('rev-parse','HEAD'),turn=randomUUID(),ref=`refs/briefsip/checkpoints/${turn}`;
  git('update-ref',ref,hash);
  await f.seed(db=>{
    db.prepare("INSERT INTO turns(id,agent,text,status,created) VALUES (?,?,'done','done','fixture')").run(turn,a.id);
    db.prepare("INSERT INTO workspace_checkpoints VALUES (?,?,?,?,?,'done',0)").run(turn,a.id,workspace,ref,hash);
  });
  // Deliberately change the recorded directory, so DB deletion succeeds but ref unlink fails.
  await f.seed(db=>db.prepare('UPDATE workspace_checkpoints SET directory=? WHERE agent=?').run(join(f.dir,'missing'),a.id));
  const path=`/api/agents/${a.id}/delete`,command={id:randomUUID()};await f.request(path,command,400);
  await f.seed(db=>{
    assert(!db.prepare('SELECT 1 FROM agents WHERE id=?').get(a.id));
    assert(db.prepare('SELECT 1 FROM agent_delete_checkpoints WHERE agent=?').get(a.id));
    db.prepare('UPDATE agent_delete_checkpoints SET directory=? WHERE agent=?').run(workspace,a.id);
  });
  await f.request(path,command);assert(existsSync(join(workspace,'keep.txt')));
  assert.equal(git('for-each-ref','--format=%(refname)',ref),'');
  await f.seed(db=>assert.equal(db.prepare('SELECT count(*) n FROM agent_delete_checkpoints').get()!.n,0));
});
