import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
    const agent=await request('/api/agents',{runtime:'api', id:randomUUID(),name:'Reader',model:'fixture',backupModel:'backup',instructions:'Help'}),path=`/api/agents/${agent.id}`;
    const side=await request(path+'/threads',{id:randomUUID(),name:'Side'}),room=await request('/api/channels',{id:randomUUID(),name:'Room',members:[agent.id],lead:agent.id,instructions:'Help'});
    for(const location of [path,`/api/threads/${side.id}`]){await run(location);assert(advertised);assert.deepEqual(result,{revision:1,providerAccount:'',model:'fixture',backupModel:'backup',configured:true});assert(!JSON.stringify(result).includes(secret));assert(!JSON.stringify(result).includes(baseURL));}
    args={agent:randomUUID()};await run(path);assert.deepEqual(result,{error:'Reading provider settings does not accept arguments.',status:400});args={};await run(`/api/channels/${room.id}`,'failed');assert.equal(advertised,false);
    assert.equal((await request('/api/agents')).agents[0].revision,1);
  } finally {await app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});}
});

test('model changes preserve execution snapshot, scope and journal across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-model-tool-'));
  let args: unknown = {}, result: any, hold = false, continued = false, answerOnly = false, advertised = false;
  let before: (() => Promise<unknown>) | undefined;
  const models: string[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); models.push(body.model);
    if (body.model === 'unavailable') { res.writeHead(503); res.end(); return; }
    advertised = body.tools.some((tool: any) => tool.function.name === 'set_provider_model');
    const last = body.messages.findLast((message: any) => message.role === 'tool');
    if (last) { result = JSON.parse(last.content); continued = true; if (hold) return; }
    else if (before) { const action = before; before = undefined; await action(); }
    const done = last || answerOnly;
    res.end(JSON.stringify({ choices: [{ finish_reason: done ? 'stop' : 'tool_calls', message: done ? { content: 'Model settings checked.' } : { tool_calls: [{ id: 'model', type: 'function', function: { name: 'set_provider_model', arguments: JSON.stringify(args) } }] } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(directory, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function request(path: string, body?: unknown) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  }
  async function wait(check: () => Promise<any>) { for (let n = 0; n < 300; n++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Timed out'); }
  async function until(path: string, id: string, status = 'done') { return wait(async () => (await request(path + '/turns')).find((row: any) => row.id === id && row.status === status)); }
  async function run(path: string, status = 'done') { const command = { id: randomUUID(), text: 'Set requested model' }; await request(path + '/turns', command); await until(path, command.id, status); await request(path + '/turns', command); return command.id; }
  try {
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Original', instructions: 'Help', model: 'first', backupModel: 'backup' });
    const other = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Other', instructions: 'Help', model: 'other' });
    const path = `/api/agents/${agent.id}`, profile = async () => (await request('/api/agents')).agents.find((row: any) => row.id === agent.id);
    const side = await request(path + '/threads', { id: randomUUID(), name: 'Side' });
    const room = await request('/api/channels', { id: randomUUID(), name: 'Room', members: [agent.id], lead: agent.id, instructions: 'Help' });
    args = { revision: 1, model: 'second' }; await run(path);
    assert(advertised); assert.deepEqual(models.slice(-2), ['first','first']);
    assert.deepEqual(result, { revision: 2, model: 'second', backupModel: 'backup', providerAccount: '' });
    answerOnly = true; await run(path); answerOnly = false; assert.equal(models.at(-1), 'second');
    args = { revision: 2, backupModel: '' }; await run(`/api/threads/${side.id}`); assert.equal(result.revision, 3); assert.equal((await profile()).backup_model, '');
    for (const bad of [{ revision: 2, model: 'stale' }, { revision: 3 }, { revision: 3, model: '' }, { revision: 3, model: 'x'.repeat(161) }, { revision: 3, model: 'bad\nmodel' }, { revision: 3, model: '\ud800' }, { revision: 3, backupModel: 'second' }, { revision: 3, backupModel: '\ud800' }, { revision: 3, providerAccount: '' }, { revision: 3, model: 'x', agent: other.id }, { revision: 3, apiKey: 'secret' }]) {
      args = bad; await run(path); assert([400,409].includes((result as any).status)); assert.equal((await profile()).revision, 3);
    }
    args = { revision: 3, model: 'channel' }; await run(`/api/channels/${room.id}`, 'failed'); assert.equal(advertised, false); assert.equal((await profile()).revision, 3);
    args = { revision: 3, model: 'third' }; hold = true; continued = false;
    const interrupted = randomUUID(); await request(path + '/turns', { id: interrupted, text: 'Switch model then wait' }); await wait(async () => continued);
    assert.equal((await profile()).revision, 4); assert.equal(models.at(-1), 'second');
    await app.close(); app = await startApp(options); hold = false;
    await request(path + '/edit', { id: randomUUID(), revision: 4, name: 'Original', instructions: 'Help', model: 'user-choice' });
    const stopped = await until(path, interrupted, 'interrupted');
    await request(`${path}/turns/${interrupted}/resume`, { id: randomUUID(), revision: stopped.revision, acknowledgeUncertain: true }); await until(path, interrupted);
    assert.equal(result.revision, 4); assert.equal(result.model, 'third'); assert.equal(models.at(-1), 'user-choice');
    assert.equal((await profile()).revision, 5); assert.equal((await profile()).model, 'user-choice');
    const cancelled = randomUUID(); args = { revision: 5, model: 'cancelled' }; before = () => request(`${path}/turns/${cancelled}/cancel`, { id: randomUUID() });
    await request(path + '/turns', { id: cancelled, text: 'Cancel before mutation' }); await until(path, cancelled, 'cancelled'); assert.equal((await profile()).revision, 5);
    assert.equal((await request('/api/agents')).agents.find((row: any) => row.id === other.id).model, 'other');
    const fallbackAgent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Fallback', instructions: 'Help', model: 'unavailable', backupModel: 'backup' });
    const fallbackPath = `/api/agents/${fallbackAgent.id}`, fallbackTurn = randomUUID();
    args = { revision: 1, model: 'fresh' }; hold = true; continued = false;
    await request(fallbackPath + '/turns', { id: fallbackTurn, text: 'Change after fallback' }); await wait(async () => continued);
    assert.deepEqual(models.slice(-3), ['unavailable','backup','backup']);
    await app.close(); app = await startApp(options); hold = false;
    const fallbackStopped = await until(fallbackPath, fallbackTurn, 'interrupted');
    await request(`${fallbackPath}/turns/${fallbackTurn}/resume`, { id: randomUUID(), revision: fallbackStopped.revision, acknowledgeUncertain: true }); await until(fallbackPath, fallbackTurn);
    assert.equal(models.at(-1), 'backup'); assert.equal(result.model, 'fresh'); assert.equal(result.revision, 2);
    answerOnly = true; await run(fallbackPath); answerOnly = false; assert.equal(models.at(-1), 'fresh');
    await app.close();
    const db = new DatabaseSync(options.database); db.exec("CREATE TRIGGER reject_model_journal BEFORE INSERT ON flow_tool_calls BEGIN SELECT RAISE(ABORT, 'synthetic journal failure'); END"); db.close();
    app = await startApp(options); args = { revision: 5, model: 'rollback' }; await run(path, 'failed');
    assert.equal((await profile()).revision, 5); assert.equal((await profile()).model, 'user-choice');
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
