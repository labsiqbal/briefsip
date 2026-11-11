import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceBindings, workspaceRead } from './workspace-files.ts';
import { startApp } from './server.ts';

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

test('workspace tools share agent direct/side binding, deny unbound and channel access across restart', async () => {
  const dir=mkdtempSync(join(tmpdir(),'briefsip-workspace-http-')), root=join(dir,'root');mkdirSync(root);writeFileSync(join(root,'note.txt'),'OWN_WORKSPACE');
  const agent=randomUUID(), other=randomUUID(); let advertised=false;
  const provider=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);
    advertised=data.tools.some((tool:any)=>tool.function.name==='read_workspace_file');
    const result=data.messages.findLast((message:any)=>message.role==='tool');
    res.end(JSON.stringify({choices:[{finish_reason:result?'stop':'tool_calls',message:result?{content:JSON.parse(result.content).text}:{tool_calls:[{id:'read',type:'function',function:{name:'read_workspace_file',arguments:JSON.stringify({path:'note.txt'})}}]}}]}));
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();assert(address&&typeof address!=='string');
  const options={database:join(dir,'db.sqlite'),baseURL:`http://127.0.0.1:${address.port}/v1`,workspaces:[{agent,directory:root}]};let app=await startApp(options);
  async function request(path:string,body?:unknown):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await res.json();assert(res.ok,JSON.stringify(value));return value;}
  async function send(path:string){const id=randomUUID();await request(path,{id,text:'Read workspace'});for(let n=0;n<200;n++){const turn=(await request(path)).find((row:any)=>row.id===id);if(['done','failed'].includes(turn.status))return turn;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out');}
  try {
    for(const id of [agent,other])await request('/api/agents',{id,name:id===agent?'Bound':'Unbound',model:'test',instructions:'Help'});
    assert.equal((await send(`/api/agents/${agent}/turns`)).reply,'OWN_WORKSPACE');assert(advertised);
    const side=await request(`/api/agents/${agent}/threads`,{id:randomUUID(),name:'Side'});assert.equal((await send(`/api/threads/${side.id}/turns`)).reply,'OWN_WORKSPACE');
    assert.equal((await send(`/api/agents/${other}/turns`)).status,'failed');assert(!advertised);
    const channel=await request('/api/channels',{id:randomUUID(),name:'Team',instructions:'Help',members:[agent],lead:agent});
    assert.equal((await send(`/api/channels/${channel.id}/turns`)).status,'failed');assert(!advertised);
    await app.close();app=await startApp(options);assert.equal((await send(`/api/agents/${agent}/turns`)).reply,'OWN_WORKSPACE');
    await app.close();app=await startApp({...options,workspaces:[]});assert.equal((await send(`/api/agents/${agent}/turns`)).status,'failed');assert(!advertised);
  } finally {await app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
