import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { extractPdf, isPdf, pdfInputLimit } from './pdf-text.ts';
import { startApp } from './server.ts';

function document(text: string, pages = 1) {
  const objects: Buffer[] = [], add = (value: string | Buffer) => { objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value)); };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < pages; i++) {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10000 10000] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    const stream = deflateSync(Buffer.from(`BT /F1 12 Tf 40 9900 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`));
    add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from('\nendstream')]));
  }
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let length = chunks[0].length;
  objects.forEach((object, i) => { offsets.push(length); const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]); chunks.push(chunk); length += chunk.length; });
  chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

test('PDF sandbox extracts compressed text, refuses malformed/blank/oversize input and bounds output', async () => {
  const bytes = document('LOCAL_PDF_CONTENT'); assert(isPdf(bytes));
  assert.equal((await extractPdf(bytes)).trim(), 'LOCAL_PDF_CONTENT');
  for (const bytes of [Buffer.from('not pdf'), Buffer.from('%PDF-1.4 broken'), document(''), Buffer.concat([document('x'), Buffer.alloc(pdfInputLimit)])]) await assert.rejects(extractPdf(bytes));
  await assert.rejects(extractPdf(document('X'.repeat(500), 600)), error => (error as { status: number }).status === 413);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractPdf(document('aborted'), controller.signal), /dibatalkan/);
});

test('PDF HTTP preview and messages preserve source, scope, retry, routing, tools and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-pdf-')), payloads: any[] = [];
  let target = '', tool = false, blocked: ServerResponse | undefined;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); payloads.push(body);
    if (body.messages.at(-1).content === 'BLOCK_EDIT') { blocked = res; return; }
    let message: any = { content: 'PDF accepted' };
    if (body.messages[0].content.startsWith('Choose exactly one channel member')) message = { content: JSON.stringify({ action: 'assign', recipient: JSON.parse(body.messages.at(-1).content).members[0].id }) };
    else if (tool) { tool = false; message = { tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'read_attachment', arguments: JSON.stringify({ id: target }) } }] }; }
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
    const a = await request('/api/agents', { id: randomUUID(), name: 'PDF agent', model: 'fixture', instructions: 'Read supplied files.' }, 201);
    const b = await request('/api/agents', { id: randomUUID(), name: 'Other', model: 'fixture', instructions: 'Read supplied files.' }, 201);
    const thread = await request(`/api/agents/${a.id}/threads`, { id: randomUUID(), name: 'Side' });
    const channel = await request('/api/channels', { id: randomUUID(), name: 'PDF channel', instructions: 'Read supplied files.', members: [a.id, b.id], lead: a.id }, 201);
    const scopes = [`/api/agents/${a.id}`, `/api/threads/${thread.id}`, `/api/channels/${channel.id}`];
    const files: string[] = [];
    for (const [index, scope] of scopes.entries()) {
      const bytes = document(`PDF_SCOPE_${index}`), file = await upload(scope, bytes); files.push(file);
      const previews = await Promise.all([request(`${scope}/files/${file}?preview=text`), request(`${scope}/files/${file}?preview=text`)]);
      assert.equal(previews[0].source, 'pdf-text'); assert.equal(previews[0].text, previews[1].text); assert.match(previews[0].text, new RegExp(`PDF_SCOPE_${index}`));
      assert.deepEqual(Buffer.from(await (await fetch(`${app.origin}${scope}/files/${file}`)).arrayBuffer()), bytes);
      const id = randomUUID(), command = { id, text: 'Read PDF', files: [file], ...(index === 2 ? { automatic: true } : {}) }, before = payloads.length;
      await request(`${scope}/turns`, command); await done(scope, id);
      for (const payload of payloads.slice(before)) { assert(JSON.stringify(payload).includes(`PDF_SCOPE_${index}`)); assert(JSON.stringify(payload).includes('Extracted text only')); }
      const count = payloads.length; await request(`${scope}/turns`, command); assert.equal(payloads.length, count);
      target = file; tool = true; const read = randomUUID(); await request(`${scope}/turns`, { id: read, text: 'Reread PDF' }); await done(scope, read);
      assert(JSON.stringify(payloads.at(-1)).includes(`PDF_SCOPE_${index}`));
    }
    await request(`${scopes[0]}/files/${files[1]}?preview=text`, undefined, 404);
    await request(`${scopes[0]}/turns`, { id: randomUUID(), text: 'Foreign', files: [files[1]] }, 404);
    const noPreview = await upload(scopes[0], document('AUTO_EXTRACT'));
    const auto = randomUUID(); await request(`${scopes[0]}/turns`, { id: auto, text: 'No preview needed', files: [noPreview] }); await done(scopes[0], auto); assert(JSON.stringify(payloads.at(-1)).includes('AUTO_EXTRACT'));
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
        await spawned;
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
      await spawned; controller.abort(); await response;
      await app.close(); appClosed = true;
      assert(frozen); assert.throws(() => process.kill(frozen!.pid!, 0), 'App close must terminate its parser before returning');
    } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); frozen?.kill('SIGKILL'); }
    app = await startApp(options); appClosed = false;
  } finally { if (!appClosed) await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
