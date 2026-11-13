import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApp } from './server.ts';
import { routineCalendar } from './calendar.ts';
import { DatabaseSync } from 'node:sqlite';

test('manual routine runs keep schedule, deduplicate across restart and enforce revision and overlap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-routine-test-'));
  let calls = 0;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw); calls++;
    if (data.messages.at(-1).content === 'HOLD') return;
    if (data.messages.at(-1).content === 'QUIET') {
      assert(data.tools.some((tool: { function: { name: string } }) => tool.function.name === 'no_update'));
      return res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'manual-quiet', type: 'function', function: { name: 'no_update', arguments: JSON.stringify({ reason: 'Checks finished without updates.' }) } }] } }] }));
    }
    if (data.messages.some((message: { role: string; content: string }) => message.role === 'user' && message.content === 'TASK_FAILURE')) {
      const fileSaved = data.messages.some((message: { role: string }) => message.role === 'tool');
      return res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: fileSaved ? 'failed-outcome' : 'partial-output', type: 'function', function: fileSaved ? { name: 'report_failure', arguments: JSON.stringify({ reason: 'Required service access is missing.' }) } : { name: 'create_text_file', arguments: JSON.stringify({ name: 'partial.txt', text: 'Collected evidence before failure.' }) } }] } }] }));
    }
    if (data.messages.at(-1).content === 'DIRECT_FAILURE' || data.messages.at(-1).content === 'INVALID_FAILURE') return res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'invalid-outcome', type: 'function', function: { name: 'report_failure', arguments: JSON.stringify({ reason: '' }) } }] } }] }));
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Test complete' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, concurrency: 1 };
  let app = await startApp(options);
  async function post(path: string, body: unknown, expected = 200) {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  async function get(path: string) { return (await fetch(app.origin + path)).json(); }
  try {
    const agent = await post('/api/agents', { id: randomUUID(), name: 'Tester', model: 'fixture', instructions: 'Help.' }, 201);
    const list = `/api/agents/${agent.id}/routines`;
    const create = { id: randomUUID(), name: 'Manual', prompt: 'TEST', nextAt: Date.now() + 3600000, intervalSeconds: 60, enabled: false };
    const routine = await post(list, create);
    const path = `/api/routines/${routine.id}/test`, request = { id: randomUUID(), revision: routine.revision };
    await post(path, { ...request, revision: 0 }, 400);
    await post(path, { ...request, revision: 2 }, 409);
    const result = await post(path, request);
    assert.deepEqual(await post(path, request), result);
    await post(path, { ...request, revision: 2 }, 409);
    let rows;
    for (let n = 0; n < 100; n++) { rows = await get(`/api/routines/${routine.id}/runs`); if (rows[0]?.status === 'done') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(rows[0].status, 'done'); assert.equal(rows[0].scheduled_at, null); assert.equal(rows.length, 1);
    assert.deepEqual((await get(list))[0], routine); assert.equal(calls, 1);
    assert.equal((await get(`/api/agents/${agent.id}/turns`)).length, 0);
    await app.close(); app = await startApp(options);
    assert.deepEqual(await post(path, request), result); assert.equal(calls, 1);
    const quiet = await post(list, { ...create, id: randomUUID(), prompt: 'QUIET' });
    await post(`/api/routines/${quiet.id}/test`, { id: randomUUID(), revision: quiet.revision });
    for (let n = 0; n < 100; n++) { rows = await get(`/api/routines/${quiet.id}/runs`); if (rows[0]?.status === 'done') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(rows[0].no_update, 1); assert.equal(rows[0].error, null);
    assert.deepEqual((await get(list)).find((row: { id: string }) => row.id === quiet.id), quiet);
    const failed = await post(list, { ...create, id: randomUUID(), prompt: 'TASK_FAILURE' });
    const failedRequest = { id: randomUUID(), revision: failed.revision };
    const failedRun = await post(`/api/routines/${failed.id}/test`, failedRequest);
    for (let n = 0; n < 100; n++) { rows = await get(`/api/routines/${failed.id}/runs`); if (rows[0]?.status === 'failed') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(rows[0].status, 'failed'); assert.equal(rows[0].no_update, 0);
    assert.equal(rows[0].error, 'Required service access is missing.');
    const partial = (await get(`/api/threads/${failedRun.thread}/turns`))[0].generatedFiles;
    assert.equal(partial.length, 1);
    assert.equal(await (await fetch(`${app.origin}/api/threads/${failedRun.thread}/files/${partial[0].id}`)).text(), 'Collected evidence before failure.');
    await app.close(); app = await startApp(options);
    assert.deepEqual(await post(`/api/routines/${failed.id}/test`, failedRequest), failedRun);
    assert.equal((await get(`/api/routines/${failed.id}/runs`))[0].error, 'Required service access is missing.');
    const invalid = await post(list, { ...create, id: randomUUID(), prompt: 'INVALID_FAILURE' });
    await post(`/api/routines/${invalid.id}/test`, { id: randomUUID(), revision: invalid.revision });
    for (let n = 0; n < 100; n++) { rows = await get(`/api/routines/${invalid.id}/runs`); if (rows[0]?.status === 'failed') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(rows[0].status, 'failed'); assert.equal(rows[0].no_update, 0); assert.match(rows[0].error, /reason/);
    const direct = await post(`/api/agents/${agent.id}/turns`, { id: randomUUID(), text: 'DIRECT_FAILURE' }, 202);
    let directTurn;
    for (let n = 0; n < 100; n++) { directTurn = (await get(`/api/agents/${agent.id}/turns`)).find((turn: { id: string }) => turn.id === direct.id); if (directTurn?.status === 'failed') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(directTurn?.status, 'failed'); assert.equal(directTurn.no_update, 0); assert.match(directTurn.error, /coordination/);
    const hold = await post(list, { ...create, id: randomUUID(), prompt: 'HOLD', enabled: true });
    const holdPath = `/api/routines/${hold.id}/test`;
    const held = await post(holdPath, { id: randomUUID(), revision: hold.revision });
    await post(holdPath, { id: randomUUID(), revision: hold.revision }, 409);
    assert.deepEqual((await get(list)).find((row: { id: string }) => row.id === hold.id), hold);
    await post(`/api/threads/${held.thread}/turns/${held.turn}/pause`, { id: randomUUID(), revision: 1 });
    assert.equal((await get(`/api/routines/${hold.id}/runs`))[0].paused, 1);
    await post(holdPath, { id: randomUUID(), revision: hold.revision }, 409);
    await post(`/api/threads/${held.thread}/turns/${held.turn}/cancel`, { id: randomUUID() });
    const again = await post(holdPath, { id: randomUUID(), revision: hold.revision });
    assert.notEqual(again.turn, held.turn);
    await post(`/api/threads/${again.thread}/turns/${again.turn}/cancel`, { id: randomUUID() });
    const fullAgent = await post('/api/agents', { id: randomUUID(), name: 'Full queue', model: 'fixture', instructions: 'Help.' }, 201);
    const fullRoutine = await post(`/api/agents/${fullAgent.id}/routines`, { ...create, id: randomUUID() });
    for (let n = 0; n < 100; n++) await post(`/api/agents/${fullAgent.id}/turns`, { id: randomUUID(), text: 'HOLD' }, 202);
    await post(`/api/routines/${fullRoutine.id}/test`, { id: randomUUID(), revision: fullRoutine.revision }, 409);
    assert.equal((await get(`/api/routines/${fullRoutine.id}/runs`)).length, 0);
    await app.close(); app = await startApp({ database: options.database });
    assert.deepEqual(await post(path, request), result);
    await post(path, { id: randomUUID(), revision: routine.revision }, 503);
    // Exercise migration with an old scheduled receipt; manual rows cannot exist in that schema.
    await app.close();
    const db = new DatabaseSync(options.database);
    db.exec(`DELETE FROM routine_runs;
      DROP TABLE routine_runs;
      CREATE TABLE routine_runs(routine TEXT NOT NULL REFERENCES routines(id), scheduled_at INTEGER NOT NULL,
        turn TEXT NOT NULL UNIQUE REFERENCES turns(id), missed INTEGER NOT NULL, PRIMARY KEY(routine,scheduled_at)) STRICT;`);
    db.prepare('INSERT INTO routine_runs VALUES (?,?,?,0)').run(routine.id, create.nextAt, result.turn); db.close();
    app = await startApp(options);
    assert.equal((await get(`/api/routines/${routine.id}/runs`))[0].scheduled_at, create.nextAt);
    await post(path, { id: randomUUID(), revision: routine.revision });
    assert.equal((await get(`/api/routines/${routine.id}/runs`)).length, 2);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('routine occurrences persist once and isolate each run from main history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-routines-'));
  const calls: string[][] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw); calls.push(data.messages.map((m: { content: string }) => m.content));
    if (data.messages.at(-1).content === 'HOLD') return;
    if (['NO_UPDATE', 'BROKEN_CHECK'].includes(data.messages.at(-1).content)) {
      if (data.messages.at(-1).content === 'BROKEN_CHECK') { res.writeHead(503); return res.end(); }
      return res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'quiet-result', type: 'function', function: { name: 'no_update', arguments: JSON.stringify({ reason: 'Synthetic checks finished; nothing changed.' }) } }] } }] }));
    }

    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Routine complete' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, concurrency: 1 };
  let app = await startApp(options);
  async function post(path: string, body: unknown, expected = 200) {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  async function get(path: string) { return (await fetch(app.origin + path)).json(); }
  async function run(id: string) {
    for (let n = 0; n < 100; n++) { const rows = await get(`/api/routines/${id}/runs`); if (rows[0]?.status === 'done') return rows[0]; await new Promise(resolve => setTimeout(resolve, 30)); }
    assert.fail('Routine did not finish');
  }
  try {
    const html = await (await fetch(app.origin)).text();
    const icon = html.match(/rel="icon"[^>]*href="([^"]+)"/)?.[1]; assert(icon);
    const iconResponse = await fetch(app.origin + icon); assert.equal(iconResponse.status, 200); assert.equal(iconResponse.headers.get('content-type'), 'image/svg+xml');
    const agent = await post('/api/agents', { id: randomUUID(), name: 'Scheduler', model: 'fixture', instructions: 'Help.' }, 201);
    const list = `/api/agents/${agent.id}/routines`;
    const create = { id: randomUUID(), name: 'Daily check', prompt: 'ROUTINE_ONLY', nextAt: Date.now() - 120001, intervalSeconds: 60, enabled: true };
    await post(list, { ...create, intervalSeconds: 0 }, 400);
    const routine = await post(list, create); assert.deepEqual(await post(list, create), routine);
    await post(list, { ...create, prompt: 'different' }, 409);
    const first = await run(routine.id); assert(first.missed >= 2);
    assert.equal(calls.length, 1); assert.equal(calls[0].filter(text => text === 'ROUTINE_ONLY').length, 1);
    assert.equal((await get(`/api/agents/${agent.id}/turns`)).length, 0);
    const current = (await get(list))[0]; assert(current.next_at > Date.now()); assert.equal(current.revision, 2);
    const edit = { id: randomUUID(), name: current.name, prompt: 'SECOND_RUN', nextAt: Date.now() - 1, intervalSeconds: null, enabled: true, revision: current.revision };
    await post(`/api/routines/${routine.id}/edit`, { ...edit, revision: 1 }, 409);
    const saved = await post(`/api/routines/${routine.id}/edit`, edit); assert.deepEqual(await post(`/api/routines/${routine.id}/edit`, edit), saved);
    let second;
    for (let n = 0; n < 100; n++) { const rows = await get(`/api/routines/${routine.id}/runs`); if (rows.length === 2 && rows[0].status === 'done') { second = rows[0]; break; } await new Promise(resolve => setTimeout(resolve, 30)); }
    assert(second); assert.notEqual(second.thread, first.thread); assert(!calls[1].includes('ROUTINE_ONLY'));
    assert.equal((await get(list))[0].enabled, 0);
    await app.close(); app = await startApp(options);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(calls.length, 2); assert.equal((await get(`/api/routines/${routine.id}/runs`)).length, 2);
    const latest = (await get(list))[0];
    await post(`/api/routines/${routine.id}/edit`, { ...edit, id: randomUUID(), revision: latest.revision }, 409);
    const paused = await post(list, { ...create, id: randomUUID(), enabled: false });
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal((await get(`/api/routines/${paused.id}/runs`)).length, 0);
    const mainId = randomUUID(); await post(`/api/agents/${agent.id}/turns`, { id: mainId, text: 'HOLD' }, 202);
    const queued = await post(list, { ...create, id: randomUUID(), prompt: 'MUST_NOT_RUN', nextAt: Date.now() - 1, intervalSeconds: null });
    let queuedRun;
    for (let n = 0; n < 100; n++) { const rows = await get(`/api/routines/${queued.id}/runs`); if (rows.length) { queuedRun = rows[0]; break; } await new Promise(resolve => setTimeout(resolve, 30)); }
    assert.equal(queuedRun?.status, 'queued');
    const latestQueued = (await get(list)).find((row: { id: string }) => row.id === queued.id);
    await post(`/api/routines/${queued.id}/edit`, { id: randomUUID(), revision: latestQueued.revision, name: queued.name, prompt: queued.prompt, nextAt: Date.now() + 60000, intervalSeconds: null, enabled: false });
    assert.equal((await get(`/api/routines/${queued.id}/runs`))[0].status, 'cancelled');
    await post(`/api/agents/${agent.id}/turns/${mainId}/cancel`, { id: randomUUID() });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert(!calls.some(messages => messages.includes('MUST_NOT_RUN')));
    const quiet = await post(list, { ...create, id: randomUUID(), name: 'Quiet check', prompt: 'NO_UPDATE', nextAt: Date.now() - 1, intervalSeconds: null });
    const quietRun = await run(quiet.id); assert.equal(quietRun.no_update, 1); assert.equal(quietRun.error, null);
    assert.equal(quietRun.reply, 'Synthetic checks finished; nothing changed.');
    const broken = await post(list, { ...create, id: randomUUID(), prompt: 'BROKEN_CHECK', nextAt: Date.now() - 1, intervalSeconds: null });
    let failure;
    for (let n = 0; n < 100; n++) { const rows = await get(`/api/routines/${broken.id}/runs`); if (rows[0]?.status === 'failed') { failure = rows[0]; break; } await new Promise(resolve => setTimeout(resolve, 30)); }
    assert(failure); assert.equal(failure.no_update, 0);
    const directId = randomUUID(); await post(`/api/agents/${agent.id}/turns`, { id: directId, text: 'NO_UPDATE' }, 202);
    let direct;
    for (let n = 0; n < 100; n++) { direct = (await get(`/api/agents/${agent.id}/turns`)).find((row: { id: string }) => row.id === directId); if (direct?.status === 'failed') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(direct.status, 'failed'); assert.equal(direct.no_update, 0);
    await app.close(); app = await startApp(options);
    assert.equal((await get(`/api/routines/${quiet.id}/runs`))[0].no_update, 1);
    const future = await post(list, { ...create, id: randomUUID(), name: 'Review, reports; planning', prompt: 'PRIVATE_CALENDAR_PROMPT', nextAt: Date.UTC(2030, 0, 2, 3, 4), intervalSeconds: 3600 });
    const calendar = await fetch(`${app.origin}${list}/calendar.ics`);
    assert.equal(calendar.headers.get('content-type'), 'text/calendar; charset=utf-8');
    const calendarText = await calendar.text();
    assert(calendarText.includes(`UID:${future.id}@briefsip.local`));
    assert(calendarText.includes('DTSTART:20300102T030400Z'));
    assert(calendarText.includes('RRULE:FREQ=SECONDLY;INTERVAL=3600'));
    assert(!calendarText.includes('PRIVATE_CALENDAR_PROMPT'));
    assert(!calendarText.includes(`UID:${paused.id}@briefsip.local`));



  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('calendar escapes text and folds UTF-8 without introducing properties', () => {
  const name = '長'.repeat(60) + ',;\\\nBEGIN:VEVENT';
  const calendar = routineCalendar([{ id: 'fixture', name, next_at: Date.UTC(2030, 0, 1), interval_ms: null, revision: 1 }], new Date('2026-01-01T00:00:00Z'));
  assert(calendar.split('\r\n').every(line => Buffer.byteLength(line) <= 75));
  const unfolded = calendar.replace(/\r\n /g, '');
  assert.equal(unfolded.split('\r\nBEGIN:VEVENT').length, 2);
  assert(unfolded.includes('SUMMARY:' + '長'.repeat(60) + '\\,\\;\\\\\\nBEGIN:VEVENT'));
});
