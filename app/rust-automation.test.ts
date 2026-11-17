import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';

const rust = process.env.BRIEFSIP_TEST_SERVER === 'rust';

test('Rust workflow schedules retain offline work and coalesce provider-free occurrences', { skip: !rust }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-rust-schedule-'));
  const now = Date.now();
  const options = { database: join(directory, 'state.sqlite'), fixedClock: now };
  const app = await startApp(options);
  async function api(path: string, body?: unknown) {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  }
  try {
    const owner = await api('/api/agents', { id: randomUUID(), runtime: 'api', name: 'Schedule owner', model: 'fixture', instructions: 'Help.' });
    const graphs = [
      { entry: 'out', maxSteps: 2, nodes: [{ id: 'out', kind: 'output' }] },
      { entry: 'work', maxSteps: 3, nodes: [{ id: 'work', kind: 'model', model: 'fixture', prompt: 'Work', next: 'out' }, { id: 'out', kind: 'output' }] },
      { entry: 'work', maxSteps: 4, nodes: [{ id: 'work', kind: 'parallel', branches: [{ kind: 'model', model: 'fixture', prompt: 'One' }, { kind: 'model', model: 'fixture', prompt: 'Two' }], next: 'out' }, { id: 'out', kind: 'output' }] },
    ];
    const workflows = [];
    for (const [index, graph] of graphs.entries()) {
      const workflow = await api(`/api/agents/${owner.id}/workflows`, { id: randomUUID(), revision: 0, name: `Workflow ${index}`, graph });
      workflows.push(workflow);
      await api(`/api/workflows/${workflow.id}/schedule`, { id: randomUUID(), revision: 0, nextAt: now - 180000, intervalSeconds: 60, input: 'Saved input', enabled: true });
    }
    let schedule;
    for (let n = 0; n < 100; n++) {
      schedule = await api(`/api/workflows/${workflows[0].id}/schedule`);
      if (schedule.occurrences.length) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(schedule.occurrences.length, 1);
    assert.equal(schedule.occurrences[0].missed, 3);
    assert.equal(schedule.schedule.next_at, now + 60000);
    for (const workflow of workflows.slice(1)) {
      const pending = await api(`/api/workflows/${workflow.id}/schedule`);
      assert.deepEqual(pending.occurrences, []);
      assert.equal(pending.schedule.next_at, now - 180000);
      assert.deepEqual(await api(`/api/workflows/${workflow.id}/runs`), []);
    }
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Rust cron preview preserves UTC ordering through midnight folds and rejects dense schedules', { skip: !rust }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-rust-cron-'));
  const now = Date.parse('2026-11-01T00:00:00Z');
  const options = { database: join(directory, 'state.sqlite'), fixedClock: now };
  const app = await startApp(options);
  try {
    const preview = async (expression: string) => fetch(`${app.origin}/api/routine-schedule?zone=America%2FHavana&schedule=${encodeURIComponent(JSON.stringify({ kind: 'cron', expression }))}`);
    const response = await preview('0,30 0 * * *'); assert.equal(response.status, 200);
    const value = await response.json();
    assert.deepEqual(value.times, [Date.parse('2026-11-01T04:00:00Z'), Date.parse('2026-11-01T04:30:00Z'), Date.parse('2026-11-02T05:00:00Z')]);
    const dense = await preview('* * * * *'); assert.equal(dense.status, 400);
    assert.deepEqual(await dense.json(), { error: 'Cron interval must be at least five minutes.' });
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
