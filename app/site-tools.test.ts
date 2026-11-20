import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';

test('site tools bind sent files and owner, journal results and never replay old mutation on restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'minarbot-site-tools-'));
  let args: unknown = {}, tool = 'publish_site', result: any, hold = false, observed = false, advertised = false;
  let generate = false;
  let before: (() => Promise<unknown>) | undefined;
  const provider = createServer(async (req,res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw), last = data.messages.findLast((row: any) => row.role === 'tool');
    advertised = data.tools.some((entry: any) => entry.function.name === tool);
    if (generate && (!last || last.tool_call_id === 'artifact')) {
      const generated = last ? JSON.parse(last.content) : null;
      res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: generated ? 'site-call' : 'artifact', type: 'function', function: { name: generated ? 'publish_site' : 'create_text_file', arguments: JSON.stringify(generated ? { file: generated.id, name: 'Generated site' } : { name: 'generated.html', text: '<h1>Generated page</h1>' }) } }] } }] })); return;
    }
    if (last) { result = JSON.parse(last.content); observed = true; if (hold) return; }
    else if (before) { const action = before; before = undefined; await action(); }
    res.end(JSON.stringify({ choices: [{ finish_reason: last ? 'stop' : 'tool_calls', message: last ? { content: result.path ? `[Open site](${result.path})` : 'Result checked.' } : { tool_calls: [{ id:'site-call', type:'function', function:{ name:tool, arguments:JSON.stringify(args) } }] } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0,'127.0.0.1',resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database:join(directory,'test.sqlite'), baseURL:`http://127.0.0.1:${address.port}/v1`, port:0 };
  let app = await startApp(options, { directory, servers: [provider] });
  async function request(path:string,body?:unknown) {
    const response = await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    const data = await response.json(); assert(response.ok,JSON.stringify(data)); return data;
  }
  async function waitFor(check:()=>Promise<any>) { for(let n=0;n<300;n++){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out'); }
  const until = (path:string,id:string,status='done') => waitFor(async()=>(await request(path+'/turns')).find((row:any)=>row.id===id&&row.status===status));
  async function run(path:string,files:string[]=[],status='done') { const id=randomUUID(), command={id,text:'Manage local site',files}; await request(path+'/turns',command); await until(path,id,status); await request(path+'/turns',command); return id; }
  async function upload(path:string,source:string|Uint8Array,name='page.html') { const id=randomUUID(); const response=await fetch(app.origin+path+'/files/'+id,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(name)},body:typeof source === 'string' ? source : Buffer.from(source)}); assert(response.ok); return id; }
  try {
    const a=await request('/api/agents',{runtime:'api', id:randomUUID(),name:'Publisher',model:'fixture',instructions:'Help'});
    const b=await request('/api/agents',{runtime:'api', id:randomUUID(),name:'Other',model:'fixture',instructions:'Help'});
    const path=`/api/agents/${a.id}`, other=`/api/agents/${b.id}`;
    const side=await request(path+'/threads',{id:randomUUID(),name:'Side'}), sidePath=`/api/threads/${side.id}`;
    const room=await request('/api/channels',{id:randomUUID(),name:'Room',members:[a.id],lead:a.id,instructions:'Help'});
    const file=await upload(path,'<h1>Published</h1><script>bad()</script>');
    args={file,name:'Report'};await run(path);assert.equal(result.status,404); // Unsent upload is not model authority.
    await run(path,[file]);assert(advertised);const site=result;assert.equal(site.revision,1);assert.equal((await request(path+'/sites')).sites.length,1);
    assert.match(await(await fetch(app.origin+site.path)).text(),/<h1>Published<\/h1>/);
    args={file,name:'Side cannot use main file'};await run(sidePath);assert.equal(result.status,404);
    const otherFile=await upload(other,'<p>Foreign</p>');args={file:otherFile,name:'Foreign'};await run(path);assert.equal(result.status,404);
    for (const [bytes,name,status,message] of [
      [Buffer.from([255]),'invalid.html',415,'Message attachment must be UTF-8 text.'],
      ['x'.repeat(262145),'large.html',413,'Total text attachment limit is 32 KiB per message.'],
    ] as const) {
      const invalid = await upload(path, bytes, name);
      const response = await fetch(app.origin+path+'/turns', {
        method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},
        body:JSON.stringify({id:randomUUID(),text:'Manage local site',files:[invalid]}),
      });
      assert.equal(response.status,status,name);
      assert.equal((await response.json()).error,message);
    }
    const invalidType = await upload(path,'plain','not-html.txt');
    args={file:invalidType,name:'Invalid'};await run(path,[invalidType]);assert.equal(result.status,400);
    assert.equal((await request(path+'/sites')).sites.length,1);
    generate=true;await run(path);generate=false;assert.equal(result.name,'Generated site');assert.match(await(await fetch(app.origin+result.path)).text(),/Generated page/);
    args={file,name:'Changed',site:site.id,revision:1};await run(path);assert.equal(result.revision,2);
    await run(path);assert.equal(result.status,409);
    tool='delete_site';args={site:site.id,revision:2};await run(other);assert.equal(result.status,404);
    tool='list_sites';args={};await run(other);assert.deepEqual(result.sites,[]);await run(path);assert.equal(result.sites.find((row:any)=>row.id===site.id).revision,2);
    tool='publish_site';args={file,name:'Denied channel'};await run(`/api/channels/${room.id}`,[],'failed');assert.equal(advertised,false);
    const sideFile=await upload(sidePath,'<h1>Side</h1>');args={file:sideFile,name:'Side site'};await run(sidePath,[sideFile]);assert.equal(result.revision,1);
    const sideSite=result;
    assert.deepEqual((await request(sidePath+'/panel')).sites.map((row:any)=>row.id),[sideSite.id]);
    assert(!(await request(path+'/panel')).sites.some((row:any)=>row.id===sideSite.id));
    const scoped=await fetch(app.origin+sidePath+'/panel/sites/'+sideSite.id);assert.equal(scoped.status,200);assert.match(await scoped.text(),/Side/);
    assert.equal((await fetch(app.origin+path+'/panel/sites/'+sideSite.id)).status,404);

    args={file,name:'Durable',site:site.id,revision:2};hold=true;observed=false;const interrupted=randomUUID();await request(path+'/turns',{id:interrupted,text:'Hold result'});await waitFor(async()=>observed);assert.equal(result.revision,3);
    await app.close();app=await startApp(options);hold=false;
    await request(path+'/sites',{id:randomUUID(),site:site.id,revision:3,name:'User latest',source:'<h1>User latest</h1>'});
    const paused=await until(path,interrupted,'interrupted');await request(`${path}/turns/${interrupted}/resume`,{id:randomUUID(),revision:paused.revision,acknowledgeUncertain:true});await until(path,interrupted);
    assert.equal(result.revision,3);assert.equal((await request(path+'/sites/'+site.id)).revision,4);
    tool='delete_site';args={site:site.id,revision:4};const cancelled=randomUUID();before=()=>request(`${path}/turns/${cancelled}/cancel`,{id:randomUUID()});await request(path+'/turns',{id:cancelled,text:'Cancel deletion'});await until(path,cancelled,'cancelled');assert.equal((await request(path+'/sites/'+site.id)).deleted,0);
    await run(path);assert.equal(result.deleted,1);assert.equal((await fetch(app.origin+site.path)).status,404);
  } finally { await app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(directory,{recursive:true,force:true}); }
});
