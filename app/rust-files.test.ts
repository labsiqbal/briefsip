import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './test-support/database.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startRustServer } from './rust-test-server.ts';
import { pdfFixture } from './test-support/pdf-fixture.ts';
import { readFileSync } from 'node:fs';
import { legacyCheckpointFixture } from './test-support/node-checkpoint-fixture.ts';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'minarbot-rust-files-')), database = join(root, 'app.sqlite'), workspace = join(root, 'workspace');
  mkdirSync(workspace);
  let app = await startRustServer({ database }); await app.close();
  const db = testDatabase(database), agent = randomUUID(), other = randomUUID(), thread = randomUUID(), channel = randomUUID();
  for (const id of [agent, other]) db.prepare("INSERT INTO agents(id,name,model,instructions) VALUES(?,?,'fixture','Help')").run(id, id);
  db.prepare("INSERT INTO threads(id,agent,name) VALUES(?,?,'Side')").run(thread, agent);
  db.prepare("INSERT INTO channels(id,name,instructions) VALUES(?,'Room','Help')").run(channel); db.close();
  const options = { database, workspaces: [{ agent, directory: workspace, write: true }] };
  app = await startRustServer(options);
  return {
    root, workspace, database, agent, other, thread, channel, get app() { return app; },
    async restart() { await app.close(); app = await startRustServer(options); },
    async close() { await app.close(); rmSync(root, { recursive: true, force: true }); },
    async request(path: string, data?: unknown, expected = 200) {
      const response = await fetch(app.origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
      const value = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`); return value;
    },
    upload(path: string, bytes: Uint8Array, name = 'report.bin') { return fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) }, body: Buffer.from(bytes) }); },
  };
}
test('Rust files preserve bytes, retry scope, deletion tombstones and archive state across restart', async () => {
  const f = await fixture();
  try {
    const scope = `/api/channels/${f.channel}/files`, id = randomUUID(), path = `${scope}/${id}`, bytes = Buffer.from([0,255,128,13,65]);
    const response = await f.upload(path, bytes, 'report é.bin'); assert.equal(response.status, 200); const receipt = await response.json();
    assert.equal(receipt.image, false); assert.equal(receipt.size, bytes.length); assert.match(receipt.created, /^\d{4}-.*Z$/);
    assert.deepEqual(await (await f.upload(path, bytes, 'report é.bin')).json(), receipt);
    assert.equal((await f.upload(`/api/agents/${f.agent}/files/${id}`, bytes, 'report é.bin')).status, 409);
    const download = await fetch(f.app.origin + path); assert.equal(download.headers.get('content-type'), 'application/octet-stream'); assert.match(download.headers.get('content-disposition')!, /%C3%A9/); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    await f.request(path + '?preview=text', undefined, 415);
    const meta = await f.request(path + '?metadata=1'); assert.equal(meta.id, id); assert.equal(meta.size, bytes.length); assert.match(meta.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual((await f.request(scope)).map((v: any) => v.id), [id]); await f.request(scope + '?before=-1', undefined, 400);
    const db = testDatabase(f.database); db.prepare('UPDATE channels SET archived=1 WHERE id=?').run(f.channel); db.close();
    assert.equal((await f.upload(`${scope}/${randomUUID()}`, bytes)).status, 409); assert.deepEqual(await (await f.upload(path, bytes, 'report é.bin')).json(), receipt);
    await f.restart(); assert.deepEqual(Buffer.from(await (await fetch(f.app.origin + path)).arrayBuffer()), bytes);
    const rejectedHeaders: Record<string, string>[] = [{}, { Origin: f.app.origin, Authorization: 'Bearer synthetic' }, { Origin: 'https://foreign.test' }];
    for (const headers of rejectedHeaders) assert.equal((await fetch(f.app.origin + path, { method: 'DELETE', headers })).status, 403);
    assert.equal((await fetch(f.app.origin + path, { method: 'DELETE', headers: { Origin: f.app.origin } })).status, 200);
    await f.request(path, undefined, 404); assert.equal((await f.upload(path, bytes, 'report é.bin')).status, 409);
    const tombstone = testDatabase(f.database); assert.deepEqual({ ...tombstone.prepare('SELECT deleted,length(bytes) AS size,digest FROM files WHERE id=?').get(id) }, { deleted: 1, size: 0, digest: '' }); tombstone.close();
    assert.equal((await f.upload(`${scope}/${randomUUID()}`, bytes, '../escape')).status, 400);
    assert.equal((await f.upload(`${scope}/${randomUUID()}`, Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);
  } finally { await f.close(); }
});
test('Rust HTML preview matches sanitizer contract and local site revisions never resurrect deleted sites', async () => {
  const f = await fixture();
  try {
    const source = '<h1 style="color:red;position:fixed;background-image:url(https://bad.test)">Title</h1><details open><summary>More</summary><p>Text &amp; more</p></details><script>fetch("/api/agents")</script><img src="https://bad.test"><iframe src="/api/agents"></iframe><svg><script>bad()</script></svg>';
    const scope = `/api/agents/${f.agent}/files`, id = randomUUID(); await f.upload(`${scope}/${id}`, Buffer.from(source), 'report.html');
    const expected = [
      "<!doctype html>",
      "<html lang=\"en\">",
      "<head>",
      "<meta charset=\"utf-8\">",
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\">",
      "<meta name=\"referrer\" content=\"no-referrer\">",
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
      "<title>HTML preview</title>",
      "<style>html{color-scheme:light}body{margin:24px;color:#20242b;background:#fff;font:16px/1.5 Georgia,serif;overflow-wrap:anywhere}*{box-sizing:border-box;max-width:100%}pre{white-space:pre-wrap}table{border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid #bbc0c8;padding:8px}summary{cursor:pointer;padding:10px;min-height:44px}summary:focus-visible{outline:2px solid #354aa5}figure{margin:0}h1,h2,h3{line-height:1.2}</style>",
      "</head>",
      "<body>",
      "<h1 style=\"color:red\">Title</h1>",
      "<details open>",
      "<summary>More</summary>",
      "<p>Text &amp; more</p>",
      "</details>",
      "</body>",
      "</html>",
    ].join('');
    const preview = await f.request(`${scope}/${id}?preview=html`); assert.equal(preview.html, expected);
    const render = await fetch(f.app.origin + `${scope}/${id}?preview=render`); assert.match(render.headers.get('content-security-policy')!, /sandbox/); assert.equal(await render.text(), preview.html);
    const path = `/api/agents/${f.agent}/sites`, command = { id: randomUUID(), name: 'Report', source };
    const first = await f.request(path, command); const edit = { id: randomUUID(), site: first.id, revision: 1, name: 'Next', source: '<p>Next</p>' };
    assert.equal((await f.request(path, edit)).revision, 2); assert.equal((await f.request(path, command)).revision, 2);
    await f.request(`/api/agents/${f.other}/sites`, command, 409); await f.request(path, { ...edit, id: randomUUID() }, 409);
    await f.restart(); const remove = { id: randomUUID(), site: first.id, revision: 2, delete: true }; assert.equal((await f.request(path, remove)).deleted, 1);
    assert.equal((await f.request(path, command)).deleted, 1); assert.equal((await fetch(f.app.origin + `/sites/${first.id}`)).status, 404);
    await f.request(path, { ...edit, id: randomUUID(), revision: 3 }, 410);
  } finally { await f.close(); }
});
test('Rust skill and pack transactions preserve pinned versions, receipts and rollback conflicts', async () => {
  const f = await fixture();
  try {
    const command = { id: randomUUID(), revision: 0, name: 'Research', description: 'Fixture', content: 'One' };
    const skill = await f.request('/api/skills', command); assert.deepEqual(await f.request('/api/skills', command), skill);
    const path = `/api/agents/${f.agent}/skills/${skill.id}`, install = { id: randomUUID(), revision: 0, version: 1, enabled: true };
    await f.request(path, install); await f.request(`/api/skills/${skill.id}`, { ...command, id: randomUUID(), revision: 1, content: 'Two' });
    assert.equal((await f.request(`/api/skills/${skill.id}?version=1`)).content, 'One'); assert.equal((await f.request(path)).version, 1);
    const pack = await f.request('/api/skill-packs', { id: randomUUID(), revision: 0, name: 'Pack', members: [{ skill: skill.id, version: 2 }] });
    const packPath = `/api/agents/${f.agent}/skill-packs/${pack.id}`; await f.request(packPath, install, 409); assert.equal(await f.request(packPath), null);
    await f.request(path, { id: randomUUID(), revision: 1, version: 1, enabled: false, remove: true }); await f.request(packPath, { ...install, id: randomUUID() });
    const installed = await f.request(path); assert.equal(installed.version, 2); assert.equal(installed.pack, pack.id);
    await f.request(path, { id: randomUUID(), revision: installed.revision, version: 2, enabled: false }, 409);
    const files = [{ path: 'SKILL.md', content: '---\nname: folder-skill\ndescription: Folder fixture\n---\nInstructions\n' }, { path: 'asset.bin', content: '/wAB', encoding: 'base64' }];
    const folder = await f.request('/api/skills', { id: randomUUID(), revision: 0, files }); assert.deepEqual((await f.request(`/api/skills/${folder.id}`)).files, files);
    await f.request('/api/skills', { id: randomUUID(), revision: 0, files: [...files, { path: '../escape', content: '' }] }, 400);
    await f.restart(); assert.equal((await f.request(path)).pack, pack.id);
    assert.deepEqual(await f.request('/api/skills', command), skill);
  } finally { await f.close(); }
});
test('Rust workspace pages and Git reads reject traversal, links, filters and inherited Git configuration', async () => {
  const f = await fixture();
  try {
    const agents = await f.request('/api/agents');
    assert.equal(agents.agents.find((agent: { id: string }) => agent.id === f.agent).workspace_connected, true);
    assert.equal(agents.agents.find((agent: { id: string }) => agent.id === f.other).workspace_connected, true);
    const panel = await f.request(`/api/agents/${f.agent}/panel`);
    assert.equal(panel.workspace.name, 'workspace');
    const path = `/api/agents/${f.agent}/workspace`; writeFileSync(join(f.workspace, 'text.txt'), 'x'.repeat(8000) + 'end');
    writeFileSync(join(f.root, 'private'), 'PRIVATE'); symlinkSync('../private', join(f.workspace, 'link')); linkSync(join(f.root, 'private'), join(f.workspace, 'hard')); symlinkSync(f.root, join(f.workspace, 'dir-link'));
    assert((await f.request(path + '/entries')).entries.some((entry: { name: string }) => entry.name === 'text.txt'));
    assert((await f.request(`/api/agents/${f.agent}/panel/workspace/entries`)).entries.some((entry: { name: string }) => entry.name === 'text.txt'));
    const first = await f.request(path + '/file?path=text.txt'); assert.equal(first.next_offset, 8000); assert.equal((await f.request(path + '/file?path=text.txt&offset=8000&digest=' + first.digest)).text, 'end');
    writeFileSync(join(f.workspace, 'text.txt'), 'changed'); await f.request(path + '/file?path=text.txt&digest=' + first.digest, undefined, 409);
    for (const name of ['../private', '/etc/passwd', 'link', 'hard', 'dir-link/private']) await f.request(path + '/file?path=' + encodeURIComponent(name), undefined, 400);
    for (const suffix of ['/file?path=text.txt&offset=1e2', '/entries?path=&path=text.txt', '/entries?extra=x']) await f.request(path + suffix, undefined, 400);
    assert.equal((await f.request(`/api/agents/${f.agent}/git`)).isRepo, false);
    execFileSync('git', ['init', '-q', '--initial-branch=main', '--template='], { cwd: f.workspace }); rmSync(join(f.workspace, 'link')); rmSync(join(f.workspace, 'hard')); rmSync(join(f.workspace, 'dir-link'));
    assert.equal((await f.request(`/api/agents/${f.agent}/git`)).isRepo, true);
    const diff = await f.request(`/api/agents/${f.agent}/git/diff?path=text.txt`); assert.match(diff.text, /changed/);
    await f.request(`/api/agents/${f.agent}/git/diff?path=../private`, undefined, 400);
    assert.deepEqual(await f.request(`/api/agents/${f.agent}/git/log`), { commits: [] });
  } finally { await f.close(); }
});

test('Rust PDF and image previews preserve bytes, cache scope, deletion and binary boundaries', async () => {
  const f = await fixture();
  try {
    const scope = `/api/agents/${f.agent}/files`, id = randomUUID(), pdf = pdfFixture('Rust PDF');
    assert.equal((await f.upload(`${scope}/${id}`, pdf, 'report.pdf')).status, 200);
    const preview = await f.request(`${scope}/${id}?preview=text`); assert.equal(preview.text.trim(), 'Rust PDF'); assert.equal(preview.source, 'pdf-text');
    assert.deepEqual(await f.request(`${scope}/${id}?preview=text`), preview);
    assert.equal((await f.request(`/api/agents/${f.agent}/panel/files/${id}?preview=text`)).text.trim(), 'Rust PDF');
    const db = testDatabase(f.database); assert.equal(db.prepare('SELECT text FROM pdf_text WHERE file=?').get(id)?.text, preview.text); db.close();
    await f.restart(); assert.deepEqual(await f.request(`${scope}/${id}?preview=text`), preview);
    assert.equal((await fetch(f.app.origin + `${scope}/${id}`, { method: 'DELETE', headers: { Origin: f.app.origin } })).status, 200);
    await f.request(`${scope}/${id}?preview=text`, undefined, 404);
    const check = testDatabase(f.database); assert.equal(check.prepare('SELECT * FROM pdf_text WHERE file=?').get(id), undefined); check.close();
    const png = Buffer.alloc(24); png.set([137,80,78,71,13,10,26,10]); png.write('IHDR', 12);
    for (const [bytes, mime] of [[png, 'image/png'], [Buffer.from([255,216,255,0]), 'image/jpeg'], [Buffer.from('RIFF0000WEBPVP8 '), 'image/webp']] as const) {
      const file = randomUUID(), response = await f.upload(`${scope}/${file}`, bytes); assert.equal((await response.json()).image, true);
      const image = await fetch(f.app.origin + `${scope}/${file}?preview=image`); assert.equal(image.headers.get('content-type'), mime); assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
      await f.request(`/api/agents/${f.other}/files/${file}?preview=image`, undefined, 404);
    }
  } finally { await f.close(); }
});

test('Rust shared data reads stay isolated and backup preserves embedded data and private file bytes', async () => {
  const f = await fixture();
  try {
    const dataPath = join(f.root, 'data.sqlite'), data = testDatabase(dataPath);
    data.exec("CREATE TABLE minarbot_owners(name TEXT PRIMARY KEY COLLATE NOCASE,owner TEXT NOT NULL); CREATE TABLE things(id INTEGER PRIMARY KEY,text TEXT); INSERT INTO things VALUES(1,'saved once');");
    data.prepare('INSERT INTO minarbot_owners VALUES(?,?)').run('things', f.agent); data.close();
    const db = testDatabase(f.database); db.prepare('UPDATE shared_data SET image=?,revision=2 WHERE id=1').run(readFileSync(dataPath)); db.close();
    const listing = await f.request('/api/data'); assert.equal(listing.tables[0].name, 'things'); assert.equal(listing.tables[0].owner, f.agent); assert.equal(listing.revision, 2);
    const command = { id: randomUUID(), revision: 2, sql: 'SELECT * FROM things' }, result = await f.request('/api/data/query', command); assert.deepEqual(result.rows, [[1, 'saved once']]); assert.deepEqual(await f.request('/api/data/query', command), result);
    for (const sql of ['DELETE FROM things', 'SELECT * FROM agents', "ATTACH '/tmp/forbidden' AS other", 'PRAGMA database_list', 'SELECT * FROM minarbot_owners']) await f.request('/api/data/query', { ...command, id: randomUUID(), sql }, 400);
    const file = randomUUID(); await f.upload(`/api/agents/${f.agent}/files/${file}`, Buffer.from('backup bytes'), 'note.txt');
    const response = await fetch(f.app.origin + '/api/backup', { method: 'POST', headers: { Origin: f.app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), confirmed: true }) });
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/vnd.sqlite3'); assert.equal(response.headers.get('content-disposition'), 'attachment; filename="minarbot-workspace.sqlite"');
    const snapshotPath = join(f.root, 'snapshot.sqlite'); writeFileSync(snapshotPath, Buffer.from(await response.arrayBuffer())); const snapshot = testDatabase(snapshotPath);
    assert.deepEqual({ ...snapshot.prepare('SELECT format,version FROM minarbot_backup').get() }, { format: 'minarbot-workspace', version: 1 });
    assert.equal(Buffer.from(snapshot.prepare('SELECT bytes FROM files WHERE id=?').get(file)!.bytes as Uint8Array).toString(), 'backup bytes'); snapshot.close();
    const drop = { id: randomUUID(), revision: 2, table: 'things' }; const deleted = await f.request('/api/data/drop', drop); assert.equal(deleted.revision, 3); assert.deepEqual(await f.request('/api/data/drop', drop), deleted);
    assert.deepEqual((await f.request('/api/data')).tables, []); await f.request('/api/data/query', { ...command, id: randomUUID() }, 409);
    await f.restart(); assert.deepEqual(await f.request('/api/data/drop', drop), deleted);
    const restored = await startRustServer({ database: snapshotPath });
    try { assert.equal((await (await fetch(restored.origin + '/api/data')).json()).tables[0].name, 'things'); assert.equal(await (await fetch(restored.origin + `/api/agents/${f.agent}/files/${file}`)).text(), 'backup bytes'); } finally { await restored.close(); }
  } finally { await f.close(); }
});

test('Rust checkpoint HTTP restores Node checkpoints, rejects stale confirmation and preserves safety recovery', async () => {
  const f = await fixture();
  try {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: f.workspace, encoding: 'utf8' }).trimEnd();
    git('init', '-q', '--template=', '--initial-branch=main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(f.workspace, 'note'), 'original'); git('add', '--', 'note'); git('commit', '-q', '-m', 'Initial');
    await f.app.close();
    const seed = testDatabase(f.database), checkpoint = randomUUID();
    try { await legacyCheckpointFixture(seed, new Map([[f.agent, { directory: f.workspace, write: true }]]), f.root).capture(f.agent, checkpoint); } finally { seed.close(); }
    await f.restart();
    writeFileSync(join(f.workspace, 'note'), 'changed'); writeFileSync(join(f.workspace, 'new'), 'keep in safety checkpoint');
    const path = `/api/agents/${f.agent}/git/checkpoints/${checkpoint}`;
    const preview = await f.request(path); assert.deepEqual(preview.files, [{ path: 'new', action: 'remove' }, { path: 'note', action: 'replace' }]);
    const restore = { id: randomUUID(), checkpointId: checkpoint, digest: preview.digest };
    const result = await f.request(path + '/restore', restore); assert.equal(result.restored, true, JSON.stringify(result));
    assert.equal(readFileSync(join(f.workspace, 'note'), 'utf8'), 'original'); assert.equal((await f.request(`/api/agents/${f.agent}/workspace/entries`)).entries.some((e: { name: string }) => e.name === 'new'), false);
    assert.deepEqual(await f.request(path + '/restore', restore), result);
    const undo = `/api/agents/${f.agent}/git/checkpoints/${restore.id}`, undoPreview = await f.request(undo);
    const undone = await f.request(undo + '/restore', { id: randomUUID(), checkpointId: restore.id, digest: undoPreview.digest }); assert.equal(undone.restored, true);
    assert.equal(readFileSync(join(f.workspace, 'note'), 'utf8'), 'changed'); assert.equal(readFileSync(join(f.workspace, 'new'), 'utf8'), 'keep in safety checkpoint');
    await f.restart(); assert.deepEqual(await f.request(path + '/restore', restore), result);
    const latest = await f.request(path); writeFileSync(join(f.workspace, 'note'), 'raced');
    const refused = await f.request(path + '/restore', { id: randomUUID(), checkpointId: checkpoint, digest: latest.digest }); assert.equal(refused.uncertain, true); assert.match(refused.error, /Workspace changed after confirmation/);
    assert.equal(readFileSync(join(f.workspace, 'note'), 'utf8'), 'raced');
    symlinkSync('/etc/passwd', join(f.workspace, 'link')); await f.request(path, undefined, 400);
  } finally { await f.close(); }
});
