import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startApp } from './server.ts';
import { codexProviderConfig, createHarnessHome, workspaceCommand } from './harness-session.ts';

test('Codex custom provider uses selected model and environment credential in disposable home', () => {
  const account = { id: 'router', name: '9Router', provider: 'openai-compatible' as const, baseURL: 'http://127.0.0.1:20128/v1', apiKey: 'synthetic-secret' };
  const home = createHarnessHome('codex', account, 'cx/gpt-6.1-sol');
  try {
    const config = readFileSync(join(home.environment.CODEX_HOME, 'config.toml'), 'utf8');
    assert.match(config, /model = "cx\/gpt-6.1-sol"/);
    assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:20128\/v1"/);
    assert.match(config, /env_key = "BRIEFSIP_PROVIDER_KEY"/);
    assert(!config.includes(account.apiKey)); assert.equal(home.environment.BRIEFSIP_PROVIDER_KEY, account.apiKey);
    assert.equal(statSync(join(home.environment.CODEX_HOME, 'config.toml')).mode & 0o777, 0o600);
    assert.equal(statSync(home.home).mode & 0o777, 0o700);
    assert.match(readFileSync(join(home.environment.CODEX_HOME, 'rules/default.rules'), 'utf8'), /pattern=\["rm"\], decision="prompt"/);
    assert.throws(() => codexProviderConfig({ ...account, baseURL: 'https://user:password@example.test/v1' }, 'x'));
    assert.throws(() => codexProviderConfig({ ...account, provider: 'anthropic' }, 'x'));
  } finally { home.close(); }
  assert(!existsSync(home.home));
});

test('workspace policy allows checks and edits, retains destructive, credentials, messages and publication approvals', () => {
  for (const command of ['node --test', 'npm test', 'npm run build', 'cat > hello.txt << EOF\nhello\nEOF', 'git diff', 'python3 clean_csv.py']) assert(workspaceCommand(command), command);
  for (const command of ['rm -rf .', 'git push', 'git reset --hard', 'npm publish', 'curl https://example.test', 'cat ~/.ssh/id_rsa', 'printenv', 'sendmail someone@example.test']) assert(!workspaceCommand(command), command);
});

test('new agents default to Codex with a managed workspace; API agents keep runtime and switch in one saved command', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-default-')), executable = join(directory, 'codex');
  writeFileSync(executable, `#!${process.execPath}\n` + readFileSync(new URL('./fixtures/fake-harness.mjs', import.meta.url), 'utf8').split('\n').slice(1).join('\n')); chmodSync(executable, 0o700);
  const options = { database: join(directory, 'state.sqlite'), harness: { executables: { codex: executable } } };
  let app = await startApp(options);
  const api = async (path: string, body?: unknown) => { const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data; };
  try {
    const profile = { name: 'New agent', model: 'cx/gpt-6.1-sol', instructions: 'Help.' };
    const created = await api('/api/agents', { id: randomUUID(), ...profile }); assert.equal(created.runtime, 'codex');
    assert(existsSync(join(directory, 'agent-workspaces', created.id)));
    const legacy = await api('/api/agents', { runtime: 'api', id: randomUUID(), ...profile }); assert.equal(legacy.runtime, 'api');
    assert.equal((await api('/api/agents', { id: legacy.id, ...profile })).runtime, 'api');
    assert((await api(`/api/agents/${legacy.id}/runtimes`)).choices.find((choice: { runtime: string }) => choice.runtime === 'codex').enabled);
    await app.close(); app = await startApp(options);
    let agents = (await api('/api/agents')).agents; assert.equal(agents.find((item: any) => item.id === legacy.id).runtime, 'api');
    assert(agents.find((item: any) => item.id === created.id).workspace_connected);
    const command = { id: randomUUID(), revision: 1, ...profile, runtime: 'codex', confirmRuntime: true };
    await api(`/api/agents/${legacy.id}/edit`, command); await api(`/api/agents/${legacy.id}/edit`, command);
    agents = (await api('/api/agents')).agents; assert.equal(agents.find((item: any) => item.id === legacy.id).runtime, 'codex'); assert.equal(agents.find((item: any) => item.id === legacy.id).revision, 2);
    assert.equal((await api('/api/runtimes')).defaultRuntime, 'codex');
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});


test('provider isolation, account home rotation and MCP shell approval boundaries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-provider-home-')), executable = join(directory, 'codex');
  writeFileSync(executable, `#!${process.execPath}\n` + readFileSync(new URL('./fixtures/fake-harness.mjs', import.meta.url), 'utf8').split('\n').slice(1).join('\n')); chmodSync(executable, 0o700);
  const accounts = ['first', 'second'].map(id => ({ id, name: id, provider: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v1', apiKey: `synthetic-${id}-credential` }));
  const app = await startApp({ database: join(directory, 'state.sqlite'), accounts, harness: { executables: { codex: executable } } });
  const api = async (path: string, body?: unknown) => { const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data; };
  let homes: string[] = [];
  try {
    const agent = await api('/api/agents', { id: randomUUID(), name: 'Coder', model: 'router/model', providerAccount: 'first', instructions: 'Help.' });
    const path = `/api/agents/${agent.id}`, workspace = join(directory, 'agent-workspaces', agent.id);
    for (const [index, account] of accounts.entries()) {
      if (index) await api(path + '/edit', { id: randomUUID(), revision: 1, name: agent.name, model: agent.model, instructions: agent.instructions, providerAccount: account.id });
      const id = randomUUID(); await api(path + '/turns', { id, text: 'FINAL_PROVIDER_SECRET' });
      let row;
      for (let n = 0; n < 300; n++) { row = (await api(path + '/turns')).find((item: { id: string }) => item.id === id); if (['done', 'failed'].includes(row.status)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.equal(row.status, 'done', row.error); assert(!JSON.stringify(row).includes(account.apiKey)); assert.match(row.reply, /REDACTED/);
      const log = readFileSync(join(workspace, 'fake-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      homes = log.filter(item => item.method === 'thread/start').map(item => item.home);
      const config = readFileSync(join(homes.at(-1)!, '.codex/config.toml'), 'utf8');
      assert.match(config, /router\/model/); assert(!config.includes(account.apiKey));
    }
    assert.equal(homes.length, 2); assert.notEqual(homes[0], homes[1]); assert(!existsSync(homes[0]));
    const turn = randomUUID(); await api(path + '/turns', { id: turn, text: 'HOLD' });
    for (let n = 0; n < 300; n++) { if ((await api(path + '/turns')).find((item: { id: string }) => item.id === turn)?.partial?.text) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    const session = app.mcpServer.mintAgentSession({ agent: agent.id, turn, ttlMs: 60000, scopes: ['orchestration'] });
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(app.origin + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) });
      return (await response.json()).result;
    };
    const shell = (command: string) => call('run_shell', { command });
    const normal = await shell('echo hello > result; cat result'); assert.equal(normal.structuredContent.exitCode, 0);
    assert.deepEqual(normal.structuredContent.verification, { recorded: true, evidenceInWorkLog: true });
    const custom = await call('run_shell', { command: 'python3 -c "assert 2 + 2 == 4"', check: true });
    assert.equal(custom.structuredContent.exitCode, 0);
    assert.deepEqual(custom.structuredContent.verification, { recorded: true, evidenceInWorkLog: true });
    assert.equal(readFileSync(join(workspace, 'result'), 'utf8'), 'hello\n');
    assert.equal((await api(path + '/turns')).find((item: { id: string }) => item.id === turn).harnessApprovals.length, 0);
    const sensitive = shell('rm result');
    let card;
    for (let n = 0; n < 300; n++) { card = (await api(path + '/turns')).find((item: { id: string }) => item.id === turn)?.harnessApprovals?.find((item: { state: string }) => item.state === 'approval'); if (card) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert(card); await api(`${path}/turns/${turn}/harness-approvals/${card.id}`, { id: randomUUID(), revision: card.revision, decision: 'deny' });
    assert((await sensitive).isError); assert(existsSync(join(workspace, 'result')));
    await call('ask_user', { question: 'Which report?', choices: ['Weekly', 'Daily'] });
    const paused = (await api(path + '/turns')).find((item: { id: string }) => item.id === turn); assert.equal(paused.paused, 1); assert.equal(paused.questions[0].prompt, 'Which report?');
    await api(`${path}/turns/${turn}/questions/${paused.questions[0].id}/answer`, { id: randomUUID(), text: 'Weekly' });
    await api(`${path}/turns/${turn}/cancel`, { id: randomUUID() });

  } finally { await app.close(); for (const home of homes) assert(!existsSync(home)); rmSync(directory, { recursive: true, force: true }); }
});

test('default harness setup saves its profile through MCP and cannot use unrelated tools', async () => {
  for (const runtime of ['codex', 'claude'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'briefsip-native-setup-')), executable = join(directory, runtime);
    writeFileSync(executable, `#!${process.execPath}\n` + readFileSync(new URL('./fixtures/fake-harness.mjs', import.meta.url), 'utf8').split('\n').slice(1).join('\n')); chmodSync(executable, 0o700);
    const app = await startApp({ database: join(directory, 'state.sqlite'), baseURL: 'http://127.0.0.1:1/v1', harness: { executables: { [runtime]: executable } } });
    const api = async (path: string, body?: unknown) => { const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data; };
    try {
      const id = randomUUID(); await api('/api/agents', { id, name: 'New agent', model: 'fixture', instructions: 'NATIVE_SETUP_FIXTURE', setup: true, ...(runtime === 'codex' ? {} : { runtime }) });
      let turn;
      for (let n = 0; n < 500; n++) { turn = (await api(`/api/agents/${id}/turns`))[0]; if (['done', 'failed'].includes(turn.status)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.equal(turn.status, 'done', turn.error + ' ' + readFileSync(join(directory, 'agent-workspaces', id, 'fake-log.jsonl'), 'utf8').split('\n').filter(line => line.includes('setupError')).join('\n'));
      const agent = (await api('/api/agents')).agents.find((agent: { id: string }) => agent.id === id);
      assert.equal(agent.name, 'Native assistant'); assert.equal(agent.instructions, 'Native setup saved.'); assert.equal(agent.revision, 2);
      assert.equal(turn.activity.tools.filter((tool: { name: string }) => tool.name === 'edit_profile').length, 1);
    } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test('new agents fall back to the API runtime when Codex is not installed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-no-codex-')), path = process.env.PATH;
  process.env.PATH = join(directory, 'empty-bin');
  const app = await startApp({ database: join(directory, 'state.sqlite') });
  const api = async (route: string, body?: unknown) => (await fetch(app.origin + route, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  try {
    assert.equal((await api('/api/runtimes')).defaultRuntime, 'api');
    const created = await api('/api/agents', { id: randomUUID(), name: 'No Codex', model: 'cx/gpt-6.1-sol', instructions: 'Help.' });
    assert.equal(created.runtime, 'api');
  } finally { process.env.PATH = path; await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
