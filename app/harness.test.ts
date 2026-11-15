import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './server.ts';
import { briefsipToolElicitation, harnessEnv, harnessAvailability, insideWorkspace, commandPrefix, type HarnessRuntime } from './harness.ts';
process.env.BRIEFSIP_HARNESS_CANARY = 'never-inherit-this-canary';
const fakeSource = readFileSync(new URL('./fixtures/fake-harness.mjs', import.meta.url), 'utf8');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function executable(directory: string) { const path = join(directory,'fake-harness'); writeFileSync(path, `#!${process.execPath}\n` + fakeSource.split('\n').slice(1).join('\n')); chmodSync(path,0o700); return path; }
async function fixture(runtime: HarnessRuntime, write = true) {
  const directory = mkdtempSync(join(tmpdir(),'briefsip-harness-')), workspace = join(directory,'workspace'); mkdirSync(workspace);
  const binary = executable(directory), agent = randomUUID(), minted: {agent: string;turn: string;id: string}[] = [], revoked: string[] = [];
  const options = { database:join(directory,'db.sqlite'), port:0, timeout:10_000, workspaces:[{agent,directory:workspace,write}], harness: { executables:{codex:binary,claude:binary}, issuer:{ mintAgentSession(input: {agent:string;turn:string}) { const id=randomUUID(); minted.push({...input,id});return {id,token:'test-mcp-session-token'}; }, revokeAgentSession(id:string) { revoked.push(id); } } } };
  let app = await startApp(options);
  const request = async (path:string, body?:unknown, expected=200) => { const response=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await response.json();assert(expected===200?response.ok:response.status===expected,JSON.stringify(data));return data; };
  const profile = { name:'Coder', model:'saved-api-model', instructions:'Help with coding.' };
  await request('/api/agents',{id:agent,...profile}); const path=`/api/agents/${agent}`;
  await request(path+'/edit',{id:randomUUID(),revision:1,...profile,runtime,confirmRuntime:true});
  const until = async (turn:string,predicate:(row:any)=>boolean) => { for(let i=0;i<600;i++){const row=(await request(path+'/turns')).find((row:any)=>row.id===turn);if(row&&predicate(row))return row;await delay(15);}assert.fail('Harness turn timed out'); };
  const send = async(text:string) => {const id=randomUUID();await request(path+'/turns',{id,text});return id;};
  return {directory,workspace,agent,path,profile,request,until,send,minted,revoked,options,get app(){return app;}, async editDatabase(edit: (db: DatabaseSync) => void){await app.close();const db=new DatabaseSync(options.database);try{edit(db);}finally{db.close();app=await startApp(options);}},async restart(){await app.close();app=await startApp(options);},async close(){await app.close();rmSync(directory,{recursive:true,force:true});}};
}
for(const runtime of ['codex','claude'] as const) {
  test(`${runtime}: gated segments replace only final answer, coalesce writes and restore without replay`, async () => {
    const f = await fixture(runtime);
    try {
      await f.editDatabase(db => db.exec('CREATE TABLE snapshot_writes(at INTEGER); CREATE TRIGGER count_snapshot_insert AFTER INSERT ON provider_streams BEGIN INSERT INTO snapshot_writes VALUES (1); END; CREATE TRIGGER count_snapshot_update AFTER UPDATE ON provider_streams BEGIN INSERT INTO snapshot_writes VALUES (1); END;'));
      const start = Date.now(), id = await f.send('STREAM_GATE');
      const partial = await f.until(id, row => row.partial?.text === 'Draft ' + 'x'.repeat(100));
      assert.equal(partial.status, 'running'); assert.equal(partial.partial.final, false);
      const segments = partial.activity.stream;
      assert.deepEqual(segments.map((item: any) => [item.ordinal, item.kind]), [[0, 'text'], [1, 'tool'], [2, 'text']]);
      assert.equal(segments[0].text, 'Before tool. ' + '🧪'.repeat(100) + '[REDACTED]');
      assert(!JSON.stringify(partial).includes('test-mcp-session-token'));
      assert.equal(partial.partial.segment, segments[2].id);
      const restored = (await f.request(f.path + '/turns')).find((row: any) => row.id === id);
      assert.deepEqual(restored.partial, partial.partial); assert.equal(f.minted.length, 1);
      writeFileSync(join(f.workspace, 'stream-release'), '');
      const done = await f.until(id, row => row.status === 'done');
      assert.equal(done.reply, 'Final answer.'); assert.equal(done.partial, null);
      assert.deepEqual(done.activity.stream.map((item: any) => [item.ordinal, item.id]), segments.map((item: any) => [item.ordinal, item.id]));
      assert.equal(done.activity.stream[2].text, done.reply); assert.equal(done.activity.stream[2].final, 1);
      let writes = 0;
      const elapsed = Date.now() - start;
      await f.editDatabase(db => { writes = Number(db.prepare('SELECT count(*) AS n FROM snapshot_writes').get()!.n); });
      assert(writes <= Math.ceil(elapsed / 40) + 8 && writes < 30, `Token-rate writes: ${writes}`);
      await f.restart();
      const final = (await f.request(f.path + '/turns')).find((row: any) => row.id === id);
      assert.equal(final.reply, 'Final answer.'); assert.deepEqual(final.activity.stream, done.activity.stream); assert.equal(f.minted.length, 1);
    } finally { await f.close(); }
  });
  test(`${runtime}: abort flush preserves final pending segment and stays unfinished after restart`, async () => {
    const f = await fixture(runtime);
    try {
      const id = await f.send('STREAM_GATE');
      await f.until(id, row => row.partial?.text === 'Draft ' + 'x'.repeat(100));
      await f.request(`${f.path}/turns/${id}/cancel`, { id: randomUUID() });
      await f.until(id, row => row.status === 'cancelled');
      for (let n = 0; n < 100 && !f.revoked.length; n++) await delay(10);
      await f.restart();
      const row = (await f.request(f.path + '/turns')).find((row: any) => row.id === id);
      assert.equal(row.partial.text, 'Draft ' + 'x'.repeat(100)); assert.equal(row.partial.final, false);
      assert.equal(row.partial.status, 'failed'); assert.equal(f.minted.length, 1); assert.equal(f.revoked.length, 1);
    } finally { await f.close(); }
  });
  test(`${runtime}: error flush commits buffered tail without declaring a final answer`, async () => {
    const f = await fixture(runtime);
    try {
      const id = await f.send('STREAM_CRASH');
      await f.until(id, row => row.partial?.text === 'Draft ' + 'x'.repeat(100));
      writeFileSync(join(f.workspace, 'stream-release'), '');
      const failed = await f.until(id, row => row.status === 'failed');
      assert.equal(failed.partial.text, 'Draft ' + 'x'.repeat(100) + ' buffered tail'); assert.equal(failed.partial.final, false);
      assert.equal(failed.partial.status, 'failed'); assert.equal(failed.activity.stream.at(-1).final, 0);
      await f.restart();
      assert.deepEqual((await f.request(f.path + '/turns')).find((row: any) => row.id === id).partial, failed.partial);
      assert.equal(f.minted.length, 1); assert.equal(f.revoked.length, 1);
    } finally { await f.close(); }
  });
  test(`${runtime}: authoritative snapshot and reply apply identical session-token redaction`, async () => {
    const f = await fixture(runtime);
    try {
      const id = await f.send('FINAL_SECRET'), done = await f.until(id, row => row.status === 'done');
      assert.equal(done.reply, 'finished [REDACTED]');
      assert.equal(done.activity.stream.at(-1).text, done.reply); assert(!JSON.stringify(done).includes('test-mcp-session-token'));
    } finally { await f.close(); }
  });
  test(`${runtime}: stream, tool activity, MCP lifetime, follow-up and restart resume`,async()=>{
    const f=await fixture(runtime);try {
      const streamController = new AbortController();
      const stream = await fetch(f.app.origin + f.path + '/turns/stream', { signal: streamController.signal });
      const reader = stream.body!.getReader();
      const first=await f.send('FIRST'),partial=await f.until(first,row=>row.partial?.text||row.status==='failed');assert.equal(partial.status,'running',partial.error);
      try {
        const frame = new TextDecoder().decode((await reader.read()).value);
        assert(frame.startsWith('data: '));
        const snapshot = JSON.parse(frame.split('\n\n')[0].slice(6));
        assert.equal(snapshot.id, first); assert.equal(snapshot.partial.text, ''); assert.equal(snapshot.partial.seq, partial.partial.seq);
      } finally { streamController.abort(); }

      const done=await f.until(first,row=>['done','failed'].includes(row.status));assert.equal(done.status,'done',done.error);assert.equal(done.reply,'finished');assert(done.activity.harness.length);assert.equal(done.activity.harness[0].state,'completed');
      const second=await f.send('SECOND');assert.equal((await f.until(second,row=>['done','failed'].includes(row.status))).status,'done');
      await f.restart();const third=await f.send('THIRD');assert.equal((await f.until(third,row=>['done','failed'].includes(row.status))).status,'done');
      const log=readFileSync(join(f.workspace,'fake-log.jsonl'),'utf8');assert(runtime==='codex'?log.includes('thread/resume'):log.includes('"resume":true'));assert.equal(f.minted.length,3);assert.deepEqual(f.revoked,f.minted.map(row=>row.id));
      const usage=await f.request('/api/usage');assert(usage.calls.some((call:any)=>call.input_tokens===11&&call.output_tokens===7));
    } finally {await f.close();}
  });
  test(`${runtime}: Steer degrades to linked Restart with partial context and fresh native session`, async () => {
    const f = await fixture(runtime); try {
      const first = await f.send('HOLD'); await f.until(first, row => !!row.partial?.text);
      const active = await f.request(f.path + '/dispatch'); assert.equal(active[0].capabilities.steer, false);
      const command = { id: randomUUID(), text: 'RESTART_FINISH', dispatchMode: 'steer', targetTurn: first };
      const receipt = await f.request(f.path + '/turns', command); assert.equal(receipt.dispatch_mode, 'restart'); assert.match(receipt.dispatch_label, /cannot steer/);
      const done = await f.until(command.id, row => ['done','failed'].includes(row.status)); assert.equal(done.status, 'done', done.error);
      assert.equal((await f.until(first, row => row.status === 'cancelled')).status, 'cancelled');
      assert.equal(done.activity.dispatch[0].source_turn, first);
      const log = readFileSync(join(f.workspace, 'fake-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const prompt = log.filter(row => row.type === 'turn').at(-1).prompt;
      assert.match(prompt, /Harness /); assert.match(prompt, /Never replay uncertain operations/);
      assert.equal(log.filter(row => runtime === 'codex' ? row.method === 'thread/resume' : row.type === 'init' && row.resume).length, 0);
      const count = f.minted.length; await f.restart(); assert.deepEqual(await f.request(f.path + '/turns', command), receipt); assert.equal(f.minted.length, count);
      const follow = await f.send('FOLLOW_RESTART_FINISH'); assert.equal((await f.until(follow, row => ['done','failed'].includes(row.status))).status, 'done');
      const later = readFileSync(join(f.workspace, 'fake-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const turns = later.filter(row => row.type === 'turn');
      assert.equal(turns.at(-1).session, turns.at(-2).session);
      assert.notEqual(turns.at(-1).session, turns[0].session);
      assert.equal(later.filter(row => runtime === 'codex' ? row.method === 'thread/resume' : row.type === 'init' && row.resume).length, 1);
    } finally { await f.close(); }
  });
  test(`${runtime}: durable approval allow, deny, prefix grant and scoped receipt`,async()=>{
    const f=await fixture(runtime);try {
      async function approval(decision:string){const id=await f.send('APPROVE'),row=await f.until(id,row=>row.harnessApprovals?.length||row.status==='failed');assert.equal(row.status,'running',row.error);const card=row.harnessApprovals[0];assert.equal(card.prefix,'echo hello');const body={id:randomUUID(),revision:card.revision,decision};await f.request(`${f.path}/turns/${id}/harness-approvals/${card.id}`,body);await f.request(`${f.path}/turns/${id}/harness-approvals/${card.id}`,body);const done=await f.until(id,row=>['done','failed'].includes(row.status));assert.equal(done.status,'done',done.error);assert.equal(done.reply,decision==='deny'?'denied':'finished');return id;}
      await approval('deny');await approval('allow');await approval('always');const fourth=await f.send('APPROVE');const fourthDone=await f.until(fourth,row=>['done','failed'].includes(row.status));assert.equal(fourthDone.status,'done',fourthDone.error);assert.equal(fourthDone.harnessApprovals.length,0);
      const peer=await f.request('/api/mcp-server/peer-tokens',{id:randomUUID(),name:'Peer',scopes:['agents:message']});
      const receipt=await fetch(f.app.origin+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${peer.token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'send_message',arguments:{requestId:randomUUID(),recipient:f.agent,text:'APPROVE peer work'}}})}).then(response=>response.json());
      const delivery=receipt.result.structuredContent,thread=`/api/threads/${delivery.thread}/turns`;
      let peerTurn:any;for(let n=0;n<600;n++){peerTurn=(await f.request(thread))[0];if(peerTurn?.harnessApprovals?.length)break;assert(!['done','failed'].includes(peerTurn?.status),'Peer bypassed saved command approval');await delay(15);}
      assert.equal(peerTurn.harnessApprovals[0].state,'approval');const peerCard=peerTurn.harnessApprovals[0];
      await f.request(`${thread}/${delivery.turn}/harness-approvals/${peerCard.id}`,{id:randomUUID(),revision:peerCard.revision,decision:'deny'});
      for(let n=0;n<600;n++){peerTurn=(await f.request(thread))[0];if(peerTurn.status==='done')break;await delay(15);}assert.equal(peerTurn.reply,'denied');
      const secret=await f.send('APPROVE_SECRET'),row=await f.until(secret,row=>row.harnessApprovals?.length),card=row.harnessApprovals[0];
      assert.equal(card.prefix,null);assert(!JSON.stringify(card).includes('test-mcp-session-token'));assert.match(card.command,/\[redacted\]/);
      await f.request(`${f.path}/turns/${secret}/harness-approvals/${card.id}`,{id:randomUUID(),revision:card.revision,decision:'always'},400);
      await f.request(`${f.path}/turns/${secret}/harness-approvals/${card.id}`,{id:randomUUID(),revision:card.revision,decision:'deny'});
      assert.equal((await f.until(secret,row=>['done','failed'].includes(row.status))).reply,'denied');
      assert.equal(f.minted.length,6);assert.equal(f.revoked.length,6);
    } finally {await f.close();}
  });
  test(`${runtime}: workspace write policy, outside-file and network consent`,async()=>{
    const f=await fixture(runtime);try{
      const inside=await f.send('WORKSPACE_WRITE');const done=await f.until(inside,row=>['done','failed'].includes(row.status));assert.equal(done.status,'done',done.error);assert.equal(done.harnessApprovals.length,0);
      for(const [text,kind] of [['OUTSIDE_FILE','file'],['NETWORK','network']]){
        const id=await f.send(text),row=await f.until(id,row=>row.harnessApprovals?.length||row.status==='failed');assert.equal(row.status,'running',row.error);const card=row.harnessApprovals[0];assert.equal(card.kind,kind);assert.equal(card.prefix,null);
        await f.request(`${f.path}/turns/${id}/harness-approvals/${card.id}`,{id:randomUUID(),revision:card.revision,decision:'always'},400);
        await f.request(`${f.path}/turns/${id}/harness-approvals/${card.id}`,{id:randomUUID(),revision:card.revision,decision:'deny'});
        assert.equal((await f.until(id,row=>['done','failed'].includes(row.status))).reply,'denied');
      }
    }finally{await f.close();}
    const read=await fixture(runtime,false);try{
      const id=await read.send('READ_ONLY_WRITE'),row=await read.until(id,row=>row.harnessApprovals?.length||row.status==='failed');assert.equal(row.status,'running',row.error);const card=row.harnessApprovals[0];assert.equal(card.kind,'file');
      await read.request(`${read.path}/turns/${id}/harness-approvals/${card.id}`,{id:randomUUID(),revision:card.revision,decision:'allow'});assert.equal((await read.until(id,row=>['done','failed'].includes(row.status))).status,'done');
    }finally{await read.close();}
  });
  test(`${runtime}: crash fails once, preserves unfinished text and never replays`,async()=>{
    const f=await fixture(runtime);try {const id=await f.send('CRASH'),row=await f.until(id,row=>row.status==='failed');assert.match(row.error,/stopped before completion|could not start/);assert.equal(row.partial.text,'Harness ');await f.restart();await delay(100);assert.equal(f.minted.length,1);assert.equal(f.revoked.length,1);}finally{await f.close();}
  });
  test(`${runtime}: cancel kills descendants and revokes MCP; mid-turn runtime switch refused`,async()=>{
    const f=await fixture(runtime);try {const id=await f.send('HOLD');await f.until(id,row=>row.partial?.text);await f.request(f.path+'/edit',{id:randomUUID(),revision:2,...f.profile,runtime:'api',confirmRuntime:true},409);await f.request(`${f.path}/turns/${id}/cancel`,{id:randomUUID()});await f.until(id,row=>row.status==='cancelled');for(let i=0;i<200&&!f.revoked.length;i++)await delay(10);assert.equal(f.revoked.length,1);const log=readFileSync(join(f.workspace,'fake-log.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));const descendant=log.find(row=>row.type==='descendant');assert(descendant);let alive=true;try{const state=readFileSync(`/proc/${descendant.pid}/stat`,'utf8');alive=!state.includes(') Z ');}catch{alive=false;}assert.equal(alive,false,'Harness descendant survived cancel');}finally{await f.close();}
  });
  test(`${runtime}: pending approval expires on shutdown/restart, no auto approval`,async()=>{
    const f=await fixture(runtime);try {const id=await f.send('APPROVE'),row=await f.until(id,row=>row.harnessApprovals?.length);const card=row.harnessApprovals[0];await f.restart();const expired=(await f.request(f.path+'/turns')).find((row:any)=>row.id===id);assert.equal(expired.harnessApprovals[0].state,'expired');assert.equal(f.revoked.length,1);await f.request(`${f.path}/turns/${id}/harness-approvals/${card.id}`,{id:randomUUID(),revision:card.revision,decision:'allow'},409);assert.equal(f.minted.length,1);}finally{await f.close();}
  });
  test(`${runtime}: bounded output fails without replay`,async()=>{const f=await fixture(runtime);try{const id=await f.send('OVERSIZE'),row=await f.until(id,row=>row.status==='failed');assert.match(row.error,/output line exceeded/);assert.equal(f.minted.length,1);assert.equal(f.revoked.length,1);}finally{await f.close();}});
}
test('environment excludes credential and loader canaries; workspace symlink and prefix limits',()=>{
  const directory=mkdtempSync(join(tmpdir(),'briefsip-harness-boundary-'));try{mkdirSync(join(directory,'work'));symlinkSync('/tmp',join(directory,'work','escape'));const env=harnessEnv({PATH:'/usr/bin',HOME:'/fake',LANG:'C',OPENAI_API_KEY:'canary',COMPOSIO_API_KEY:'canary',NODE_OPTIONS:'canary'});assert.deepEqual(Object.keys(env).sort(),['HOME','LANG','PATH']);assert(insideWorkspace(join(directory,'work'),'new.txt'));assert(!insideWorkspace(join(directory,'work'),'escape/new.txt'));assert(!insideWorkspace(join(directory,'work'),'../outside'));assert.equal(commandPrefix('echo hello'),'echo hello');assert.equal(commandPrefix('echo hello; curl attacker'),null);}finally{rmSync(directory,{recursive:true,force:true});}
});
test('runtime changes require confirmation, revision and workspace; missing binary disabled',async()=>{
  const f=await fixture('codex');try{await f.request(f.path+'/edit',{id:randomUUID(),revision:2,...f.profile,runtime:'api'},409);await f.request(f.path+'/edit',{id:randomUUID(),revision:1,...f.profile,runtime:'api',confirmRuntime:true},409);const command={id:randomUUID(),revision:2,...f.profile,runtime:'api',confirmRuntime:true};await f.request(f.path+'/edit',command);await f.request(f.path+'/edit',command);const directory=await f.request('/api/agents');assert.equal(directory.agents[0].runtime,'api');assert.equal(directory.agents[0].revision,3);const other=await f.request('/api/agents',{id:randomUUID(),...f.profile});const choices=await f.request(`/api/agents/${other.id}/runtimes`);assert(choices.choices.every((choice:any)=>!choice.enabled));await f.request(`/api/agents/${other.id}/edit`,{id:randomUUID(),revision:1,...f.profile,runtime:'codex',confirmRuntime:true},400);assert.equal((await harnessAvailability('codex',null)).available,false);}finally{await f.close();}
});

test('codex MCP elicitations: only Briefsip form approvals are accepted once; others decline', () => {
  const form = (properties: Record<string, unknown>, required: string[] = []) => ({ serverName: 'briefsip', threadId: 't', mode: 'form', message: 'Allow list_agents?', requestedSchema: { type: 'object', properties, required } });
  assert.deepEqual(briefsipToolElicitation(form({ decision: { type: 'string', enum: ['accept', 'acceptAlways', 'decline'] } }, ['decision'])), { action: 'accept', content: { decision: 'accept' } });
  assert.deepEqual(briefsipToolElicitation(form({ persist: { type: 'boolean' } })), { action: 'accept', content: { persist: false } });
  assert.deepEqual(briefsipToolElicitation(form({})), { action: 'accept', content: {} });
  assert.deepEqual(briefsipToolElicitation(form({ reason: { type: 'string' } }, ['reason'])), { action: 'decline' });
  assert.deepEqual(briefsipToolElicitation({ ...form({}), serverName: 'other-server' }), { action: 'decline' });
  assert.deepEqual(briefsipToolElicitation({ serverName: 'briefsip', threadId: 't', mode: 'url', url: 'https://example.com' }), { action: 'decline' });
});
