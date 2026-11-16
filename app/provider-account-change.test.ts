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
    const agent=await request('/api/agents',{runtime:'api', id:randomUUID(),name:'Owner',instructions:'Help',model:'old',backupModel:'fallback',providerAccount:'a'}),path=`/api/agents/${agent.id}`;
    const profile=async()=>(await request('/api/agents')).agents.find((row:any)=>row.id===agent.id);
    async function pending(revision:number,location=path){command={revision,providerAccount:'b',model:'new'};const id=randomUUID();await request(location+'/turns',{id,text:'Switch to B'});const row=await until(location,id,row=>row.questions?.length||row.status==='failed');return {id,row,answerPath:`${location}/turns/${id}/questions/${row.questions?.[0]?.id}/answer`};}
    const first=await pending(1);assert(advertised);assert.equal(first.row.paused,1);assert.match(first.row.questions[0].prompt,/Account B/);assert.match(first.row.questions[0].prompt,/History and attachments/);assert(!JSON.stringify(first.row.questions).includes('secret-b'));
    assert.equal((await profile()).provider_account,'a');assert(calls.every(call=>call.path.startsWith('/a/')));
    await request(path+'/scripts',{id:randomUUID(),revision:0,enabled:true});
    await request(`/api/scripts/agents/${agent.id}/turns/${first.id}/questions/${first.row.questions[0].id}/answer`,{id:randomUUID(),text:'Approve account change'},403,true);
    const busySide=await request(path+'/threads',{id:randomUUID(),name:'Busy'}),busyPath=`/api/threads/${busySide.id}`,busy=randomUUID();hold=true;
    await request(busyPath+'/turns',{id:busy,text:'Hold'});await until(busyPath,busy,row=>row.status==='running');
    await request(first.answerPath,{id:randomUUID(),text:'Approve account change'},409);assert.equal((await profile()).provider_account,'a');
    await request(`${busyPath}/turns/${busy}/cancel`,{id:randomUUID()});hold=false;
    await app.close();
    let db=new DatabaseSync(options.database);db.exec("CREATE TRIGGER reject_consent_receipt BEFORE INSERT ON question_answers BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END");db.close();
    app=await startApp(options);
    const answer={id:randomUUID(),text:'Approve account change',acknowledgeUncertain:true};
    await request(first.answerPath,answer,500);assert.equal((await profile()).provider_account,'a');assert.equal((await profile()).backup_model,'fallback');assert.equal((await profile()).revision,1);
    assert.equal((await request(path+'/turns')).find((row:any)=>row.id===first.id).questions[0].answer,null);assert(calls.every(call=>call.path.startsWith('/a/')));
    await app.close();db=new DatabaseSync(options.database);db.exec('DROP TRIGGER reject_consent_receipt');db.close();app=await startApp(options);
    await request(first.answerPath,answer);
    await until(path,first.id,row=>row.status==='done');assert.equal((await profile()).provider_account,'b');assert.equal((await profile()).model,'new');assert.equal((await profile()).backup_model,'');assert.deepEqual(calls.at(-1),{path:'/b/v1/chat/completions',model:'new'});
    const count=calls.length;await request(first.answerPath,answer);assert.equal(calls.length,count);assert.equal((await profile()).revision,2);
    await request(path+'/edit',{id:randomUUID(),revision:2,name:'Owner',instructions:'Help',model:'old',providerAccount:'a'});
    const side=await request(path+'/threads',{id:randomUUID(),name:'Side'}),sidePath=`/api/threads/${side.id}`,rejected=await pending(3,sidePath);
    await request(rejected.answerPath,{id:randomUUID(),text:'Cancel'});await until(sidePath,rejected.id,row=>row.status==='done');assert.equal((await profile()).provider_account,'a');
    const stale=await pending(3);
    toolName='set_provider_model';command={revision:3,model:'changed'};const editing=randomUUID();await request(sidePath+'/turns',{id:editing,text:'Change model'});await until(sidePath,editing,row=>row.status==='done');toolName='set_provider_account';
    await request(stale.answerPath,{id:randomUUID(),text:'Approve account change',acknowledgeUncertain:true},409);assert.equal((await profile()).provider_account,'a');
    await request(stale.answerPath,{id:randomUUID(),text:'Cancel',acknowledgeUncertain:true});await until(path,stale.id,row=>row.status==='done');
    const changed=await pending(4);await app.close();app=await startApp({...options,accounts:[accounts[0],{...accounts[1],baseURL:base+'/changed/v1'}]});
    await request(changed.answerPath,{id:randomUUID(),text:'Approve account change',acknowledgeUncertain:true},409);assert.equal((await profile()).revision,4);
    await request(changed.answerPath,{id:randomUUID(),text:'Cancel',acknowledgeUncertain:true});await until(path,changed.id,row=>row.status==='done');
    const room=await request('/api/channels',{id:randomUUID(),name:'Room',members:[agent.id],lead:agent.id,instructions:'Help'});
    const denied=await pending(4,`/api/channels/${room.id}`);assert.equal(denied.row.status,'failed');assert(!advertised);assert.equal((await profile()).revision,4);
  } finally {await app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});}
});

test('provider account metadata tool redacts credentials and paths', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-account-list-'));
  const results: unknown[] = [];
  let args = '{}', advertised = false;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    advertised = body.tools.some((tool: any) => tool.function.name === 'list_provider_accounts');
    const result = body.messages.findLast((row: any) => row.role === 'tool');
    if (result) results.push(JSON.parse(result.content));
    res.end(JSON.stringify({ choices: [{ finish_reason: result ? 'stop' : 'tool_calls', message: result ? { content: 'Listed' } : { tool_calls: [{ id: 'list', type: 'function', function: { name: 'list_provider_accounts', arguments: args } }] } }] }));
  });
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address(); assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const options = { database: join(directory, 'db.sqlite'), port: 0, accounts: [{ id: 'main', name: 'Main', provider: 'openai-compatible', baseURL: base + '/secret/path', apiKey: 'private', defaultModel: 'fixture' }] };
    app = await startApp(options);
    async function request(path: string, body?: unknown) {
      const response = await fetch(app!.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app!.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
    }
    async function send(path: string, status = 'done') {
      const id = randomUUID(); await request(path + '/turns', { id, text: 'List accounts', ...(path.includes('/channels/') ? { recipient: agent.id } : {}) });
      for (let n = 0; n < 300; n++) {
        const row = (await request(path + '/turns')).find((item: any) => item.id === id);
        if (row && ['done', 'failed'].includes(row.status)) { assert.equal(row.status, status, row.error); return; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('Account list timed out');
    }
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'List', model: 'fixture', instructions: 'Help', providerAccount: 'main' });
    const path = `/api/agents/${agent.id}`;
    const expected = [{ id: '', name: 'Default server', provider: 'openai-compatible', origin: null, defaultModel: '', configured: false }, { id: 'main', name: 'Main', provider: 'openai-compatible', origin: base, defaultModel: 'fixture', configured: true }];
    await send(path); assert(advertised); assert.deepEqual(results.at(-1), expected);
    await app.close(); app = await startApp(options);
    const side = await request(path + '/threads', { id: randomUUID(), name: 'Side' });
    await send(`/api/threads/${side.id}`); assert.deepEqual(results.at(-1), expected);
    args = '{"extra":true}'; await send(path); assert.equal(results.length, 3);
    assert.deepEqual(results.at(-1), { error: 'Provider account listing does not accept arguments.', status: 400 });
    args = '{}';
    const channel = await request('/api/channels', { id: randomUUID(), name: 'Room', members: [agent.id], lead: agent.id, instructions: 'Help' });
    await send(`/api/channels/${channel.id}`, 'failed'); assert(!advertised); assert.equal(results.length, 3);
  } finally {
    await app?.close(); provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('private model discovery uses selected account, pages results and cancels without continuation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-model-list-'));
  const results: any[] = [], catalogCalls: string[] = [];
  let args: unknown = {}, mode = 'ok', advertised = false, completions = 0, catalogClosed = false;
  const provider = createServer(async (req, res) => {
    if (req.method === 'GET') {
      catalogCalls.push(req.url!);
      assert.equal(req.headers.authorization, req.url!.startsWith('/b/') ? 'Bearer secret-b' : 'Bearer secret-a');
      if (mode === 'hold') { res.once('close', () => { catalogClosed = true; }); return; }
      if (mode === 'error') { res.writeHead(503); res.end('private provider diagnostic'); return; }
      res.end(JSON.stringify({ data: Array.from({ length: 102 }, (_, index) => ({ id: `model-${String(index).padStart(3, '0')}` })) })); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); completions++;
    advertised = body.tools.some((tool: any) => tool.function.name === 'list_provider_models');
    const result = body.messages.findLast((row: any) => row.role === 'tool');
    if (result) results.push(JSON.parse(result.content));
    res.end(JSON.stringify({ choices: [{ finish_reason: result ? 'stop' : 'tool_calls', message: result ? { content: 'Catalog read' } : { tool_calls: [{ id: 'models', type: 'function', function: { name: 'list_provider_models', arguments: JSON.stringify(args) } }] } }] }));
  });
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address(); assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    app = await startApp({ database: join(directory, 'db.sqlite'), port: 0, accounts: ['a', 'b'].map(id => ({ id, name: id, provider: 'openai-compatible', baseURL: `${base}/${id}/v1`, apiKey: `secret-${id}` })) });
    async function request(path: string, body?: unknown) {
      const response = await fetch(app!.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app!.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
    }
    async function until(check: () => Promise<any>) {
      for (let n = 0; n < 300; n++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.fail('Model discovery timed out');
    }
    const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Catalog', model: 'fixture', instructions: 'Help', providerAccount: 'a' }), path = `/api/agents/${agent.id}`;
    async function send(location = path, status = 'done') {
      const id = randomUUID(); await request(location + '/turns', { id, text: 'Find models' });
      const row = await until(async () => (await request(location + '/turns')).find((row: any) => row.id === id && ['done', 'failed'].includes(row.status)));
      assert.equal(row.status, status, row.error); return row;
    }
    await send(); assert(advertised); assert.equal(catalogCalls.at(-1), '/a/v1/models');
    assert.deepEqual(results.at(-1), { account: 'a', models: Array.from({ length: 100 }, (_, i) => `model-${String(i).padStart(3, '0')}`), next_after: 'model-099' });
    args = { account: 'b', after: 'model-099' };
    const side = await request(path + '/threads', { id: randomUUID(), name: 'Side' });
    await send(`/api/threads/${side.id}`); assert.equal(catalogCalls.at(-1), '/b/v1/models');
    assert.deepEqual(results.at(-1), { account: 'b', models: ['model-100', 'model-101'], next_after: null });
    args = { account: '' }; await send(); assert.equal(results.at(-1).status, 503);
    args = { account: 'missing' }; await send(); assert.equal(results.at(-1).status, 503);
    args = { account: 'b', extra: true }; await send(); assert.equal(catalogCalls.length, 2);
    assert.deepEqual(results.at(-1), { error: 'Invalid model catalog parameters.', status: 400 });
    args = {}; mode = 'error'; await send(); assert.equal(results.at(-1).status, 502); assert(!JSON.stringify(results).includes('private provider diagnostic'));
    const channel = await request('/api/channels', { id: randomUUID(), name: 'Room', members: [agent.id], lead: agent.id, instructions: 'Help' });
    await send(`/api/channels/${channel.id}`, 'failed'); assert(!advertised); assert.equal(catalogCalls.length, 3);
    mode = 'hold'; const id = randomUUID(), before = completions;
    await request(path + '/turns', { id, text: 'Hold catalog' });
    await until(async () => catalogCalls.length === 4);
    await request(`${path}/turns/${id}/cancel`, { id: randomUUID() });
    await until(async () => (await request(path + '/turns')).some((row: any) => row.id === id && row.status === 'cancelled'));
    await until(async () => catalogClosed);
    assert.equal(completions, before + 1);
    mode = 'ok'; await send(); assert.equal(results.at(-1).account, 'a');
    assert.equal((await request('/api/agents')).agents.find((row: any) => row.id === agent.id).provider_account, 'a');
  } finally {
    await app?.close(); provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const source of ['openai-compatible', 'anthropic', 'gemini'] as const) for (const target of ['openai-compatible', 'anthropic', 'gemini'] as const) {
  if (source === target) continue;
  test(`confirmed account switch ${source} to ${target} retains consent across restart`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'briefsip-consent-family-'));
    const calls: { account: string; body: any }[] = [];
    let phase = 'seed';
    const provider = createServer(async (req, res) => {
      const account = req.url!.split('/')[1], family = account === 'a' ? source : target;
      assert.equal(req.headers.authorization, family === 'openai-compatible' ? `Bearer key-${account}` : undefined);
      assert.equal(req.headers['x-api-key'], family === 'anthropic' ? `key-${account}` : undefined);
      assert.equal(req.headers['x-goog-api-key'], family === 'gemini' ? `key-${account}` : undefined);
      assert(req.url!.includes(family === 'anthropic' ? '/messages' : family === 'gemini' ? ':generateContent' : '/chat/completions'));
      if (account === 'b' && family === 'gemini') assert(req.url!.includes('/target-model:generateContent'));
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); calls.push({ account, body });
      const call = account === 'a' && phase === 'switch' ? { name: 'set_provider_account', args: { revision: 1, providerAccount: 'b', model: 'target-model' } } : null;
      const text = account === 'b' ? 'Approved destination reply' : 'Seed reply';
      if (family === 'gemini') res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: call ? [{ functionCall: call, thoughtSignature: 'source-signature' }] : [{ text }] } }] }));
      else if (family === 'anthropic') res.end(JSON.stringify({ type: 'message', role: 'assistant', stop_reason: call ? 'tool_use' : 'end_turn', content: call ? [{ type: 'tool_use', id: 'switch', name: call.name, input: call.args }] : [{ type: 'text', text }] }));
      else res.end(JSON.stringify({ choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: call ? { tool_calls: [{ id: 'switch', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: text } }] }));
    });
    let app: Awaited<ReturnType<typeof startApp>> | undefined;
    try {
      await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
      const address = provider.address(); assert(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      const options = { database: join(directory, 'db.sqlite'), port: 0, accounts: [{ id: 'a', name: 'Source', provider: source, baseURL: base + '/a/v1', apiKey: 'key-a' }, { id: 'b', name: 'Destination', provider: target, baseURL: base + '/b/v1', apiKey: 'key-b' }] };
      app = await startApp(options);
      async function request(path: string, body?: unknown) {
        const response = await fetch(app!.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app!.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
      }
      async function until(path: string, id: string, paused = false) {
        for (let n = 0; n < 300; n++) {
          const row = (await request(path + '/turns')).find((item: any) => item.id === id);
          if (row && (paused ? row.paused || row.status === 'failed' : ['done', 'failed'].includes(row.status))) return row;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail('Confirmed family switch timed out');
      }
      const agent = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Stable identity', model: 'source-model', instructions: 'Help', providerAccount: 'a' });
      const direct = `/api/agents/${agent.id}`, side = await request(direct + '/threads', { id: randomUUID(), name: 'Private side' });
      const path = source === 'gemini' ? `/api/threads/${side.id}` : direct, other = source === 'gemini' ? direct : `/api/threads/${side.id}`;
      const foreign = randomUUID(), seed = randomUUID();
      await request(other + '/turns', { id: foreign, text: 'FOREIGN_HISTORY_' + foreign }); assert.equal((await until(other, foreign)).status, 'done');
      await request(path + '/turns', { id: seed, text: 'History before confirmed switch' }); assert.equal((await until(path, seed)).status, 'done');
      phase = 'switch'; const id = randomUUID(); await request(path + '/turns', { id, text: 'Switch provider account' });
      const waiting = await until(path, id, true); assert.equal(waiting.paused, 1, waiting.error);
      assert.match(waiting.questions[0].prompt, new RegExp(target)); assert(calls.every(call => call.account === 'a'));
      await app.close(); app = await startApp(options);
      assert(calls.every(call => call.account === 'a'));
      const answer = { id: randomUUID(), text: 'Approve account change', acknowledgeUncertain: true }, answerPath = `${path}/turns/${id}/questions/${waiting.questions[0].id}/answer`;
      await request(answerPath, answer); const done = await until(path, id);
      assert.equal(done.status, 'done', done.error); assert.equal(done.reply, 'Approved destination reply'); assert.equal(done.agent, agent.id);
      const destination = calls.filter(call => call.account === 'b'); assert.equal(destination.length, 1);
      const sent = JSON.stringify(destination[0].body);
      for (const marker of ['History before confirmed switch', 'Seed reply', 'Approve account change', 'set_provider_account']) assert(sent.includes(marker), marker);
      assert(!sent.includes(foreign)); assert(!sent.includes('key-a')); assert(!sent.includes('key-b'));
      if (target === 'gemini') assert(sent.includes('context_engineering_is_the_way to_go'));
      else { assert.equal(destination[0].body.model, 'target-model'); assert(!sent.includes('source-signature')); assert(!sent.includes('geminiParts')); }
      await request(answerPath, answer); assert.equal(calls.filter(call => call.account === 'b').length, 1);
      const profile = (await request('/api/agents')).agents.find((row: any) => row.id === agent.id); assert.equal(profile.provider_account, 'b'); assert.equal(profile.revision, 2);
    } finally {
      await app?.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
