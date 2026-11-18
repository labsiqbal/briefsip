import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp } from './test-bridge.ts';
import { findHostHarness } from './test-support/find-host-harness.ts';

const enabled = process.env.BRIEFSIP_ACP_IT === '1';
const evidence = new URL('../work/rebuild/acp-harnesses/', import.meta.url);
if (enabled) mkdirSync(evidence, { recursive: true });
for (const runtime of ['hermes', 'antigravity', 'grok', 'pi'] as const) test(`${runtime}: installed harness prompt, tool and stop`, { skip: !enabled, timeout: 240_000 }, async context => {
  const root = mkdtempSync(join(tmpdir(), `briefsip-${runtime}-it-`)), home = join(root, 'home'), workspace = join(root, 'workspace');
  mkdirSync(home); mkdirSync(workspace);
  const sourceHome = process.env.HOME!, executable = findHostHarness(runtime);
  const result = { runtime, version: null as string | null, protocol: false, prompt: false, tool: false, stop: false, resume: null as boolean | null, reason: null as string | null, approvals: 0, stage: 'availability' };
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    if (!executable) { result.reason = 'Executable missing.'; context.skip(result.reason); return; }
    const copies: Record<string, string[]> = { hermes: ['.hermes/.env', '.hermes/auth.json'], grok: ['.grok/auth.json', '.grok/models_cache.json'], pi: ['.pi/agent/auth.json', '.pi/agent/models.json', '.pi/agent/models-store.json'], antigravity: [] };
    for (const file of copies[runtime]) if (existsSync(join(sourceHome, file))) { const target = join(home, file); mkdirSync(join(target, '..'), { recursive: true }); copyFileSync(join(sourceHome, file), target); }
    if (runtime === 'hermes') {
      execFileSync('cp', ['-a', '--reflink=auto', join(sourceHome, '.hermes/installs'), join(home, '.hermes/installs')]);
      const { readdirSync } = await import('node:fs');
      for (const key of readdirSync(join(home, '.hermes/installs'))) {
        const facts = join(home, '.hermes/installs', key, 'facts.json');
        if (existsSync(facts)) writeFileSync(facts, readFileSync(facts, 'utf8').replaceAll(join(sourceHome, '.hermes/installs'), join(home, '.hermes/installs')));
      }
      const { parse, stringify } = await import('yaml');
      const host = parse(readFileSync(join(sourceHome, '.hermes/config.yaml'), 'utf8'));
      mkdirSync(join(home, '.hermes'), { recursive: true });
      writeFileSync(join(home, '.hermes/config.yaml'), stringify({ model: host.model, providers: host.providers, custom_providers: host.custom_providers, model_aliases: host.model_aliases, terminal: { backend: 'local', cwd: workspace }, agent: { max_turns: 8 }, approvals: { mode: 'manual' } }), { mode: 0o600 });
    }
    if (runtime === 'pi' && existsSync(join(sourceHome, '.pi/agent/settings.json'))) {
      const settings = JSON.parse(readFileSync(join(sourceHome, '.pi/agent/settings.json'), 'utf8'));
      writeFileSync(join(home, '.pi/agent/settings.json'), JSON.stringify({ defaultProvider: settings.defaultProvider, defaultModel: settings.defaultModel, quietStartup: true }), { mode: 0o600 });
    }
    const agent = randomUUID(), database = join(root, 'db.sqlite');
    process.env.HOME = home;
    try {
      app = await startApp({
        database, timeout: 60_000, workspaces: [{ agent, directory: workspace, write: true }],
        harness: { executables: { [runtime]: executable } },
      });
    } finally { process.env.HOME = sourceHome; }

    const origin = app.origin, agentPath = `/api/agents/${agent}`, turns = agentPath + '/turns';
    const request = async (path: string, data?: unknown) => {
      const response = await fetch(origin + path, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: context.signal,
      });
      assert(response.ok, `HTTP ${response.status} at ${path}`);
      return response.json();
    };
    const catalog = await request('/api/runtimes');
    const choice = catalog.choices.find((row: { runtime: string }) => row.runtime === runtime);
    assert(choice);
    result.version = choice.version;
    if (runtime === 'antigravity' && !choice.available) {
      result.reason = choice.reason;
      context.skip(choice.reason ?? 'ACP protocol unavailable.');
      return;
    }
    const profile = { name: 'Installed ACP fixture', model: 'fixture', instructions: 'Follow the requested harmless test exactly.' };
    result.stage = 'session';
    await request('/api/agents', { id: agent, ...profile, runtime: 'api' });
    await request(agentPath + '/edit', {
      id: randomUUID(), revision: 1, ...profile, runtime, confirmRuntime: true,
      ...(runtime === 'pi' ? { harnessModel: 'openai-codex/gpt-6.1-sol' } : {}),
    });
    const send = async (text: string) => {
      const id = randomUUID();
      await request(turns, { id, text });
      return id;
    };
    type Approval = { id: string; revision: number; state: string };
    type Turn = { id: string; status: string; reply: string | null; harnessApprovals: Approval[];
      activity: { harness: { name: string; state: string }[]; stream: { kind: string }[] } };
    const read = async (id: string) => (await request(turns) as Turn[]).find(row => row.id === id);
    const approve = async (id: string, approvals: Approval[]) => {
      for (const card of approvals.filter(card => card.state === 'approval')) {
        await request(`${turns}/${id}/harness-approvals/${card.id}`, { id: randomUUID(), revision: card.revision, decision: 'allow' });
        result.approvals++;
      }
    };
    const poll = async (id: string, accept: (row: Turn) => boolean, timeout = 65_000) => {
      const deadline = performance.now() + timeout;
      do {
        const row = await read(id);
        if (row && accept(row)) return row;
        assert(!row || !['done', 'failed', 'cancelled'].includes(row.status), `Unexpected terminal turn: ${row?.status}`);
        if (row) await approve(id, row.harnessApprovals);
        await delay(50, undefined, { signal: context.signal });
      } while (performance.now() < deadline);
      assert.fail(`Turn did not reach ${result.stage}`);
    };
    const complete = async (prompt: string, expected: string) => {
      const turn = await poll(await send(prompt), row => row.status === 'done');
      assert(turn.reply?.includes(expected));
      return turn;
    };
    const session = () => {
      const db = new DatabaseSync(database, { readOnly: true });
      try { return db.prepare('SELECT session FROM harness_sessions WHERE agent=? AND runtime=?').get(agent, runtime)?.session; }
      finally { db.close(); }
    };

    result.stage = 'prompt';
    await complete('Reply exactly BRIEFSIP_ACP_OK. Use no tools.', 'BRIEFSIP_ACP_OK');
    const sessionId = session();
    if (runtime !== 'pi') assert(sessionId);
    result.protocol = result.prompt = true;

    result.stage = 'tool';
    const tool = await complete(
      'Invoke only the Briefsip MCP create_workspace_file tool with path marker.txt and text marker. Use no shell or native file tools. Reply MARKER_WRITTEN after it succeeds.',
      'MARKER_WRITTEN',
    );
    assert(tool.activity.harness.length > 0 || tool.activity.stream.some(entry => entry.kind === 'tool'), 'Protocol tool event was not observed');
    assert.equal(readFileSync(join(workspace, 'marker.txt'), 'utf8'), 'marker');
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM flow_tool_calls WHERE turn=? AND json_extract(call,'$.function.name')='create_workspace_file'").get(tool.id)?.n, 1);
    } finally { db.close(); }
    result.tool = true;

    if (sessionId) {
      result.stage = 'resume';
      await complete('Reply exactly BRIEFSIP_RESUMED. Use no tools.', 'BRIEFSIP_RESUMED');
      assert.equal(session(), sessionId);
      result.resume = true;
    }
    result.stage = 'stop';
    const pending = await send('Use your native shell tool to run sleep 30, wait for it, then reply DONE.');
    await poll(pending, row => row.status === 'running' && row.activity.harness.some(step => ['running', 'in_progress', 'pending'].includes(step.state)));
    const started = performance.now();
    await request(`${turns}/${pending}/cancel`, { id: randomUUID() });
    await poll(pending, row => row.status === 'cancelled', 5_000);
    assert(performance.now() - started < 5_000);
    result.stop = true;
  } catch (error) {
    if (error instanceof Error) console.log(JSON.stringify({ runtime, stage: result.stage, error: error.message }));
    result.reason = error instanceof Error && error.name === 'AssertionError' ? 'Installed harness did not meet the prompt/tool/stop assertion.' : 'Installed harness could not complete with copied host login, isolated home and supervised policy.';
    throw new Error(`${runtime}: ${result.reason}`);
  } finally {
    try { await app?.close(); } finally { rmSync(root, { recursive: true, force: true }); }
    writeFileSync(new URL(`${runtime}.json`, evidence), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  }
});
