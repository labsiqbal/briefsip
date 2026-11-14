import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceBindings, workspaceInspect, workspaceRead } from './workspace-files.ts';
import { startApp } from './server.ts';

test('workspace browser API pages text and directories while enforcing host binding and read boundaries', async () => {
  const dir=mkdtempSync(join(tmpdir(),'briefsip-workspace-browser-')),root=join(dir,'root');mkdirSync(root);
  const agent=randomUUID(),other=randomUUID();let app=await startApp({database:join(dir,'db.sqlite'),workspaces:[{agent,directory:root}]});
  async function get(route:string,status=200,headers:Record<string,string>={}){const response=await fetch(app.origin+route,{headers});assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');return response.json();}
  const path=`/api/agents/${agent}/workspace`;
  try {
    for(const id of [agent,other]){const response=await fetch(app.origin+'/api/agents',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({id,name:'Browser',model:'fixture',instructions:'Help'})});assert(response.ok);}
    mkdirSync(join(root,'pages'));for(let i=0;i<101;i++)writeFileSync(join(root,'pages',String(i).padStart(3,'0')),'');
    writeFileSync(join(root,'text.html'),'<script>alert(1)</script>'+'x'.repeat(8000));
    writeFileSync(join(dir,'outside'),'PRIVATE');symlinkSync('../outside',join(root,'link'));linkSync(join(dir,'outside'),join(root,'hard'));symlinkSync(dir,join(root,'directory-link'));
    writeFileSync(join(root,'binary'),Buffer.from([255]));writeFileSync(join(root,'large'),'x'.repeat(256*1024+1));
    for(const [name,bytes] of [['raw.bin',Buffer.from([0,255,1])],["quote'().html",Buffer.from('<script>alert(1)</script>')],['limit',Buffer.alloc(10*1024*1024,7)]] as const){
      writeFileSync(join(root,name),bytes);
      const response=await fetch(app.origin+path+'/download?path='+encodeURIComponent(name));assert.equal(response.status,200);
      assert.equal(response.headers.get('content-type'),'application/octet-stream');assert.match(response.headers.get('content-disposition')!,/^attachment;/);
      assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
    }
    writeFileSync(join(root,'too-large'),Buffer.alloc(10*1024*1024+1));
    for(const name of ['too-large','pages','link','hard','directory-link/outside','../outside','/etc/passwd'])await get(path+'/download?path='+encodeURIComponent(name),400);
    await get(path+'/download?path=raw.bin&offset=0',400);await get(path+'/download?path=raw.bin&path=large',400);
    await get(path+'/download?path=raw.bin',403,{Origin:'https://external.invalid'});
    await get(`/api/agents/${other}/workspace/download?path=raw.bin`,403);
    const first=await get(path+'/entries?path=pages');assert.equal(first.entries.length,100);
    const last=await get(path+'/entries?path=pages&after='+encodeURIComponent(first.next_after));assert.deepEqual(last.entries,[{name:'100',kind:'file'}]);assert.equal(last.next_after,null);
    const file=await get(path+'/file?path=text.html');assert(file.text.startsWith('<script>'));assert.equal(file.next_offset,8000);
    const end=await get(path+'/file?path=text.html&offset=8000&digest='+file.digest);assert.equal(file.text+end.text,'<script>alert(1)</script>'+'x'.repeat(8000));assert.equal(end.next_offset,null);
    writeFileSync(join(root,'text.html'),'new');assert.match((await get(path+'/file?path=text.html&offset=8000&digest='+file.digest,409)).error,/File changed.*Reload from the start/);
    assert.equal((await get(path+'/file?path=text.html')).text,'new');
    for(const name of ['../outside','/etc/passwd','link','hard','directory-link/outside','binary','large']){const response=await get(path+'/file?path='+encodeURIComponent(name),400);assert(!JSON.stringify(response).includes('PRIVATE'));assert(!JSON.stringify(response).includes(dir));}
    for(const suffix of ['/entries?extra=x','/entries?__proto__=x','/entries?path=pages&path=','/entries?offset=0','/file?path=text.html&offset=-1','/file?path=text.html&offset=1e2','/file?path=text.html&digest=bad'])await get(path+suffix,400);
    await get(path+'/entries',403,{Origin:'https://external.invalid'});await get(path+'/entries',403,{'sec-fetch-site':'cross-site'});
    await get(`/api/agents/${other}/workspace/entries`,403);await get(`/api/agents/${randomUUID()}/workspace/entries`,404);
    await app.close();app=await startApp({database:join(dir,'db.sqlite'),workspaces:[]});await get(path+'/file?path=text.html',403);
  } finally {await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('workspace descriptor reads reject escapes and changed pages, retain bounded listing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-workspace-')), root = join(dir,'root'); mkdirSync(root);
  try {
    const agent = randomUUID(); assert.equal(workspaceBindings([{ agent, directory: root }]).get(agent)?.directory, root);
    writeFileSync(join(root,'text'), 'a'.repeat(8000)+'end');
    const first = workspaceRead(root,false,{path:'text'}); assert.equal(first.next_offset,8000);
    assert.equal(workspaceRead(root,false,{path:'text',offset:8000,digest:first.digest}).text,'end');
    writeFileSync(join(root,'text'),'changed'); assert.throws(()=>workspaceRead(root,false,{path:'text',offset:8000,digest:first.digest}));
    writeFileSync(join(dir,'outside'),'PRIVATE'); symlinkSync('../outside',join(root,'link')); symlinkSync(dir,join(root,'directory-link'));
    linkSync(join(dir,'outside'),join(root,'hard'));
    for(const path of ['../outside','/etc/passwd','directory-link/outside','link','hard','a/../text','text/','./text'])assert.throws(()=>workspaceInspect(root,{path}));
    assert.throws(()=>workspaceInspect(root,{path:'text',extra:true}));
    const limit=Buffer.alloc(10*1024*1024,255);writeFileSync(join(root,'limit'),limit);
    assert.deepEqual(workspaceInspect(root,{path:'limit'}),{path:'limit',size:limit.length,digest:createHash('sha256').update(limit).digest('hex')});
    writeFileSync(join(root,'oversize'),Buffer.alloc(limit.length+1));assert.throws(()=>workspaceInspect(root,{path:'oversize'}));
    writeFileSync(join(root,'empty'),Buffer.alloc(0));assert.equal(workspaceInspect(root,{path:'empty'}).size,0);
    for(const path of ['../outside','/etc/passwd','directory-link/outside','link','hard','a/../text','text/','./text']) assert.throws(()=>workspaceRead(root,false,{path}));
    writeFileSync(join(root,'binary'),Buffer.from([0xff])); assert.throws(()=>workspaceRead(root,false,{path:'binary'}));
    writeFileSync(join(root,'large'),Buffer.alloc(256*1024+1)); assert.throws(()=>workspaceRead(root,false,{path:'large'}));
    mkdirSync(join(root,'pages')); for(let n=0;n<101;n++)writeFileSync(join(root,'pages',String(n).padStart(3,'0')),'');
    const page=workspaceRead(root,true,{path:'pages'});assert.equal(page.entries?.length,100);
    const last=workspaceRead(root,true,{path:'pages',after:page.next_after});assert.equal(last.entries?.length,1);assert.equal(last.next_after,null);
    rmSync(join(root,'pages','099'));writeFileSync(join(root,'pages','099\n'),'');
    const unusual=workspaceRead(root,true,{path:'pages'});
    assert.equal(workspaceRead(root,true,{path:'pages',after:unusual.next_after}).entries?.[0].name,'100');
    assert.throws(()=>workspaceBindings([{agent,directory:join(root,'directory-link')}]));
    assert.throws(()=>workspaceBindings([{agent,directory:root},{agent,directory:root}]));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

for (const metadata of [false,true]) test(`workspace tools metadata=${metadata} share agent direct/side binding, deny unbound and channel access across restart`, async () => {
  const dir=mkdtempSync(join(tmpdir(),'briefsip-workspace-http-')), root=join(dir,'root');mkdirSync(root);writeFileSync(join(root,'note.txt'),'OWN_WORKSPACE');
  const agent=randomUUID(), other=randomUUID(), toolName=metadata?'inspect_workspace_file':'read_workspace_file'; let advertised=false;
  const binary=Buffer.from([0,255,128,42]);if(metadata)writeFileSync(join(root,'note.txt'),binary);
  const expected=metadata?JSON.stringify({path:'note.txt',size:binary.length,digest:createHash('sha256').update(binary).digest('hex')}):'OWN_WORKSPACE';
  const provider=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);
    advertised=data.tools.some((tool:any)=>tool.function.name===toolName);
    const result=data.messages.findLast((message:any)=>message.role==='tool');
    res.end(JSON.stringify({choices:[{finish_reason:result?'stop':'tool_calls',message:result?{content:metadata?result.content:JSON.parse(result.content).text}:{tool_calls:[{id:'read',type:'function',function:{name:toolName,arguments:JSON.stringify({path:'note.txt'})}}]}}]}));
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();assert(address&&typeof address!=='string');
  const options={database:join(dir,'db.sqlite'),baseURL:`http://127.0.0.1:${address.port}/v1`,workspaces:[{agent,directory:root}]};let app=await startApp(options);
  async function request(path:string,body?:unknown):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await res.json();assert(res.ok,JSON.stringify(value));return value;}
  async function send(path:string){const id=randomUUID();await request(path,{id,text:'Read workspace'});for(let n=0;n<200;n++){const turn=(await request(path)).find((row:any)=>row.id===id);if(['done','failed'].includes(turn.status))return turn;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out');}
  try {
    for(const id of [agent,other])await request('/api/agents',{id,name:id===agent?'Bound':'Unbound',model:'test',instructions:'Help'});
    assert.equal((await send(`/api/agents/${agent}/turns`)).reply,expected);assert(advertised);
    const side=await request(`/api/agents/${agent}/threads`,{id:randomUUID(),name:'Side'});assert.equal((await send(`/api/threads/${side.id}/turns`)).reply,expected);
    assert.equal((await send(`/api/agents/${other}/turns`)).status,'failed');assert(!advertised);
    const channel=await request('/api/channels',{id:randomUUID(),name:'Team',instructions:'Help',members:[agent],lead:agent});
    assert.equal((await send(`/api/channels/${channel.id}/turns`)).status,'failed');assert(!advertised);
    await app.close();app=await startApp(options);assert.equal((await send(`/api/agents/${agent}/turns`)).reply,expected);
    await app.close();app=await startApp({...options,workspaces:[]});assert.equal((await send(`/api/agents/${agent}/turns`)).status,'failed');assert(!advertised);
  } finally {await app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
