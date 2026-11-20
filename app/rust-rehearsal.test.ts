import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp } from './test-bridge.ts';
import { randomUUID } from 'node:crypto';

const runtimes = ['codex', 'claude', 'hermes', 'antigravity', 'grok', 'pi', 'opencode', 'gemini', 'kiro'];

test('folder browser and runtime discovery retain JSON strings and advertised models', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'minarbot-rehearsal-'));
  const home = join(directory, 'home'), executable = join(directory, 'fake-harness');
  mkdirSync(join(home, 'Folder'), { recursive: true });
  writeFileSync(executable, `#!${process.execPath}
import {createInterface} from 'node:readline';
if(process.argv.includes('--version')) {process.stdout.write('fixture\\nversion\\t1\\n');process.exit();}
createInterface({input:process.stdin}).on('line',line=>{
const call=JSON.parse(line);
const result={protocolVersion:1,models:{availableModels:[{modelId:'first',name:'First'}]},configOptions:[{category:'model',options:[{value:'second',name:'Second'},{options:[{value:'first',name:'Duplicate'},{value:'third',name:'Third'}]}]}]};
console.log(JSON.stringify({jsonrpc:'2.0',id:call.id,result}));
});
`);
  chmodSync(executable, 0o700);
  const previous = process.env.HOME;
  process.env.HOME = home;
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    app = await startApp({ database: join(directory, 'data/db.sqlite'), harness: { executables: Object.fromEntries(runtimes.map(runtime => [runtime, runtime === 'grok' || runtime === 'codex' ? executable : '/missing-harness'])) } });
    const folders = await (await fetch(app.origin + '/api/project-folders', { headers: { Origin: app.origin } })).json();
    assert.deepEqual(folders, { path: home, parent: null, folders: [{ name: 'Folder', path: join(home, 'Folder') }] });
    const choices = (await (await fetch(app.origin + '/api/runtimes')).json()).choices;
    assert.equal(choices.find((row: { runtime: string }) => row.runtime === 'codex').version, 'fixture version 1');
    assert.deepEqual(choices.find((row: { runtime: string }) => row.runtime === 'grok').models, [
      { id: 'first', label: 'First' }, { id: 'second', label: 'Second' }, { id: 'third', label: 'Third' },
    ]);
    const peerTokens = await (await fetch(app.origin + '/api/mcp-server/peer-tokens', { headers: { Origin: app.origin } })).json();
    assert.equal(peerTokens.endpoint, app.origin + '/mcp');
    const post = async (path: string, body: unknown) => {
      const response = await fetch(app!.origin + path, { method: 'POST', headers: { Origin: app!.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert(response.ok); return response.json();
    };
    const agent = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Fixture', model: 'fixture', instructions: 'Help.' });
    const channel = await post('/api/channels', { id: randomUUID(), name: 'Fixture room', members: [agent.id], lead: agent.id, instructions: 'Help.' });
    assert.equal((await (await fetch(app.origin + `/api/channels/${channel.id}/panel`, { headers: { Origin: app.origin } })).json()).computer, null);
    const metrics = await (await fetch(app.origin + '/api/host-metrics', { headers: { Origin: app.origin } })).json();
    // Node reports an unlimited cgroup as UINT64_MAX; the server reports it as null.
    const limit = process.constrainedMemory();
    assert.equal(metrics.process.memoryLimit, limit > 0 && limit < 2 ** 63 ? limit : null);
    assert(metrics.process.availableMemory <= metrics.memory.available);
  } finally {
    await app?.close();
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
