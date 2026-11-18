import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startApp } from './test-bridge.ts';
import { DatabaseSync } from 'node:sqlite';

test('local routines require project membership and a report section belonging to that project', async () => {
  const home = mkdtempSync(resolve('node_modules/.routine-project-'));
  const app = await startApp({ database: join(home, 'state.sqlite') });
  const post = async (path: string, body: unknown, status = 200) => {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
  };
  try {
    const agent = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Owner', model: 'test', instructions: 'Help.' }, 201);
    const project = await post('/api/projects', { id: randomUUID(), name: 'Work', members: [] });
    const input = { id: randomUUID(), name: 'Briefing', prompt: 'Report.', nextAt: Date.now() + 3600000, enabled: false, project: project.id, reportTo: project.channel };
    await post(`/api/agents/${agent.id}/routines`, input, 403);
    await post(`/api/projects/${project.id}/edit`, { id: randomUUID(), revision: project.revision, members: [{ agent: agent.id, write: false }] });
    const saved = await post(`/api/agents/${agent.id}/routines`, input);
    assert.equal(saved.project, project.id); assert.equal(saved.report_to, project.channel);
    const unbound = await post(`/api/agents/${agent.id}/routines`, { ...input, id: randomUUID(), project: null, reportTo: undefined });
    assert.equal(unbound.report_to, 'run');
    await post(`/api/agents/${agent.id}/routines`, { ...input, id: randomUUID(), project: null }, 400);
    await post(`/api/agents/${agent.id}/routines`, { ...input, id: randomUUID(), reportTo: randomUUID() }, 400);
  } finally { await app.close(); rmSync(home, { recursive: true, force: true }); }
});

test('Rust upgrades legacy routine timing without publishing earlier runs', async () => {
  const home = mkdtempSync(resolve('node_modules/.routine-migrate-'));
  const database = join(home, 'state.sqlite');
  let app = await startApp({ database });
  try {
    await app.close();
    const db = new DatabaseSync(database);
    try {
      db.exec(`INSERT INTO agents(id,name,model,instructions) VALUES ('legacy-agent','Legacy','fixture','Help');
        ALTER TABLE routines DROP COLUMN project;
        ALTER TABLE routines DROP COLUMN report_to;
        ALTER TABLE routines DROP COLUMN schedule_json;
        ALTER TABLE routines DROP COLUMN schedule_zone;
        DROP TABLE local_routine_reports;
        INSERT INTO routines(id,agent,name,prompt,next_at,interval_ms,enabled)
          VALUES ('legacy','legacy-agent','Legacy','Report',1794758400123,65000,0);
        INSERT INTO turns(id,agent,text,reply,status,created)
          VALUES ('old-run','legacy-agent','Report','Earlier outcome','done','2026-01-01');
        INSERT INTO routine_runs(routine,scheduled_at,turn,missed) VALUES ('legacy',1794758335123,'old-run',0);`);
    } finally { db.close(); }

    for (let restart = 0; restart < 2; restart++) {
      app = await startApp({ database });
      const migrated = new DatabaseSync(database);
      try {
        assert.deepEqual({ ...migrated.prepare('SELECT next_at,interval_ms,project,report_to,schedule_json,schedule_zone FROM routines').get() },
          { next_at: 1794758400123, interval_ms: 65000, project: null, report_to: 'run', schedule_json: null, schedule_zone: null });
        assert.equal(migrated.prepare('SELECT turn FROM routine_runs WHERE routine=?').get('legacy')?.turn, 'old-run');
        assert.equal(migrated.prepare('SELECT count(*) AS count FROM local_routine_reports').get()?.count, 0);
      } finally { migrated.close(); await app.close(); }
    }
  } finally { await app.close(); rmSync(home, { recursive: true, force: true }); }
});

test('project routine runs use project folders and post one system report per outcome across retry and restart', async () => {
  const { createServer } = await import('node:http');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const home = mkdtempSync(resolve('node_modules/.routine-scoping-'));
  const folder = join(home, 'work'), host = join(home, 'host');
  mkdirSync(folder); mkdirSync(host);
  writeFileSync(join(folder, 'scope.txt'), 'project bytes'); writeFileSync(join(host, 'scope.txt'), 'HOST MUST NOT LEAK');
  let calls = 0;
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); calls++;
    const user = data.messages.find((m: any) => m.role === 'user')?.content;
    const tool = data.messages.find((m: any) => m.role === 'tool');
    const result = user === 'READ' && !tool ? { finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_workspace_file', arguments: JSON.stringify({ path: 'scope.txt' }) } }] } }
      : ['QUIET','FAIL'].includes(user) ? { finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'outcome', type: 'function', function: { name: user === 'QUIET' ? 'no_update' : 'report_failure', arguments: JSON.stringify({ reason: user === 'QUIET' ? 'Checked; nothing changed.' : 'Missing service.' }) } }] } }
      : { finish_reason: 'stop', message: { content: tool ? tool.content : 'Final answer' } };
    res.end(JSON.stringify({ choices: [result] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const agent = randomUUID(), options = { database: join(home, 'data/state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, workspaces: [{ agent, directory: host, write: true }] };
  let app = await startApp(options);
  const request = async (path: string, body?: unknown, status = 200) => {
    const response = await fetch(app.origin + path, body === undefined ? {} : { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const wait = async (path: string, predicate: (value: any) => boolean) => {
    for (let i = 0; i < 150; i++) { const value = await request(path); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail(`Timed out: ${path}`);
  };
  try {
    await request('/api/agents', { runtime: 'api', id: agent, name: 'Owner', model: 'fixture', instructions: 'Help.' }, 201);
    const other = await request('/api/agents', { runtime: 'api', id: randomUUID(), name: 'Teammate', model: 'fixture', instructions: 'Help.' }, 201);
    let project = await request('/api/projects', { id: randomUUID(), name: 'Acme', folders: [{ mode: 'existing', path: folder }], members: [{ agent, write: false }, { agent: other.id, write: false }] });
    project = await request(`/api/projects/${project.id}/sections`, { id: randomUUID(), revision: project.revision, name: 'reports' }, 201);
    const section = project.sections.find((s: any) => s.name === 'reports').id;
    for (const [prompt, destination, expected] of [['READ',section,'done'],['QUIET',section,'no_update'],['FAIL','direct','failed'],['READ','run','done']]) {
      if (prompt === 'READ' && destination === section) {
        await app.close();
        const db = new DatabaseSync(options.database);
        db.exec("CREATE TRIGGER report_failure_fixture BEFORE UPDATE OF posted ON local_routine_reports WHEN NEW.posted=1 BEGIN SELECT RAISE(ABORT,'Synthetic delivery failure'); END"); db.close();
        app = await startApp(options);
      }
      const input = { id: randomUUID(), name: `Routine ${prompt} ${destination}`, prompt, project: project.id, reportTo: destination, trigger: 'manual', nextAt: Date.now() + 3600000, enabled: false };
      const routine = await request(`/api/agents/${agent}/routines`, input);
      const command = { id: randomUUID(), revision: routine.revision }, runPath = `/api/routines/${routine.id}/test`;
      const run = await request(runPath, command);
      assert.deepEqual(await request(runPath, command), run);
      const results = await wait(`/api/routines/${routine.id}/runs`, (rows: any[]) => ['done','failed'].includes(rows[0]?.status));
      if (prompt === 'READ') { assert.match(results[0].reply, /project bytes/); assert(!results[0].reply.includes('HOST MUST NOT LEAK')); }
      if (prompt === 'READ' && destination === section) {
        assert.equal((await request(`/api/channels/${section}/turns`)).length, 0, 'Delivery receipt failure must roll back the message too');
        const before = calls;
        await app.close();
        const db = new DatabaseSync(options.database);
        assert.equal(db.prepare('SELECT posted FROM local_routine_reports WHERE run=?').get(run.turn)?.posted, 0);
        db.exec('DROP TRIGGER report_failure_fixture'); db.close();
        app = await startApp(options);
        assert.equal(calls, before, 'Restart retries delivery without running the routine');
      }
      const fresh = await request(`/api/projects/${project.id}`);
      assert(fresh.threads.some((thread: any) => thread.id === run.thread && thread.folder === folder));
      const conversation = await request(`/api/threads/${run.thread}`);
      assert.equal(conversation.project, project.id); assert.equal(conversation.folder, folder);
      const destPath = destination === 'direct' ? `/api/agents/${agent}/turns` : `/api/channels/${section}/turns`;
      const reports = await wait(destPath, (rows: any[]) => destination === 'run' || rows.some(row => row.routineReport?.run === run.turn));
      const found = reports.filter((row: any) => row.routineReport?.run === run.turn);
      assert.equal(found.length, destination === 'run' ? 0 : 1);
      if (found.length) { assert.equal(found[0].routing, 'report'); assert.equal(found[0].status, 'done'); assert.equal(found[0].room, null); assert.equal(found[0].routineReport.status, expected); assert.equal(found[0].routineReport.thread, run.thread); assert.match(found[0].reply, new RegExp(prompt === 'FAIL' ? 'Missing service' : prompt === 'QUIET' ? 'nothing changed' : 'project bytes')); }
      const before = calls;
      await app.close(); app = await startApp(options);
      assert.deepEqual(await request(runPath, command), run);
      assert.equal((await request(destPath)).filter((row: any) => row.routineReport?.run === run.turn).length, found.length);
      await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(calls, before, 'Reports must not fan out or replay providers');
    }
    const rows = await request(`/api/routines?project=${project.id}&reportTo=${section}`); assert.equal(rows.routines.length, 2);
    assert.equal((await request('/api/routines?project=none')).routines.length, 0);
    // Revoking membership rejects new runs without falling back to the host grant.
    project = await request(`/api/projects/${project.id}`);
    await request(`/api/projects/${project.id}/edit`, { id: randomUUID(), revision: project.revision, members: [] });
    const routine = rows.routines[0];
    await request(`/api/routines/${routine.id}/test`, { id: randomUUID(), revision: routine.revision }, 403);
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
});

test('scheduled cron catches up once and unavailable project folders do not starve other routines', async () => {
  const { createServer } = await import('node:http');
  const { mkdirSync } = await import('node:fs');
  const { nextScheduleTimes } = await import('./test-support/schedule-spec.ts');
  const home = mkdtempSync(resolve('node_modules/.routine-scheduler-')), folder = join(home, 'work');
  mkdirSync(folder);
  let calls = 0;
  const provider = createServer((_req,res) => { calls++; res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Scheduled result'}}]})); });
  await new Promise<void>(resolve => provider.listen(0,'127.0.0.1',resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = {database:join(home,'data/state.sqlite'),baseURL:`http://127.0.0.1:${address.port}/v1`};
  let app = await startApp(options);
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(app.origin + path, body === undefined ? {} : {method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const result = await response.json(); assert(response.ok,JSON.stringify(result)); return result;
  };
  try {
    const agent = await request('/api/agents',{runtime:'api', id:randomUUID(),name:'Scheduler',model:'fixture',instructions:'Help.'});
    const project = await request('/api/projects',{id:randomUUID(),name:'Unavailable',folders:[{mode:'existing',path:folder}],members:[{agent:agent.id,write:false}]});
    const schedule = {kind:'cron' as const,expression:'0 9 * * *'}, zone = 'Asia/Jakarta';
    const input = {name:'Daily',prompt:'Run.',schedule,zone,enabled:true};
    for (let i=0;i<11;i++) await request(`/api/agents/${agent.id}/routines`,{...input,id:randomUUID(),project:project.id,reportTo:'run'});
    const healthy = await request(`/api/agents/${agent.id}/routines`,{...input,id:randomUUID()});
    await app.close();
    const db = new DatabaseSync(options.database), now = Date.now();
    db.prepare('UPDATE routines SET next_at=? WHERE project IS NOT NULL').run(now-3*86400000);
    db.prepare('UPDATE routines SET next_at=? WHERE id=?').run(now-2*86400000,healthy.id); db.close();
    rmSync(folder,{recursive:true});
    app = await startApp(options);
    let reports: any[] = [];
    for (let i=0;i<150;i++) { reports=await request(`/api/agents/${agent.id}/turns`); if(reports.length)break; await new Promise(resolve=>setTimeout(resolve,20)); }
    assert.equal(reports.length,1); assert.equal(reports[0].routing,'report'); assert.match(reports[0].reply,/Scheduled result/);
    const runs = await request(`/api/routines/${healthy.id}/runs`);
    assert.equal(runs.length,1); assert(runs[0].missed>=1); assert.equal(calls,1);
    const routines = await request(`/api/agents/${agent.id}/routines`), current = routines.find((row:any)=>row.id===healthy.id);
    assert.equal(current.next_at,nextScheduleTimes(schedule,zone,now,1)[0]); assert.equal(current.enabled,1);
    for(const row of routines.filter((row:any)=>row.project)) assert.equal((await request(`/api/routines/${row.id}/runs`)).length,0);
    await app.close(); app = await startApp(options);
    assert.equal((await request(`/api/agents/${agent.id}/turns`)).length,1); assert.equal(calls,1);
  } finally {await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve=>provider.close(()=>resolve())); rmSync(home,{recursive:true,force:true});}
});
