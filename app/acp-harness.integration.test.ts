import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createHarnessAdapter, findHarness, harnessAvailability, harnessProbeCommand, type HarnessEvent } from './harness.ts';

const enabled = process.env.BRIEFSIP_ACP_IT === '1';
const evidence = new URL('../work/rebuild/acp-harnesses/', import.meta.url);
if (enabled) mkdirSync(evidence, { recursive: true });
for (const runtime of ['hermes', 'antigravity', 'grok', 'pi'] as const) test(`${runtime}: installed harness prompt, tool and stop`, { skip: !enabled, timeout: 240_000 }, async context => {
  const root = mkdtempSync(join(tmpdir(), `briefsip-${runtime}-it-`)), home = join(root, 'home'), workspace = join(root, 'workspace');
  mkdirSync(home); mkdirSync(workspace);
  const sourceHome = process.env.HOME!, executable = findHarness(runtime);
  const result = { runtime, version: null as string | null, protocol: false, prompt: false, tool: false, stop: false, resume: null as boolean | null, reason: null as string | null, approvals: 0, mcpMethods: [] as string[], stage: 'availability' };
  const token = randomBytes(32).toString('base64url');
  let toolCalls = 0, mcpInitialized = false;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(req.method === 'DELETE' ? 200 : 405); res.end(); return; }
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 128_000) { res.writeHead(413); res.end(); return; } }
    const value = JSON.parse(body);
    if (typeof value.method === 'string') result.mcpMethods.push(value.method);
    if (value.method === 'notifications/initialized') mcpInitialized = true;
    if (value.method === 'tools/list' && !mcpInitialized) { res.writeHead(400); res.end(); return; }
    if (value.id === undefined) { res.writeHead(202); res.end(); return; }
    const payload = value.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'briefsip', version: '1' } }
      : value.method === 'tools/list' ? { tools: [{ name: 'fixture_marker', description: 'Write harmless acceptance marker in the temporary workspace.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
      : value.method === 'tools/call' && value.params?.name === 'fixture_marker' ? (toolCalls++, writeFileSync(join(workspace, 'marker.txt'), 'marker'), { content: [{ type: 'text', text: 'MARKER_WRITTEN' }] }) : {};
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: value.id, result: payload }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const controller = new AbortController();
  let adapter: ReturnType<typeof createHarnessAdapter> | undefined;
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    if (!executable) { result.reason = 'Executable missing.'; context.skip(result.reason); return; }
    const available = runtime === 'antigravity' ? await harnessAvailability(runtime, executable) : { available: true, version: (await harnessProbeCommand(executable, ['--version']))?.trim() ?? null, reason: null }; result.version = available.version;
    if (!available.available) { result.reason = available.reason; context.skip(result.reason ?? 'Protocol unavailable.'); return; }
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
    const environment = { HOME: home, ...(runtime === 'hermes' ? { HERMES_HOME: join(home, '.hermes'), HERMES_RUNTIME_DIR: join(sourceHome, '.hermes/tools') } : {}), ...(runtime === 'pi' ? { PI_CODING_AGENT_DIR: join(home, '.pi/agent') } : {}) };
    result.stage = 'session';
    const input = { workspace, write: true, executable, ...(runtime === 'pi' ? { model: 'openai-codex/gpt-6.1-sol' } : {}), signal: controller.signal, timeoutMs: 60_000, environment, mcpURL: `http://127.0.0.1:${address.port}/mcp`, token, approve: async () => { result.approvals++; return true; } };
    adapter = createHarnessAdapter(runtime, input);
    const sessionId = await adapter.startSession(); result.protocol = true;
    const collect = async (prompt: string) => { const events: HarnessEvent[] = []; for await (const event of adapter!.sendTurn(prompt)) events.push(event); return events; };
    result.stage = 'prompt';
    const simple = await collect('Reply exactly BRIEFSIP_ACP_OK. Use no tools.');
    assert(simple.some(event => event.type === 'done')); assert(simple.some(event => event.type === 'text' && event.text.includes('BRIEFSIP_ACP_OK')) || simple.filter(event => event.type === 'text').map(event => event.text).join('').includes('BRIEFSIP_ACP_OK'));
    result.prompt = true;
    result.stage = 'tool';
    const tools = await collect('Invoke mcp__briefsip__fixture_marker from the attached briefsip MCP server exactly once. This harmless tool writes marker.txt in this disposable workspace. Use no shell or file tools. Only after the tool succeeds, reply MARKER_WRITTEN.');
    assert(toolCalls > 0, 'MCP tools/call was not observed'); assert(tools.some(event => event.type === 'tool'), 'Protocol tool event was not observed'); assert.equal(readFileSync(join(workspace, 'marker.txt'), 'utf8'), 'marker'); result.tool = true;
    if (sessionId) {
      result.stage = 'resume'; await adapter.close();
      adapter = createHarnessAdapter(runtime, { ...input, sessionId });
      assert.equal(await adapter.startSession(), sessionId);
      const resumed = await collect('Reply exactly BRIEFSIP_RESUMED. Use no tools.');
      assert(resumed.filter(event => event.type === 'text').map(event => event.text).join('').includes('BRIEFSIP_RESUMED'));
      result.resume = true;
    }
    result.stage = 'stop';
    const iteration = adapter.sendTurn('Use the shell tool to run sleep 30, wait for it, then reply DONE.')[Symbol.asyncIterator]();
    for (let i = 0; i < 100; i++) { const event = await iteration.next(); if (event.done) break; if (event.value.type === 'tool') { const started = Date.now(); const pending = Promise.allSettled([iteration.next()]); controller.abort(); await adapter.close(); const [next] = await pending; if (next.status === 'fulfilled') await assert.rejects(iteration.next()); assert(Date.now() - started < 5000); result.stop = true; break; } }
    assert(result.stop, 'Harness did not enter a stoppable tool call.');
  } catch (error) {
    if (error instanceof Error && ['HarnessError', 'AssertionError'].includes(error.name)) console.log(JSON.stringify({ runtime, stage: result.stage, error: error.message }));
    result.reason = error instanceof Error && error.name === 'AssertionError' ? 'Installed harness did not meet the prompt/tool/stop assertion.' : 'Installed harness could not complete with copied host login, isolated home and supervised policy.';
    throw new Error(`${runtime}: ${result.reason}`);
  } finally {
    clearTimeout(timer); await adapter?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    writeFileSync(new URL(`${runtime}.json`, evidence), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result)); rmSync(root, { recursive: true, force: true });
  }
});
