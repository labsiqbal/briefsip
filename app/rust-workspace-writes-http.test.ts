import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './test-bridge.ts';
import { restoreWorkspace, workspaceSnapshot } from './test-support/backup.ts';

test('restored incomplete workspace intent resumes with uncertainty without replaying the write', async () => {
  const dir=mkdtempSync(join(tmpdir(),'briefsip-write-restore-')),root=join(dir,'old'),fresh=join(dir,'fresh');mkdirSync(root);mkdirSync(fresh);
  const agent=randomUUID(),turn=randomUUID(),payloads:any[]=[];
  const provider=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;payloads.push(JSON.parse(raw));res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Inspect previous write before continuing.'}}]}));});
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();assert(address&&typeof address!=='string');
  const options={database:join(dir,'source.sqlite'),baseURL:`http://127.0.0.1:${address.port}/v1`,workspaces:[{agent,directory:root,write:true}]};let app=await startApp(options);
  async function request(path:string,body?:unknown):Promise<any>{const response=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await response.json();assert(response.ok,JSON.stringify(value));return value;}
  const path=`/api/agents/${agent}/turns`;
  try {
    await request('/api/agents',{runtime:'api', id:agent,name:'Restore writer',model:'fixture',instructions:'Help'});
    await request(path,{id:turn,text:'Create file'});
    for(let n=0;n<200;n++){if((await request(path))[0].status==='done')break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal((await request(path))[0].status,'done');await app.close();payloads.length=0;
    // Seed the crash boundary: durable intent exists, but its result was never saved.
    const db=new DatabaseSync(options.database);
    try {
      db.prepare("UPDATE turns SET status='running',reply='',paused=0 WHERE id=?").run(turn);
      const call={id:'unfinished-write',type:'function',function:{name:'create_workspace_file',arguments:JSON.stringify({path:'result.txt',text:'Original bytes'})}};
      db.prepare('INSERT INTO workspace_writes VALUES (?,?,?,?,?)').run(turn,call.id,JSON.stringify(call),0,0);
      writeFileSync(join(root,'result.txt'),'Original bytes');
      const snapshot=await workspaceSnapshot(db);
      try {restoreWorkspace(snapshot.file,join(dir,'restored.sqlite'));} finally {snapshot.cleanup();}
    } finally {db.close();}
    const restored={...options,database:join(dir,'restored.sqlite'),workspaces:[{agent,directory:fresh,write:true}]};
    for(let restart=0;restart<2;restart++){
      app=await startApp(restored);
      const row=(await request(path))[0];assert.equal(row.status,'interrupted');assert.equal(row.paused,1);
      await new Promise(resolve=>setTimeout(resolve,150));assert.equal(payloads.length,0);assert.deepEqual(readdirSync(fresh),[]);
      await app.close();
    }
    app=await startApp(restored);const row=(await request(path))[0];
    await request(`${path}/${turn}/resume`,{id:randomUUID(),revision:row.revision,acknowledgeUncertain:true});
    for(let n=0;n<200;n++){if((await request(path))[0].status==='done')break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal((await request(path))[0].status,'done');assert.equal(payloads.length,1);
    const results=payloads[0].messages.filter((message:any)=>message.role==='tool'&&message.tool_call_id==='unfinished-write');
    assert.equal(results.length,1);assert.equal(JSON.parse(results[0].content).uncertain,true);
    assert.deepEqual(readdirSync(fresh),[]);assert.equal(readFileSync(join(root,'result.txt'),'utf8'),'Original bytes');
    await app.close();const saved=new DatabaseSync(restored.database);
    try {assert.equal(saved.prepare("SELECT count(*) AS n FROM flow_tool_calls WHERE turn=? AND call_id='unfinished-write'").get(turn)!.n,1);} finally {saved.close();}
  } finally {await app.close().catch(()=>{});provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

for (const mode of ['file','directory','skill','delete','restore','replace']) test(`write grant creates ${mode} once through provider and result journal survives restart`, async () => {
  const directory = mode === 'directory', deleting = mode === 'delete', restoring = mode === 'restore', replacing = mode === 'replace', skill = randomUUID();
  const dir=mkdtempSync(join(tmpdir(),'briefsip-workspace-write-http-')),root=join(dir,'root');mkdirSync(root);
  if(replacing)writeFileSync(join(root,'made.txt'),'OLD');
  if(deleting)writeFileSync(join(root,'made.txt'),'RESULT');
  const recoveryInput=[...Array(8).fill('d'.repeat(250)), 'e'.repeat(38), 'f'].join('/');
  if(restoring){assert.equal(recoveryInput.length,2048);mkdirSync(join(root,recoveryInput,'..'),{recursive:true});writeFileSync(join(root,recoveryInput),'RESULT');}
  // Seed the on-disk recovery layout from an earlier removal.
  const recoveryPath = join(recoveryInput, '..', '.briefsip-removed-' + randomUUID(), 'file');
  if (restoring) {
    assert(recoveryPath.length > 2048);
    mkdirSync(join(root, recoveryPath, '..'));
    renameSync(join(root, recoveryInput), join(root, recoveryPath));
  }
  const agent=randomUUID(),toolName=replacing?'replace_workspace_file':restoring?'restore_workspace_file':deleting?'delete_workspace_file':directory?'create_workspace_directory':mode==='skill'?'copy_skill_file':'create_workspace_file',args=replacing?{path:'made.txt',digest:createHash('sha256').update('OLD').digest('hex'),text:'RESULT'}:restoring?{path:'made.txt',recoveryPath:recoveryPath,digest:createHash('sha256').update('RESULT').digest('hex')}:deleting?{path:'made.txt',digest:createHash('sha256').update('RESULT').digest('hex')}:directory?{path:'made'}:mode==='skill'?{id:skill,source:'assets/raw.bin',path:'made.txt'}:{path:'made.txt',text:'RESULT'};let writeAdvertised=false,requests=0;
  function checkEffect(){if(replacing){const recovery=readdirSync(root).filter(name=>name.startsWith('.briefsip-removed-'));assert.equal(recovery.length,1);assert.equal(readFileSync(join(root,recovery[0],'file'),'utf8'),'OLD');}if(restoring)assert.equal(readFileSync(join(root,recoveryPath),'utf8'),'RESULT');if(deleting){assert(!existsSync(join(root,'made.txt')));const recovery=readdirSync(root).filter(name=>name.startsWith('.briefsip-removed-'));assert.equal(recovery.length,1);assert.equal(readFileSync(join(root,recovery[0],'file'),'utf8'),'RESULT');}else if(directory)assert(lstatSync(join(root,'made')).isDirectory());else if(mode==='skill')assert.deepEqual(readFileSync(join(root,'made.txt')),Buffer.from([0,255,128,1]));else assert.equal(readFileSync(join(root,'made.txt'),'utf8'),'RESULT');}
  const provider=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);requests++;writeAdvertised=data.tools.some((tool:any)=>tool.function.name===toolName);const prior=data.messages.findLast((message:any)=>message.role==='tool');res.end(JSON.stringify({choices:[{finish_reason:prior?'stop':'tool_calls',message:prior?{content:prior.content}:{tool_calls:[{id:'create',type:'function',function:{name:toolName,arguments:JSON.stringify(args)}}]}}]}));});
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();assert(address&&typeof address!=='string');
  const options={database:join(dir,'db.sqlite'),baseURL:`http://127.0.0.1:${address.port}/v1`,workspaces:[{agent,directory:root,write:true}]};let app=await startApp(options);
  async function request(path:string,body?:unknown):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await res.json();assert(res.ok,JSON.stringify(value));return value;}
  async function until(path:string,id:string){for(let n=0;n<200;n++){const row=(await request(path)).find((row:any)=>row.id===id);if(['done','failed'].includes(row.status))return row;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out');}
  try {
    await request('/api/agents',{runtime:'api', id:agent,name:'Writer',model:'test',instructions:'Help'});
    if(mode==='skill'){
      await request('/api/skills',{id:skill,revision:0,files:[{path:'SKILL.md',content:'---\nname: copying\ndescription: Copy fixtures\n---\nCopy assets on request.'},{path:'assets/raw.bin',content:Buffer.from([0,255,128,1]).toString('base64'),encoding:'base64'}]});
      await request(`/api/agents/${agent}/skills/${skill}`,{id:randomUUID(),revision:0,version:1,enabled:true});
      await request(`/api/skills/${skill}`,{id:randomUUID(),revision:1,files:[{path:'SKILL.md',content:'---\nname: copying\ndescription: New version\n---\nNew assets.'},{path:'assets/raw.bin',content:'NEW'}]});
    }
    const path=`/api/agents/${agent}/turns`,command={id:randomUUID(),text:'Create'};await request(path,command);
    assert.equal((await until(path,command.id)).status,'done');assert(writeAdvertised);checkEffect();
    const count=requests;await app.close();app=await startApp(options);await request(path,command);assert.equal(requests,count);
    const duplicate={id:randomUUID(),text:'Create again'};await request(path,duplicate);assert.match((await until(path,duplicate.id)).reply,deleting?/Removal did not confirm/:/never replaced/);checkEffect();
    const side=await request(`/api/agents/${agent}/threads`,{id:randomUUID(),name:'Side'}),sidePath=`/api/threads/${side.id}/turns`,sideCommand={id:randomUUID(),text:'Side'};
    await request(sidePath,sideCommand);assert.match((await until(sidePath,sideCommand.id)).reply,deleting?/Removal did not confirm/:/never replaced/);assert(writeAdvertised);
    if(mode==='skill'){
      await request(`/api/agents/${agent}/skills/${skill}`,{id:randomUUID(),revision:1,version:1,enabled:false});
      const revoked={id:randomUUID(),text:'Copy disabled skill'};await request(path,revoked);assert.equal((await until(path,revoked.id)).status,'failed');checkEffect();
    }
    const channel=await request('/api/channels',{id:randomUUID(),name:'Team',instructions:'Help',members:[agent],lead:agent}),channelPath=`/api/channels/${channel.id}/turns`,channelCommand={id:randomUUID(),text:'Channel'};
    await request(channelPath,channelCommand);assert.equal((await until(channelPath,channelCommand.id)).status,'failed');assert(!writeAdvertised);
    await app.close();app=await startApp({...options,workspaces:[{agent,directory:root,write:false}]});
    const denied={id:randomUUID(),text:'Denied'};await request(path,denied);assert.equal((await until(path,denied.id)).status,'failed');assert(!writeAdvertised);
  }finally{await app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

test('provider workspace writes reject malformed Unicode without changing bytes or path', async t => {
  const dir = mkdtempSync(join(tmpdir(),'briefsip-workspace-unicode-')), root = join(dir,'root'); mkdirSync(root);
  const agent = randomUUID(); let args = { path: 'bad.txt', text: '\ud800' };
  const provider = createServer(async (req,res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw), prior = data.messages.findLast((message: {role:string}) => message.role === 'tool');
    res.end(JSON.stringify({ choices: [{ finish_reason: prior ? 'stop' : 'tool_calls', message: prior ? { content: 'Done' } : { tool_calls: [{ id: 'unicode', type:'function', function:{ name:'create_workspace_file', arguments:JSON.stringify(args) } }] } }] }));
  });
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  t.after(async () => { await app?.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir,{recursive:true,force:true}); });
  await new Promise<void>(resolve => provider.listen(0,'127.0.0.1',resolve)); const address = provider.address(); assert(address && typeof address !== 'string');
  app = await startApp({ database:join(dir,'db.sqlite'),baseURL:`http://127.0.0.1:${address.port}/v1`,workspaces:[{agent,directory:root,write:true}] });
  const request = async(path:string,body?:unknown) => { const response = await fetch(app!.origin+path,{method:body?'POST':'GET',headers:{Origin:app!.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});assert(response.ok);return response.json(); };
  await request('/api/agents',{runtime:'api', id:agent,name:'Unicode',model:'fixture',instructions:'Help.'});
  const path = `/api/agents/${agent}/turns`;
  for (const invalid of [{path:'bad.txt',text:'\ud800'},{path:'bad\udc00.txt',text:'text'}]) {
    args = invalid; const id = randomUUID(); await request(path,{id,text:'Create requested file.'});
    let row;
    for(let n=0;n<100;n++){row=(await request(path)).find((row:{id:string})=>row.id===id);if(['done','failed'].includes(row.status))break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(row.status,'failed'); assert.deepEqual(readdirSync(root),[]);
  }
  args={path:'valid-\u{1f600}.txt',text:'Exact \u{1f600} text'};
  const id=randomUUID();await request(path,{id,text:'Create valid file.'});
  for(let n=0;n<100;n++){const row=(await request(path)).find((row:{id:string})=>row.id===id);if(row.status==='done')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal((await request(path)).find((row:{id:string})=>row.id===id).status,'done');
  assert.equal(readFileSync(join(root,args.path),'utf8'),args.text);
  writeFileSync(join(root,'replacement-\ufffd.txt'),'KEEP');
  const workspace = `/api/agents/${agent}/workspace/file?path=`;
  const invalid = await fetch(app.origin + workspace + 'replacement-%ED%A0%80.txt');
  assert(!invalid.ok);
  assert.equal((await request(workspace + 'replacement-%EF%BF%BD.txt')).text, 'KEEP');
});
