import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillFiles } from './skill-files.ts';
import { restoreSkillCommand } from './skill-command.ts';
import { startApp } from './server.ts';

const files = [
  { path: 'SKILL.md', content: '\uFEFF---\r\nname: example-skill\r\ndescription: >-\r\n  Use for\r\n  examples.\r\nlicense: Apache-2.0\r\nmetadata:\r\n  version: "1.2.3"\r\n---\r\nRead references/detail.md before answering.\r\n' },
  { path: 'references/detail.md', content: 'Original details.\n' + 'x'.repeat(9000) },
  { path: 'scripts/check.py', content: 'raise SystemExit("never execute")\n' },
];
test('skill folders preserve exact files and reject invalid or unsupported inputs as a whole', () => {
  const parsed = parseSkillFiles(files); assert.equal(parsed.description, 'Use for examples.'); assert.deepEqual(parsed.files, files);
  assert.deepEqual(parseSkillFiles(JSON.parse(JSON.stringify({ format: 'briefsip-skill-folder', version: 1, files })).files).files, files);
  const command = { path: '/api/skills', body: { id: randomUUID(), revision: 0, files } };
  assert.deepEqual(restoreSkillCommand(JSON.stringify(command)), command);
  for (const path of ['/etc/passwd', '../secret', 'a/../b', 'a\\b', 'a//b', 'a:', '', 'SKILL.md', 'skill.md']) assert.throws(() => parseSkillFiles([...files, { path, content: 'secret' }]));
  for (const content of ['bad', '---\nname: x\nname: y\ndescription: hi\n---\nbody', '---\nname: &a x\ndescription: *a\n---\nbody', '---\nname: x\ndescription: hi\nallowed-tools: Bash\n---\nbody', '---\nname: x\ndescription: hi\ndisable-model-invocation: true\n---\nbody', '---\nname: Invalid name\ndescription: hi\n---\nbody']) assert.throws(() => parseSkillFiles([{ path: 'SKILL.md', content }]));
  for (const content of ['\x00binary', '\ud800', 'x'.repeat(48000)]) assert.throws(() => parseSkillFiles([...files, { path: 'bad', content }]));
  for (const metadata of ['license: [MIT]', 'compatibility: {os: linux}', 'metadata: [one, two]', 'metadata: {version: 123}', 'compatibility: ""', `compatibility: ${'x'.repeat(501)}`]) assert.throws(() => parseSkillFiles([{ path: 'SKILL.md', content: `---\nname: test\ndescription: Test\n${metadata}\n---\nBody` }]));
  assert.throws(() => parseSkillFiles(Array.from({ length: 33 }, (_, i) => ({ path: `f${i}`, content: '' }))));
  assert.throws(() => restoreSkillCommand(JSON.stringify({ ...command, body: { ...command.body, name: 'override' } })));
});

test('folder revisions, receipts and pinned file tools survive reload without foreign or revoked access', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-skill-files-'));
  let target = '', offset = 0, filePath = 'references/detail.md', mode = 'file', results: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw), reads = data.messages.filter((message: any) => message.role === 'tool');
    const offered = data.tools?.some((tool: any) => tool.function.name === 'read_skill_file');
    assert.equal(offered, mode !== 'channel');
    if (reads.length) results.push(JSON.parse(reads.at(-1).content));
    const call = !reads.length;
    res.end(JSON.stringify({ choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: call ? { tool_calls: [{ id: randomUUID(), type: 'function', function: { name: mode === 'manifest' ? 'read_skill' : 'read_skill_file', arguments: JSON.stringify(mode === 'manifest' ? { id: target } : { id: target, path: filePath, offset }) } }] } : { content: 'Done' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1` };
  let app = await startApp(options);
  async function request(path: string, body?: unknown, expected = 200): Promise<any> {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  async function run(path: string, status = 'done') {
    results = []; const id = randomUUID(); await request(path, { id, text: 'Read skill files' }, 202);
    for (let n = 0; n < 150; n++) {
      const turn = (await request(path)).find((row: any) => row.id === id);
      if (['done', 'failed'].includes(turn.status)) { assert.equal(turn.status, status, turn.error); return; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Task did not settle');
  }
  try {
    const a = await request('/api/agents', { id: randomUUID(), name: 'A', model: 'fixture', instructions: 'Help' }, 201);
    const b = await request('/api/agents', { id: randomUUID(), name: 'B', model: 'fixture', instructions: 'Help' }, 201);
    const command = { id: randomUUID(), revision: 0, files };
    await request('/api/skills', { ...command, files: [{ path: 'SKILL.md', content: '---\nname: test\ndescription: Test\nmetadata: {version: 123}\n---\nBody' }] }, 400);
    assert.equal((await request('/api/skills')).skills.length, 0);
    const skill = await request('/api/skills', command); target = skill.id;
    assert.deepEqual(await request('/api/skills', command), skill);
    await request('/api/skills', { ...command, files: files.slice(0, 1) }, 409);
    assert.deepEqual((await request(`/api/skills/${target}`)).files, files);
    const binding = `/api/agents/${a.id}/skills/${target}`, turnPath = `/api/agents/${a.id}/turns`;
    await request(binding, { id: randomUUID(), revision: 0, version: 1, enabled: true });
    const changed = files.map(file => file.path === 'references/detail.md' ? { ...file, content: 'New details' } : file);
    const edit = { id: randomUUID(), revision: 1, files: changed };
    await request(`/api/skills/${target}`, edit);
    await request(`/api/skills/${target}`, { ...edit, id: randomUUID() }, 409);
    await request(`/api/skills/${target}`, { id: randomUUID(), revision: 2, name: 'Lossy', description: 'Would drop files', content: 'Body' }, 409);
    await run(turnPath); assert.equal(results[0].content, files[1].content.slice(0, 8000)); assert.equal(results[0].version, 1); assert.equal(results[0].next_offset, 8000);
    offset = 8000; await run(turnPath); assert.equal(results[0].content, files[1].content.slice(8000)); assert.equal(results[0].next_offset, null); offset = 0;
    mode = 'manifest'; await run(turnPath); assert.deepEqual(results[0].files.map((file: any) => file.path), files.map(file => file.path)); mode = 'file';
    for (filePath of ['../secret', '/etc/passwd', 'absent.txt']) { await run(turnPath); assert.match(results[0].error, /not found/); } filePath = 'references/detail.md';
    await run(`/api/agents/${b.id}/turns`); assert.match(results[0].error, /not found/);
    await app.close(); app = await startApp(options);
    assert.deepEqual(await request(`/api/skills/${target}`, edit), { ...skill, revision: 2 });
    assert.deepEqual((await request(`/api/skills/${target}?version=1`)).files, files);
    assert.deepEqual((await request(`/api/skills/${target}?version=2`)).files, changed);
    await run(turnPath); assert.equal(results[0].content, files[1].content.slice(0, 8000));
    await request(binding, { id: randomUUID(), revision: 1, version: 2, enabled: true }); await run(turnPath); assert.equal(results[0].content, 'New details');
    await request(binding, { id: randomUUID(), revision: 2, version: 2, enabled: false }); await run(turnPath); assert.match(results[0].error, /not found/);
    const channel = await request('/api/channels', { id: randomUUID(), name: 'Room', instructions: 'Help', lead: a.id, members: [a.id] }, 201);
    mode = 'channel'; await run(`/api/channels/${channel.id}/turns`, 'failed'); assert.equal(results.length, 0);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
