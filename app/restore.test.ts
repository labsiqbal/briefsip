import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeCanonicalSchema } from './schema.ts';
import { prepareRestoreBootstrap, issueRestoreSession, requireRestoreSession, restoreWorkspace, workspaceSnapshot } from './backup.ts';
import { createProjectAccess } from './project-access.ts';
import { createMailWorker } from './mail.ts';
import { startApp } from './test-bridge.ts';
import { cli } from './cli.ts';
import { sha256, ProtocolError } from './shared/protocol.ts';
import type { HumanActor } from './auth.ts';

test('canonical backup restores private evidence with fresh authority and no revived invitation or execution', async () => {
  const dir=mkdtempSync(join(tmpdir(),'briefsip-restore-')),source=join(dir,'source.sqlite'),destination=join(dir,'restored.sqlite');
  const db=new DatabaseSync(source);initializeCanonicalSchema(db);
  const actor=(subject:string):HumanActor=>({accountId:randomUUID(),issuer:'https://fixture.example',subject,sessionId:`sess_${subject}`,expiresAt:Date.now()+60000});
  const owner=actor('owner'),member=actor('member');
  for(const a of [owner,member])db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(a.accountId,a.issuer,a.subject,Date.now());
  const auth={requireCurrent:(a:HumanActor)=>a,verifiedMailboxes:async()=>['member@example.com']};
  const mail={keyId:randomUUID(),key:Buffer.alloc(32,7),lookupKey:Buffer.alloc(32,8),from:'Briefsip <owner@example.com>',origin:'https://briefsip.example'};
  const access=createProjectAccess(db,auth,()=>mail),project=randomUUID();
  access.createProject(owner,{requestId:randomUUID(),id:project,name:'Private recovery'});
  db.prepare("INSERT INTO project_members VALUES (?,?,'member',1,0)").run(project,member.accountId);
  const invitation=randomUUID(),token=Buffer.alloc(32,1).toString('base64url'),authority=String(db.prepare('SELECT generation FROM authority_state').get()!.generation);
  db.prepare("INSERT INTO invitations VALUES (?,?,?,? ,NULL,'sent',?,'[]',?,NULL,1)").run(invitation,project,authority,sha256('member@example.com'),sha256(Buffer.from(token,'base64url')),Date.now()+60000);
  db.prepare("INSERT INTO mail_outbox VALUES (?,1,?,'queued',NULL,NULL,0,NULL,?)").run(invitation,Buffer.from('private token envelope'),sha256('mail'));
  const installation=randomUUID(),device=randomUUID(),agent=randomUUID();
  db.prepare('INSERT INTO installations VALUES (?,?,?,?,1,0,1,?)').run(installation,owner.accountId,'installation-key',sha256('installation'),Date.now());
  db.prepare("INSERT INTO devices VALUES (?,?,?,?,?,?,?,'{}',1,1,'ready','Asia/Jakarta',1,?,'[\"execution\"]',1)").run(device,installation,owner.accountId,'signing-key','encryption-key',sha256('signing'),sha256('encryption'),Date.now());
  db.prepare("INSERT INTO device_sessions VALUES (?,?,1,?,?,0)").run(sha256('old-device-session'),device,authority,Date.now()+60000);
  db.prepare('INSERT INTO agents(id,name,model,instructions) VALUES (?,?,?,?)').run(agent,'Agent','fixture','Help');
  db.prepare("INSERT INTO agent_projects VALUES (?,?,'','{\"tools\":[]}',1,0)").run(project,agent);
  db.prepare('INSERT INTO collaborator_agents VALUES (?,?,?,1,1)').run(project,member.accountId,agent);
  const task=randomUUID(),snapshot=randomUUID(),request=randomUUID(),action=randomUUID(),payload=JSON.stringify({v:1,kind:'direct',message:{text:'Recover',files:[]}});
  db.prepare("INSERT INTO turns(id,agent,text,status,created) VALUES (?,?,?,'running',?)").run(task,agent,'Recover',new Date().toISOString());
  db.prepare("INSERT INTO tasks VALUES (?,?,NULL,?,?,?,?,1,1,?,'{\"tools\":[]}',NULL,NULL,NULL,'running',?,?,1,?)").run(task,task,project,agent,owner.accountId,device,sha256('capabilities'),sha256(payload),payload,Date.now());
  db.prepare("INSERT INTO receipts VALUES (?,?,?,'fixture',?,200,'{}',?)").run(request,owner.accountId,project,sha256('receipt'),Date.now());
  db.prepare("INSERT INTO task_context_snapshots VALUES (?,1,?,?,1,1,1,1,?,'{}',?,?)").run(task,snapshot,authority,sha256('{}'),request,Date.now());
  db.prepare("INSERT INTO task_actions(id,task,sequence,action_kind,authority_generation,device_generation,executor_generation,intent_digest,context_snapshot_id,context_digest,grant_revision,state,committed_at,effect_status) VALUES (?,?,0,'read',?,1,1,?,?,?,1,'committed',?,'unknown')").run(action,task,authority,sha256('intent'),snapshot,sha256('{}'),Date.now());
  db.prepare("INSERT INTO execution_owners VALUES (?,?,?,1,1,?,'{}',0,?,0)").run(task,device,authority,sha256('executor'),Date.now());
  let backup:Awaited<ReturnType<typeof workspaceSnapshot>>|undefined;
  try{
    const retained={receipts:db.prepare('SELECT * FROM receipts ORDER BY request_id').all(),context:db.prepare('SELECT * FROM task_context_snapshots').all(),history:db.prepare('SELECT id,agent,text,reply,created FROM turns').all(),payload:db.prepare('SELECT id,logical_turn,project,agent,initiator_account,home_device,payload_digest,payload_json FROM tasks').all()};
    backup=await workspaceSnapshot(db);const bytes=readFileSync(backup.file);
    // Revocations newer than this backup are unavailable to its restored copy.
    access.revokeInvitation(owner,invitation,{requestId:randomUUID(),expectedRevision:1});
    restoreWorkspace(backup.file,destination);
    assert.deepEqual(readFileSync(backup.file),bytes);assert.equal(statSync(destination).mode&0o777,0o600);
    const restored=new DatabaseSync(destination);
    try{
      const current=restored.prepare('SELECT * FROM authority_state').get()!;
      assert.notEqual(current.generation,authority);assert.equal(current.serving_state,'read_only_recovery');
      assert.equal(current.recovery_session_hash,null);
      assert.equal(restored.prepare('SELECT revoked FROM device_sessions').get()!.revoked,1);
      assert.equal(restored.prepare('SELECT status FROM devices').get()!.status,'revoked');
      assert.equal(restored.prepare("SELECT deleted FROM project_members WHERE role='member'").get()!.deleted,1);
      assert.equal(restored.prepare("SELECT deleted FROM project_members WHERE role='owner'").get()!.deleted,0);
      assert.equal(restored.prepare('SELECT enabled FROM collaborator_agents').get()!.enabled,0);
      assert.equal(restored.prepare('SELECT state FROM invitations').get()!.state,'revoked');
      assert.equal(restored.prepare('SELECT state FROM mail_outbox').get()!.state,'revoked');
      assert.equal((restored.prepare('SELECT ciphertext FROM mail_outbox').get()!.ciphertext as Uint8Array).length,0);
      assert.equal(restored.prepare('SELECT state FROM task_actions').get()!.state,'uncertain');
      assert.equal(restored.prepare('SELECT state FROM tasks').get()!.state,'uncertain');
      assert.equal(restored.prepare('SELECT paused FROM turns').get()!.paused,1);
      assert.equal(restored.prepare('SELECT stopped FROM execution_owners').get()!.stopped,1);
      assert.equal(restored.prepare('SELECT count(*) n FROM receipts').get()!.n,2);
      assert.deepEqual(restored.prepare('SELECT * FROM receipts ORDER BY request_id').all(),retained.receipts);
      assert.deepEqual(restored.prepare('SELECT * FROM task_context_snapshots').all(),retained.context);
      assert.deepEqual(restored.prepare('SELECT id,agent,text,reply,created FROM turns').all(),retained.history);
      assert.deepEqual(restored.prepare('SELECT id,logical_turn,project,agent,initiator_account,home_device,payload_digest,payload_json FROM tasks').all(),retained.payload);
      assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(),[]);
      const recovered=createProjectAccess(restored,auth,()=>mail);
      await assert.rejects(recovered.acceptInvitation(member,invitation,{requestId:randomUUID(),mailboxProof:token,expectedRevision:1}),error=>error instanceof ProtocolError&&error.code==='authority_unavailable');
      restored.exec("UPDATE authority_state SET serving_state='active'");
      await assert.rejects(recovered.acceptInvitation(member,invitation,{requestId:randomUUID(),mailboxProof:token,expectedRevision:1}),error=>error instanceof ProtocolError&&error.code==='resource_not_found');
      restored.exec("UPDATE authority_state SET serving_state='read_only_recovery'");
      let deliveries=0;
      const originalFetch=globalThis.fetch;
      globalThis.fetch=async()=>{deliveries++;throw new Error('No old delivery');};
      try{const worker=createMailWorker(restored,{apiKey:'fixture',key:()=>mail.key});await worker.deliver(invitation);assert.equal(deliveries,0);}finally{globalThis.fetch=originalFetch;}
      const second=join(dir,'second.sqlite'),again=await workspaceSnapshot(restored);
      try{restoreWorkspace(again.file,second);const reloaded=new DatabaseSync(second);try{assert.notEqual(reloaded.prepare('SELECT generation FROM authority_state').get()!.generation,current.generation);}finally{reloaded.close();}}finally{again.cleanup();}
    }finally{restored.close();}
    await assert.rejects(startApp({database:destination}),/canonical/i);
  }finally{backup?.cleanup();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('pre-v3 canonical restore disables retained automation and rejects downgraded or changed backup authority',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'briefsip-restore-versions-'));
  try{
    for(const version of [1,2] as const){
      const db=new DatabaseSync(join(dir,`source-${version}.sqlite`));initializeCanonicalSchema(db,Date.now(),version);
      db.exec("CREATE TABLE routines(enabled INTEGER,revision INTEGER); INSERT INTO routines VALUES (1,1); CREATE TABLE turn_waits(status TEXT); INSERT INTO turn_waits VALUES ('waiting'); CREATE TABLE workflow_schedules(enabled INTEGER,revision INTEGER); INSERT INTO workflow_schedules VALUES (1,1)");
      const backup=await workspaceSnapshot(db);db.close();
      try{
        const target=join(dir,`target-${version}.sqlite`);restoreWorkspace(backup.file,target);
        const restored=new DatabaseSync(target);try{
          assert.equal(restored.prepare('SELECT serving_state FROM authority_state').get()!.serving_state,'read_only_recovery');
          assert.equal(restored.prepare('SELECT enabled FROM routines').get()!.enabled,0);
          assert.equal(restored.prepare('SELECT enabled FROM workflow_schedules').get()!.enabled,0);
          assert.equal(restored.prepare('SELECT status FROM turn_waits').get()!.status,'closed');
        }finally{restored.close();}
        const tampered=new DatabaseSync(backup.file);
        tampered.exec("UPDATE briefsip_backup_authority SET generation='wrong'");tampered.close();
        const invalid=join(dir,`invalid-${version}.sqlite`);assert.throws(()=>restoreWorkspace(backup.file,invalid),/authority mismatch/);assert(!existsSync(invalid));
        const downgraded=new DatabaseSync(backup.file);downgraded.exec("UPDATE briefsip_backup SET format='briefsip-workspace',version=1");downgraded.close();
        assert.throws(()=>restoreWorkspace(backup.file,invalid),/backup format/);assert(!existsSync(invalid));
      }finally{backup.cleanup();}
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('read-only restore upgrades legacy canonical owner marker before reconcile',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'briefsip-restore-legacy-marker-')),db=new DatabaseSync(join(dir,'source.sqlite'));
  initializeCanonicalSchema(db);
  const owner={accountId:randomUUID(),issuer:'https://fixture.example',subject:'owner',sessionId:'owner-session',expiresAt:Date.now()+60000};
  db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(owner.accountId,owner.issuer,owner.subject,Date.now());
  const project=randomUUID();db.prepare('INSERT INTO projects(id,account,name,private,deleted,revision) VALUES (?,?,?,1,0,1)').run(project,owner.accountId,'Owner project');
  db.prepare("INSERT INTO project_members(project,account,role,grant_revision,deleted) VALUES (?,?, 'owner',1,0)").run(project,owner.accountId);
  const backup=await workspaceSnapshot(db);db.close();
  try{
    const legacy=new DatabaseSync(backup.file);const generation=legacy.prepare('SELECT generation FROM briefsip_backup_authority').get()!.generation;
    legacy.exec('ALTER TABLE briefsip_backup_authority RENAME TO briefsip_backup_authority_new; CREATE TABLE briefsip_backup_authority(generation TEXT NOT NULL) STRICT;');
    legacy.prepare('INSERT INTO briefsip_backup_authority VALUES (?)').run(generation);legacy.exec('DROP TABLE briefsip_backup_authority_new');legacy.close();
    const restoredPath=join(dir,'restored.sqlite');restoreWorkspace(backup.file,restoredPath,{canonicalOnly:true});
    const restored=new DatabaseSync(restoredPath);try{
      assert.equal(restored.prepare('SELECT owner_account FROM briefsip_backup_authority').get()!.owner_account,owner.accountId);
      const gate=prepareRestoreBootstrap(restored);const auth={requireCurrent:(actor:HumanActor)=>actor};
      assert.equal(issueRestoreSession(restored,auth,owner,gate.bootstrap).recoveryGeneration,gate.recoveryGeneration);
    }finally{restored.close();}
  }finally{backup.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test('operator CLI restores a canonical backup read-only without script credentials',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'briefsip-restore-cli-')),db=new DatabaseSync(join(dir,'source.sqlite'));initializeCanonicalSchema(db);
  const backup=await workspaceSnapshot(db);db.close();
  try{
    const target=join(dir,'restored.sqlite'),result=await cli(['restore','--read-only',backup.file,'--db',target],undefined);
    assert.equal(result.exitCode,0);assert.equal(result.database,target);assert.equal(result.state,'read_only_recovery');
    const restored=new DatabaseSync(target);try{assert.equal(restored.prepare('SELECT serving_state FROM authority_state').get()!.serving_state,'read_only_recovery');}finally{restored.close();}
    await assert.rejects(cli(['restore','--read-only',backup.file,'--db',target,'--activate'],undefined),/restore/);
    const legacy=join(dir,'legacy.sqlite'),old=new DatabaseSync(legacy);old.exec("CREATE TABLE briefsip_backup(format TEXT,version INTEGER); INSERT INTO briefsip_backup VALUES ('briefsip-workspace',1)");old.close();
    const invalid=join(dir,'invalid.sqlite');await assert.rejects(cli(['restore','--read-only',legacy,'--db',invalid],undefined),/canonical backup/);assert(!existsSync(invalid));
  }finally{backup.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test('local restore bootstrap requires recorded owner identity and issues expiring ingest-only proof',()=>{
  const db=new DatabaseSync(':memory:');initializeCanonicalSchema(db);
  const owner:HumanActor={accountId:randomUUID(),issuer:'https://fixture.example',subject:'owner',sessionId:'owner-session',expiresAt:Date.now()+60000};
  const stranger={...owner,accountId:randomUUID(),subject:'stranger'},auth={requireCurrent:(a:HumanActor)=>a};
  for(const actor of [owner,stranger])db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(actor.accountId,actor.issuer,actor.subject,Date.now());
  const access=createProjectAccess(db,{...auth,verifiedMailboxes:async()=>[]},()=>{throw new Error('No mail');});
  access.createProject(owner,{requestId:randomUUID(),id:randomUUID(),name:'Owner only'});
  access.createProject(stranger,{requestId:randomUUID(),id:randomUUID(),name:'Other account project'});
  db.exec('CREATE TABLE briefsip_backup_authority(generation TEXT,owner_account TEXT)');
  db.prepare('INSERT INTO briefsip_backup_authority SELECT generation,? FROM authority_state').run(owner.accountId);
  const denied=(error:unknown)=>error instanceof ProtocolError&&error.code==='recovery_session_invalid';
  try{
    assert.throws(()=>prepareRestoreBootstrap(db),denied);
    db.exec("UPDATE authority_state SET serving_state='read_only_recovery'");
    const gate=prepareRestoreBootstrap(db);
    assert.throws(()=>requireRestoreSession(db,auth,owner,gate.bootstrap,gate.recoveryGeneration),denied);
    assert.throws(()=>issueRestoreSession(db,auth,stranger,gate.bootstrap),denied);
    assert.throws(()=>issueRestoreSession(db,auth,{...owner,issuer:'https://wrong.example'},gate.bootstrap),denied);
    const proof=issueRestoreSession(db,auth,owner,gate.bootstrap);
    assert.equal(requireRestoreSession(db,auth,owner,proof.session,proof.recoveryGeneration).serving_state,'read_only_recovery');
    assert.throws(()=>issueRestoreSession(db,auth,owner,gate.bootstrap),denied);
    assert.throws(()=>requireRestoreSession(db,auth,stranger,proof.session,proof.recoveryGeneration),denied);
    assert.throws(()=>requireRestoreSession(db,auth,owner,proof.session,randomUUID()),denied);
    const state=db.prepare('SELECT * FROM authority_state').get()!;assert(!JSON.stringify(state).includes(proof.session));assert(!JSON.stringify(state).includes(gate.bootstrap));
    db.exec('UPDATE authority_state SET recovery_expires_at=0');
    assert.throws(()=>requireRestoreSession(db,auth,owner,proof.session,proof.recoveryGeneration),denied);
    assert.equal(db.prepare('SELECT count(*) n FROM tasks').get()!.n,0);
    assert.equal(db.prepare('SELECT serving_state FROM authority_state').get()!.serving_state,'read_only_recovery');
  }finally{db.close();}
});
