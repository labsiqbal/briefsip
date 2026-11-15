import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { startApp } from './server.ts';

test('conversation panel reads isolate files, previews, project folders and Git; revoked members lose access', async () => {
  const root = mkdtempSync(resolve('node_modules/.panel-test-')), home = join(homedir(), `.briefsip-panel-test-${randomUUID()}`); mkdirSync(home);
  const app = await startApp({ database: join(root,'app.sqlite'), projectRoot: join(home,'projects') });
  async function request(path: string, body?: unknown, status = 200, headers: Record<string,string> = {}): Promise<any> {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert.equal(response.status, status === 200 && body && path === '/api/agents' ? 201 : status, `${path}: ${JSON.stringify(value)}`); return value;
  }
  async function upload(scope: string, name: string, text: string) {
    const id = randomUUID(), response = await fetch(`${app.origin}${scope}/files/${id}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': name }, body: text }); assert(response.ok); return id;
  }
  try {
    const agent = randomUUID(), other = randomUUID();
    for (const id of [agent,other]) await request('/api/agents',{id,name:id,model:'fixture',instructions:'Help'});
    const firstFolder = join(home, 'first'), secondFolder = join(home, 'second'); mkdirSync(firstFolder); mkdirSync(secondFolder);
    execFileSync('git', ['init', '-q', '--initial-branch=main', '--template='], { cwd: firstFolder });
    const p = await request('/api/projects',{id:randomUUID(),name:'Panel project',folders:[{mode:'existing',path:firstFolder}],members:[{agent,write:false}]}), q = await request('/api/projects',{id:randomUUID(),name:'Other project',folders:[{mode:'existing',path:secondFolder}],members:[{agent:other,write:false}]});
    await request(`/api/projects/${p.id}/thread`,{id:randomUUID(),revision:p.revision,agent,name:'Project side'});
    const project = await request(`/api/projects/${p.id}`), thread = project.threads[0];
    const side = await request(`/api/agents/${agent}/threads`,{id:randomUUID(),name:'Unbound side'});
    const scopes = [`/api/agents/${agent}`,`/api/threads/${side.id}`,`/api/threads/${thread.id}`,`/api/channels/${p.channel}`];
    const ids = [];
    for (const scope of scopes) ids.push(await upload(scope,'artifact.html',`<h1>${scope}</h1><script>window.BAD=true</script>`));
    for (let index = 0; index < scopes.length; index++) {
      const scope = scopes[index], rows = await request(`${scope}/panel/files`); assert.deepEqual(rows.map((row: any) => row.id),[ids[index]]);
      for (let foreign = 0; foreign < scopes.length; foreign++) if (foreign !== index) await request(`${scope}/panel/files/${ids[foreign]}?preview=text`,undefined,404);
      const html = await request(`${scope}/panel/files/${ids[index]}?preview=html`); assert(!html.html.includes('<script>'));
      await request(`${scope}/panel?project=${q.id}`,undefined,400); await request(`${scope}/panel/files?before=0`,undefined,400);
    }
    const base = `${scopes[2]}/panel`;
    writeFileSync(join(p.folders[0],'notes.txt'),'PROJECT_SCOPED_DIFF\n'); writeFileSync(join(q.folders[0],'private.txt'),'OTHER_PROJECT_SECRET\n'); symlinkSync(q.folders[0],join(p.folders[0],'escape'));
    assert.equal((await request(`${base}/git`)).isRepo,true);
    const diff = await request(`${base}/git/diff?path=notes.txt`); assert.match(diff.text,/PROJECT_SCOPED_DIFF/); assert(!JSON.stringify(diff).includes('OTHER_PROJECT_SECRET'));
    assert.equal((await request(`${scopes[0]}/panel/git`)).isRepo,false); assert.equal((await request(`${scopes[1]}/panel`)).workspace,null);
    const entries = await request(`${base}/workspace/entries?path=`); assert(entries.entries.some((entry:any)=>entry.name==='notes.txt'));
    assert.equal((await request(`${base}/workspace/file?path=notes.txt&preview=text`)).text,'PROJECT_SCOPED_DIFF\n');
    await request(`${base}/workspace/file?path=../private.txt`,undefined,400); await request(`${base}/workspace/file?path=escape/private.txt`,undefined,400);
    await request(`${base}/workspace/entries?folder=${q.folders[0]}`,undefined,400); await request(`${base}/git?folder=${q.folders[0]}`,undefined,400); await request(`${base}/git/diff?path=../private.txt`,undefined,400);
    await request(`${base}/workspace/download?path=notes.txt&offset=1`,undefined,400);
    writeFileSync(join(p.folders[0],'long.txt'),'x'.repeat(8001));
    const first = await request(`${base}/workspace/file?path=long.txt&preview=text`);
    assert.equal(first.text.length,8000); assert.equal(first.next_offset,8000);
    assert.equal((await request(`${base}/workspace/file?path=long.txt&preview=text&offset=8000&digest=${first.digest}`)).text,'x');
    await request(`${base}/git`,undefined,403,{Authorization:'Bearer not-owner'}); await request(`${base}`,undefined,403,{Origin:'https://foreign.invalid'}); await request(base,{},405);
    const current = await request(`/api/projects/${p.id}`); await request(`/api/projects/${p.id}/edit`,{id:randomUUID(),revision:current.revision,members:[]});
    for (const suffix of ['', '/files','/git','/git/diff?path=notes.txt','/workspace/entries','/workspace/file?path=notes.txt']) await request(base+suffix,undefined,403);
    assert.equal((await request(`${scopes[3]}/panel`)).workspace,null);
    assert.deepEqual((await request(`${scopes[3]}/panel/files`)).map((row:any)=>row.id),[ids[3]]);
    await request(`/api/threads/${randomUUID()}/panel`,undefined,404);
  } finally { await app.close(); rmSync(root,{recursive:true,force:true}); rmSync(home,{recursive:true,force:true}); }
});
