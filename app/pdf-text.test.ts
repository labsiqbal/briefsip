import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfFixture as document } from './test-support/pdf-fixture.ts';
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { extractPdf, isPdf, pdfInputLimit } from './pdf-text.ts';
import { startApp } from './test-bridge.ts';

async function parserStarted(ready: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('PDF fixture parser did not start within 30s')), 30000); })]);
  } finally { clearTimeout(timer); }
}

test('PDF sandbox extracts compressed text, refuses malformed/blank/oversize input and bounds output', async () => {
  const bytes = document('LOCAL_PDF_CONTENT'); assert(isPdf(bytes));
  assert.equal((await extractPdf(bytes)).trim(), 'LOCAL_PDF_CONTENT');
  for (const bytes of [Buffer.from('not pdf'), Buffer.from('%PDF-1.4 broken'), document(''), Buffer.concat([document('x'), Buffer.alloc(pdfInputLimit)])]) await assert.rejects(extractPdf(bytes));
  await assert.rejects(extractPdf(document('X'.repeat(500), 600)), error => (error as { status: number }).status === 413);
  const controller = new AbortController(); controller.abort();
  const originalSpawn = childProcess.spawn; let spawned = false;
  childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => { spawned = true; return originalSpawn(...args); }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try { await assert.rejects(extractPdf(document('aborted'), controller.signal), /cancelled/); assert.equal(spawned, false, 'Pre-aborted reads must not spawn a parser'); }
  finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
});

test('PDF cancellation avoids pre-aborted spawns and closes pipes held by launcher descendants', async t => {
  const original = childProcess.spawn, controller = new AbortController();
  let launcher: ReturnType<typeof childProcess.spawn> | undefined;
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const mock = t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    assert.equal(args[0], '/usr/bin/bwrap');
    launcher = original(process.execPath, ['--input-type=module', '-e', `
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2, 'ipc'] });
      child.once('message', () => process.send('ready'));
      process.stdin.resume();
    `], { ...args[2], stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    launcher.once('message', started); return launcher;
  });
  syncBuiltinESMExports();
  try {
    controller.abort(); await assert.rejects(extractPdf(document('aborted'), controller.signal), /cancelled/);
    assert.equal(mock.mock.callCount(), 0, 'Pre-aborted input must not start a parser');
    const active = new AbortController(), pending = extractPdf(document('startup'), active.signal);
    // Register rejection handling before the cancellation event.
    const rejected = assert.rejects(pending, /cancelled/);
    await parserStarted(ready);
    const closed = once(launcher!, 'close', { signal: AbortSignal.timeout(30000) });
    active.abort(); await closed; await rejected;
  } finally {
    if (launcher?.pid) try { process.kill(-launcher.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    mock.mock.restore(); syncBuiltinESMExports();
  }
});

test('PDF HTTP preview and messages preserve source, scope, retry, routing, tools and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-pdf-')), payloads: any[] = [];
  let target = '', tool = false, generated = 0, blocked: ServerResponse | undefined;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); payloads.push(body);
    if (body.messages.at(-1).content === 'BLOCK_EDIT') { blocked = res; return; }
    let message: any = { content: 'PDF accepted' };
    if (body.messages[0].content.startsWith('Choose exactly one channel member')) message = { content: JSON.stringify({ action: 'assign', recipient: JSON.parse(body.messages.at(-1).content).members[0].id }) };
    else if (generated === 1) { generated = 2; message = { tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'create_text_file', arguments: JSON.stringify({ name: 'generated.pdf', text: document('GENERATED_PDF_TEXT', 1, false).toString('utf8') }) } }] }; }
    else if (generated === 2 || tool) { if (generated === 2) target = JSON.parse(body.messages.at(-1).content).id; generated = 0; tool = false; message = { tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'read_attachment', arguments: JSON.stringify({ id: target }) } }] }; }
    res.end(JSON.stringify({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address(); assert(address && typeof address !== 'string');
  const token = 'p'.repeat(64);
  const options = { database: join(directory, 'db.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, scriptToken: token };
  let app = await startApp(options), appClosed = false;
  async function request(path: string, data?: unknown, expected?: number) {
    const res = await fetch(app.origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    const value = await res.json(); if (expected !== undefined) assert.equal(res.status, expected, JSON.stringify(value)); else assert(res.ok, JSON.stringify(value)); return value;
  }
  async function upload(scope: string, bytes: Buffer) {
    const id = randomUUID(), response = await fetch(`${app.origin}${scope}/files/${id}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'renamed.bin' }, body: new Uint8Array(bytes) });
    assert.equal(response.status, 200); return id;
  }
  async function done(scope: string, id: string) {
    for (let n = 0; n < 150; n++) { const turn = (await request(scope + '/turns')).find((row: any) => row.id === id); if (turn && ['done', 'failed'].includes(turn.status)) { assert.equal(turn.status, 'done', turn.error); return; } await new Promise(resolve => setTimeout(resolve, 15)); }
    assert.fail('Turn did not settle');
  }
  try {
    const a = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'PDF agent', model: 'fixture', instructions: 'Read supplied files.' }, 201);
    const b = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Other', model: 'fixture', instructions: 'Read supplied files.' }, 201);
    const thread = await request(`/api/agents/${a.id}/threads`, { id: randomUUID(), name: 'Side' });
    const channel = await request('/api/channels', { id: randomUUID(), name: 'PDF channel', instructions: 'Read supplied files.', members: [a.id, b.id], lead: a.id }, 201);
    const scopes = [`/api/agents/${a.id}`, `/api/threads/${thread.id}`, `/api/channels/${channel.id}`];
    const files: string[] = [];
    for (const [index, scope] of scopes.entries()) {
      const bytes = document(`PDF_SCOPE_${index}`), file = await upload(scope, bytes); files.push(file);
      const previews = await Promise.all([request(`${scope}/files/${file}?preview=text`), request(`${scope}/files/${file}?preview=text`)]);
      assert.equal(previews[0].source, 'pdf-text'); assert.equal(previews[0].text, previews[1].text); assert.match(previews[0].text, new RegExp(`PDF_SCOPE_${index}`));
      assert.deepEqual(Buffer.from(await (await fetch(`${app.origin}${scope}/files/${file}`)).arrayBuffer()), bytes);
      const id = randomUUID(), command = { id, text: 'Read PDF', files: [file], ...(index === 2 ? { recipient: a.id } : {}) }, before = payloads.length;
      await request(`${scope}/turns`, command); await done(scope, id);
      for (const payload of payloads.slice(before)) { assert(JSON.stringify(payload).includes(`PDF_SCOPE_${index}`)); assert(JSON.stringify(payload).includes('Extracted text only')); }
      const count = payloads.length; await request(`${scope}/turns`, command); assert.equal(payloads.length, count);
      target = file; tool = true; const read = randomUUID(); await request(`${scope}/turns`, { id: read, text: 'Reread PDF', ...(index === 2 ? { recipient: a.id } : {}) }); await done(scope, read);
      assert(JSON.stringify(payloads.at(-1)).includes(`PDF_SCOPE_${index}`));
    }
    await request(`${scopes[0]}/files/${files[1]}?preview=text`, undefined, 404);
    await request(`${scopes[0]}/turns`, { id: randomUUID(), text: 'Foreign', files: [files[1]] }, 404);
    const noPreview = await upload(scopes[0], document('AUTO_EXTRACT'));
    const auto = randomUUID(); await request(`${scopes[0]}/turns`, { id: auto, text: 'No preview needed', files: [noPreview] }); await done(scopes[0], auto); assert(JSON.stringify(payloads.at(-1)).includes('AUTO_EXTRACT'));
    {
      const file = await upload(scopes[0], document('RETRY_SANDBOX')), command = { id: randomUUID(), text: 'Retry after sandbox repair', files: [file] };
      const originalSpawn = childProcess.spawn;
      childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => args[0] === '/usr/bin/bwrap'
        ? originalSpawn('/usr/bin/bwrap', ['--ro-bind', '/briefsip-nonexistent-fixture-path', '/missing', '/bin/true'], args[2]) : originalSpawn(...args)) as typeof childProcess.spawn;
      syncBuiltinESMExports();
      try { await request(`${scopes[0]}/turns`, command, 503); assert(!(await request(`${scopes[0]}/turns`)).some((row: any) => row.id === command.id)); }
      finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
      await request(`${scopes[0]}/turns`, command); await done(scopes[0], command.id);
      assert(JSON.stringify(payloads.at(-1)).includes('RETRY_SANDBOX'));
    }
    const block = randomUUID(); await request(`${scopes[0]}/turns`, { id: block, text: 'BLOCK_EDIT' });
    for (let n = 0; n < 100 && !blocked; n++) await new Promise(resolve => setTimeout(resolve, 10)); assert(blocked);
    const queued = await request(`${scopes[0]}/turns`, { id: randomUUID(), text: 'Original queued message' }), editor = randomUUID();
    const editPath = `${scopes[0]}/turns/${queued.id}/edit`;
    const hold = await request(editPath, { id: randomUUID(), editor, revision: queued.revision, action: 'hold' });
    const editFile = await upload(scopes[0], document('QUEUED_PDF_TEXT'));
    const save = { id: randomUUID(), editor, revision: hold.revision, action: 'save', text: 'Read queued PDF', files: [editFile] };
    await request(editPath, save); await request(editPath, save);
    blocked.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Unblocked' } }] }));
    await done(scopes[0], queued.id); assert(JSON.stringify(payloads.at(-1)).includes('QUEUED_PDF_TEXT'));
    const bad = await upload(scopes[0], Buffer.from('%PDF-malformed')); await request(`${scopes[0]}/turns`, { id: randomUUID(), text: 'Bad PDF', files: [bad] }, 415);
    for (const scope of scopes) {
      generated = 1; const id = randomUUID(); await request(`${scope}/turns`, { id, text: 'Make a PDF and read it', ...(scope === scopes[2] ? { recipient: a.id } : {}) }); await done(scope, id);
      const content = JSON.parse(payloads.at(-1).messages.at(-1).content);
      assert.equal(content.source, 'pdf-text'); assert.equal(content.text.trim(), 'GENERATED_PDF_TEXT');
    }
    {
      const originalSpawn = childProcess.spawn; let frozen: ReturnType<typeof childProcess.spawn> | undefined;
      let started!: () => void; const spawned = new Promise<void>(resolve => { started = resolve; });
      childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
        const child = originalSpawn(...args); if (args[0] === '/usr/bin/bwrap') { frozen = child; child.kill('SIGSTOP'); started(); } return child;
      }) as typeof childProcess.spawn; syncBuiltinESMExports();
      try {
        generated = 1; const id = randomUUID(); await request(`${scopes[0]}/turns`, { id, text: 'Cancel generated PDF read' }); await parserStarted(spawned);
        const closed = once(frozen!, 'close', { signal: AbortSignal.timeout(30000) });
        const count = payloads.length; await request(`${scopes[0]}/turns/${id}/cancel`, { id: randomUUID() });
        frozen!.kill('SIGCONT');
        await closed;
        const turn = (await request(`${scopes[0]}/turns`)).find((row: any) => row.id === id); assert.equal(turn.status, 'cancelled');
        // A subsequent turn must run after the cancelled reader yields, without its text continuation.
        const next = randomUUID(); await request(`${scopes[0]}/turns`, { id: next, text: 'After cancellation' }); await done(scopes[0], next);
        assert.equal(payloads.length, count + 1);
      } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); frozen?.kill('SIGKILL'); }
    }
    const large = await upload(scopes[0], document('X'.repeat(500), 70));
    await request(`${scopes[0]}/files/${large}?preview=text`);
    await request(`${scopes[0]}/turns`, { id: randomUUID(), text: 'Too much extracted text', files: [large] }, 413);
    await app.close(); app = await startApp(options);
    const preview = await request(`${scopes[0]}/files/${files[0]}?preview=text`); assert.match(preview.text, /PDF_SCOPE_0/);
    target = files[0]; tool = true; const id = randomUUID(); await request(`${scopes[0]}/turns`, { id, text: 'Read persisted PDF' }); await done(scopes[0], id); assert(JSON.stringify(payloads.at(-1)).includes('PDF_SCOPE_0'));
    for (const operation of ['send-archive', 'preview-delete', 'script-revoke']) {
      const side = await request(`/api/agents/${a.id}/threads`, { id: randomUUID(), name: operation }), scope = `/api/threads/${side.id}`;
      const file = await upload(scope, document('DO_NOT_LEAK'));
      if (operation === 'script-revoke') await request(`/api/agents/${a.id}/scripts`, { id: randomUUID(), revision: 0, enabled: true });
      const originalSpawn = childProcess.spawn; let frozen: ReturnType<typeof childProcess.spawn> | undefined;
      let started!: () => void; const spawned = new Promise<void>(resolve => { started = resolve; });
      childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
        const child = originalSpawn(...args); if (args[0] === '/usr/bin/bwrap') { frozen = child; child.kill('SIGSTOP'); started(); } return child;
      }) as typeof childProcess.spawn; syncBuiltinESMExports();
      try {
        const before = payloads.length;
        const pending = operation === 'send-archive'
          ? request(`${scope}/turns`, { id: randomUUID(), text: 'Never dispatch', files: [file] }, 409)
          : operation === 'preview-delete' ? request(`${scope}/files/${file}?preview=text`, undefined, 404)
          : fetch(`${app.origin}/api/scripts/agents/${a.id}/threads/${side.id}/files/${file}?preview=text`, { headers: { Authorization: `Bearer ${token}` } });
        await parserStarted(spawned);
        if (operation === 'script-revoke') await request(`/api/agents/${a.id}/scripts`, { id: randomUUID(), revision: 1, enabled: false });
        else {
          await request(`${scope}/edit`, { id: randomUUID(), revision: 1, name: operation, archived: true });
          if (operation === 'preview-delete') await request(`${scope}/delete`, { id: randomUUID(), revision: 2 });
        }
        frozen!.kill('SIGCONT'); const result = await pending;
        if (operation === 'script-revoke') { assert.equal(result.status, 403); assert(!JSON.stringify(await result.json()).includes('DO_NOT_LEAK')); }
        assert.equal(payloads.length, before);
      } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); frozen?.kill('SIGKILL'); }
    }
    const pendingFile = await upload(scopes[0], document('SHUTDOWN_PENDING'));
    const originalSpawn = childProcess.spawn; let frozen: ReturnType<typeof childProcess.spawn> | undefined;
    let started!: () => void; const spawned = new Promise<void>(resolve => { started = resolve; });
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
      const child = originalSpawn(...args);
      if (args[0] === '/usr/bin/bwrap') { frozen = child; child.kill('SIGSTOP'); started(); }
      return child;
    }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
    const controller = new AbortController();
    try {
      const response = fetch(`${app.origin}${scopes[0]}/files/${pendingFile}?preview=text`, { signal: controller.signal }).catch(() => null);
      await parserStarted(spawned); controller.abort(); await response;
      await app.close(); appClosed = true;
      assert(frozen); assert.throws(() => process.kill(frozen!.pid!, 0), 'App close must terminate its parser before returning');
    } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); frozen?.kill('SIGKILL'); }
    app = await startApp(options); appClosed = false;
  } finally { if (!appClosed) await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
