import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createClerkClient } from '@clerk/backend';
import { initializeCanonicalSchema } from './schema.ts';
import { startCanonicalApp } from './test-bridge.ts';
import { startRustServer } from './rust-test-server.ts';

test('Rust project automation matches Node scopes, receipts, versions, calendars, schedules and webhook rotation', { skip: process.env.BRIEFSIP_TEST_SERVER !== 'rust' }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-rust-projects-'));
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwtKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const auth = { jwtKey, secretKey: 'sk_test_fixture', publishableKey: `pk_test_${Buffer.from('fixture.clerk.accounts.dev$').toString('base64')}`, issuer: 'https://fixture.clerk.accounts.dev', origin: 'https://briefsip.example', development: true };
  const account = randomUUID(), project = randomUUID(), agent = randomUUID(), device = randomUUID(), installation = randomUUID(), foreign = randomUUID();
  const now = Math.floor(Date.now() / 1000), generation = randomUUID();
  const input = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: auth.issuer, sub: 'user_fixture', sid: 'sess_fixture', azp: auth.origin, exp: now + 600, nbf: now - 1, iat: now - 1 })).toString('base64url')}`;
  const token = `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
  for (const name of ['node', 'rust']) {
    const db = new DatabaseSync(join(directory, name));
    try {
      initializeCanonicalSchema(db);
      db.prepare('UPDATE authority_state SET generation=?').run(generation);
      db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES(?,?,?,?)').run(account, auth.issuer, 'user_fixture', now * 1000);
      for (const id of [project, foreign]) {
        db.prepare('INSERT INTO projects(id,account,name,private) VALUES(?,?,?,0)').run(id, account, 'Fixture');
        db.prepare("INSERT INTO project_members VALUES(?,?,'owner',1,0)").run(id, account);
      }
      db.prepare('INSERT INTO installations VALUES(?,?,?,?,1,0,1,?)').run(installation, account, 'fixture-key', 'fixture-thumbprint', now * 1000);
      db.prepare("INSERT INTO devices VALUES(?,?,?,?,?,?,?,'{}',1,0,'offline','Asia/Jakarta',1,NULL,'[\"execution\"]',1)").run(device, installation, account, 'fixture-key', 'fixture-encryption-key', 'fixture-signing-thumbprint', 'fixture-encryption-thumbprint');
      db.prepare('INSERT INTO agents(id,name,model,instructions) VALUES(?,?,?,?)').run(agent, 'Fixture', 'fake', 'Help.');
      db.prepare('INSERT INTO agents(id,name,model,instructions) VALUES(?,?,?,?)').run(foreign, 'Foreign', 'fake', 'Help.');
      db.prepare('INSERT INTO agent_authority VALUES(?,?,?,NULL,1)').run(agent, account, device);
      db.prepare('INSERT INTO agent_projects VALUES(?,?,?,?,1,0)').run(project, agent, '', '{"v":1,"tools":[],"resources":[]}');
      db.prepare("INSERT INTO record_scopes VALUES('agents',?,?,?,'owner','agent',?)").run(JSON.stringify([agent]), account, project, agent);
    } finally { db.close(); }
  }
  const clerk = createClerkClient({ secretKey: auth.secretKey, publishableKey: auth.publishableKey, jwtKey, telemetry: { disabled: true } });
  const secrets = new Map<string, string>();
  const routineWebhookKeys = { create(routine: string, generation: number) { const secretRef = `${routine}/${generation}`, secret = randomUUID(); secrets.set(secretRef, secret); return { secretRef, secret }; }, read(secretRef?: string) { return secretRef ? secrets.get(secretRef) : undefined; } };
  const node = await startCanonicalApp({ database: join(directory, 'node'), auth, clerk, routineWebhookKeys, testKeyring: {}, fixedClock: Date.now() });
  let rust: Awaited<ReturnType<typeof startRustServer>> | undefined;
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['committedAt', 'created', 'secret'].includes(key)).map(([key, item]) => {
      if (key === 'taskId' && typeof item === 'string') { assert.match(item, /^[a-f0-9-]{36}$/); return [key, 'fixture-task']; }
      return [key, normalize(item)];
    }));
    return value;
  };
  const compare = async (path: string, body?: Record<string, unknown>, expected = 200, extra: Record<string, string> = {}) => {
    const headers = { Authorization: `Bearer ${token}`, Origin: auth.origin, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': String(body?.requestId ?? randomUUID()), ...extra };
    const rows = await Promise.all([node, rust!].map(async app => {
      const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text(), calendar = response.headers.get('content-type')?.startsWith('text/calendar');
      return { status: response.status, value: calendar ? text.replace(/DTSTAMP:[^\r]+/g, 'DTSTAMP:fixture') : JSON.parse(text), contentType: response.headers.get('content-type') };
    }));
    assert.deepEqual(normalize(rows[1]), normalize(rows[0]), path);
    assert.equal(rows[1].status, expected, path + ': ' + JSON.stringify(normalize(rows[1].value)));
    return rows.map(row => row.value);
  };
  try {
    rust = await startRustServer({ database: join(directory, 'rust'), auth: { ...auth, jwtKey }, testKeyring: {}, fixedClock: Date.now() });
    const base = `/api/projects/${project}`;
    for (const suffix of ['/routines', `/agents/${agent}/routines`, '/workflows', `/agents/${agent}/workflows`, '/workflow-notifications']) await compare(base + suffix);
    for (const suffix of ['/routines/unknown', '/routines/unknown/flow', `/agents/${agent}/routines/calendar.ics/extra`, '/workflows/unknown/edit', '/workflow-runs/unknown', '/workflow-notifications/unknown/read']) await compare(base + suffix, undefined, 404);
    await compare(base + '/routines', undefined, 404, { 'X-Briefsip-Project': project });
    const routine = randomUUID(), configuration = { requestId: routine, id: routine, revision: 0, name: 'Routine', prompt: 'Help.', nextAt: Date.now() + 86400000, intervalSeconds: 300, enabled: true };
    const routinePath = `${base}/routines/${routine}`;
    await compare(`${base}/agents/${agent}/routines`, configuration, 201);
    await compare(`${base}/agents/${agent}/routines`, configuration);
    for (const suffix of ['', '/flow', '/runs', '/webhook']) await compare(routinePath + suffix);
    await compare(`${base}/agents/${agent}/routines/calendar.ics`);
    await compare(`/api/projects/${foreign}/routines/${routine}`, undefined, 404);
    const invalidFlow = randomUUID(); await compare(routinePath + '/flow', { requestId: invalidFlow, id: invalidFlow, revision: 0, links: [{ from: agent, to: foreign }] }, 400);
    const flow = randomUUID(); await compare(routinePath + '/flow', { requestId: flow, id: flow, revision: 0, links: [] });
    const edit = randomUUID(); await compare(routinePath + '/edit', { ...configuration, requestId: edit, id: edit, revision: 1, trigger: 'webhook' });
    const hookCommand = { requestId: randomUUID(), revision: 0, rotate: true, filters: [{ pointer: '/count', equals: 4 }] };
    const hooks = await compare(routinePath + '/webhook', hookCommand, 201);
    await compare(routinePath + '/webhook', hookCommand);
    const manual = { requestId: randomUUID() };
    await compare(routinePath + '/run', manual, 202);
    await compare(routinePath + '/run', manual);
    await compare(routinePath + '/run', { requestId: randomUUID() }, 409);
    await compare(routinePath + '/runs');
    const scheduled = randomUUID(), dueAt = Date.now() - 600001;
    await compare(`${base}/agents/${agent}/routines`, { ...configuration, requestId: scheduled, id: scheduled, nextAt: dueAt }, 201);
    const scheduledPath = `${base}/routines/${scheduled}/runs`;
    for (const app of [node, rust]) {
      let count = 0;
      for (let attempt = 0; attempt < 250 && !count; attempt++) {
        const response = await fetch(app.origin + scheduledPath, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': randomUUID() } });
        count = (await response.json()).data?.items?.length ?? 0;
        if (!count) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(count, 1);
    }
    await compare(scheduledPath);
    const changed = randomUUID(); await compare(routinePath + '/edit', { ...configuration, requestId: changed, id: changed, revision: 2, trigger: 'webhook' });
    await compare(routinePath + '/runs');
    await compare(routinePath + '/webhook');
    const time = String(Math.floor(Date.now() / 1000)), eventId = 'ignored', raw = '{"event":"ready","payload":{"count":5}}';
    const events = await Promise.all([node, rust].map(async (app, index) => {
      const response = await fetch(app.origin + routinePath + '/webhook-events', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Briefsip-Time': time, 'X-Briefsip-Id': eventId, 'X-Briefsip-Signature': createHmac('sha256', hooks[index].data.secret).update(`${time}\n${eventId}\n${raw}`).digest('hex') }, body: raw });
      return { status: response.status, value: await response.json() };
    }));
    assert.deepEqual(events[1], events[0]); assert.equal(events[1].status, 202);
    await compare(routinePath + '/webhook', { requestId: randomUUID(), revision: 1, rotate: true }, 201);
    await compare(routinePath + '/webhook', hookCommand);
    const workflow = randomUUID(), createWorkflow = { requestId: workflow, id: workflow, revision: 0, name: 'Workflow', graph: { entry: 'approval', maxSteps: 2, nodes: [{ id: 'approval', kind: 'approval', prompt: 'Continue?', yes: 'out' }, { id: 'out', kind: 'output' }] } };
    const workflowPath = `${base}/workflows/${workflow}`;
    const invalidWorkflow = randomUUID(); await compare(`${base}/agents/${agent}/workflows`, { ...createWorkflow, requestId: invalidWorkflow, id: invalidWorkflow, graph: { entry: 'foreign', maxSteps: 2, nodes: [{ id: 'foreign', kind: 'agent', agent: foreign, prompt: 'Help.', next: 'out' }, { id: 'out', kind: 'output' }] } }, 400);
    await compare(`${base}/agents/${agent}/workflows`, createWorkflow, 201);
    await compare(`${base}/agents/${agent}/workflows`, createWorkflow);
    for (const suffix of ['', '/versions', '/runs', '/schedule']) await compare(workflowPath + suffix);
    const scheduleId = randomUUID();
    await compare(workflowPath + '/schedule', { requestId: scheduleId, id: scheduleId, revision: 0, spec: { kind: 'once', date: '2020-01-01', time: '09:00' }, input: 'Scheduled', enabled: true }, 201);
    for (const app of [node, rust]) {
      let count = 0;
      for (let attempt = 0; attempt < 250 && !count; attempt++) {
        const response = await fetch(app.origin + workflowPath + '/schedule', { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': randomUUID() } });
        count = (await response.json()).data?.occurrences?.length ?? 0;
        if (!count) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(count, 1);
    }
    await compare(workflowPath + '/schedule');
    await compare(`/api/projects/${foreign}/workflows/${workflow}`, undefined, 404);
    const revisionId = randomUUID(); await compare(workflowPath + '/edit', { ...createWorkflow, requestId: revisionId, id: revisionId, revision: 1, name: 'Edited' });
    const restoreId = randomUUID(); await compare(workflowPath + '/restore', { requestId: restoreId, id: restoreId, revision: 2, version: 1 });
    const runId = randomUUID(), runPath = `${base}/workflow-runs/${runId}`;
    await compare(workflowPath + '/run', { requestId: runId, id: runId, revision: 3, input: 'Fixture' }, 201);
    for (const app of [node, rust]) {
      let state = '';
      for (let attempt = 0; attempt < 250 && state !== 'approval'; attempt++) {
        const response = await fetch(app.origin + runPath, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': randomUUID() } });
        state = (await response.json()).data?.status;
        if (state !== 'approval') await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(state, 'approval');
    }
    await compare(runPath);
    const cancelId = randomUUID(); await compare(runPath + '/cancel', { requestId: cancelId, id: cancelId, revision: 2 });
    await compare(runPath); await compare(workflowPath + '/runs');
    const outputRun = randomUUID(), outputPath = `${base}/workflow-runs/${outputRun}`;
    await compare(workflowPath + '/run', { requestId: outputRun, id: outputRun, revision: 3, input: 'Fixture' }, 201);
    for (const status of ['approval', 'done']) {
      for (const app of [node, rust]) {
        let state = '';
        for (let attempt = 0; attempt < 250 && state !== status; attempt++) {
          const response = await fetch(app.origin + outputPath, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': randomUUID() } });
          state = (await response.json()).data?.status;
          if (state !== status) await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(state, status);
      }
      await compare(outputPath);
      if (status === 'approval') {
        const approveId = randomUUID(); await compare(outputPath + '/approve', { requestId: approveId, id: approveId, revision: 2, accepted: true });
      }
    }
    await compare(base + '/workflow-notifications');
    const readId = randomUUID(); await compare(`${base}/workflow-notifications/${outputRun}/read`, { requestId: readId, id: readId });
    await compare(base + '/workflow-notifications');
    const deleteId = randomUUID(); await compare(workflowPath + '/delete', { requestId: deleteId, id: deleteId, revision: 3 });
    await rust.close();
    rust = await startRustServer({ database: join(directory, 'rust'), auth: { ...auth, jwtKey }, testKeyring: {}, fixedClock: Date.now() });
    await compare(routinePath); await compare(workflowPath + '/versions');
    const db = new DatabaseSync(join(directory, 'rust'));
    try { assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); } finally { db.close(); }
  } finally { await rust?.close(); await node.close(); rmSync(directory, { recursive: true, force: true }); }
});
