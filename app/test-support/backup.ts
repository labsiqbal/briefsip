import { type DatabaseSync, backup } from 'node:sqlite';
import { testDatabase } from './database.ts';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import type { HumanActor, HumanAuth } from './auth.ts';
import { constantTimeEqualHex, digestCommand, ProtocolError, sha256 } from '../shared/protocol.ts';
import { schemaVersion, transaction } from './legacy-schema.ts';
import { rustBinary } from '../rust-binary.ts';

export function restoreCommand(args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}) {
  const binary = rustBinary('briefsip-server', process.env.BRIEFSIP_RUST_BINARY);
  const result = spawnSync(binary, ['restore', ...args], { encoding: 'utf8', env: { ...process.env, ...options.env }, input: options.input, timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) throw result.error;
  const value = JSON.parse(result.stdout || 'null');
  if (!value || value.exitCode !== result.status) throw new Error(result.stderr || 'Unexpected Rust restore response');
  return value;
}

export function checkedRestore(args: string[], options?: Parameters<typeof restoreCommand>[1]) {
  const value = restoreCommand(args, options);
  if (value.exitCode !== 0) throw new Error(value.error);
  return value;
}

export function restoreWorkspace(source: string, destination: string, options: { canonicalOnly?: boolean } = {}) {
  const target = resolve(destination);
  checkedRestore([options.canonicalOnly ? '--read-only' : 'workspace', source, '--db', target]);
  return target;
}

// Fixtures generate old-schema archives and can seed proof state on a running test server.
const restoreDenied=()=>new ProtocolError(403,'recovery_session_invalid','Recovery evidence is invalid or expired.');
const restoreSessionDigest=(actor:HumanActor,proof:string)=>digestCommand(['briefsip-restore-session-v1',actor.accountId,actor.issuer,actor.subject,proof]);
function recoveryOwner(db:DatabaseSync,auth:Pick<HumanAuth,'requireCurrent'>,actor:HumanActor){
  auth.requireCurrent(actor);
  const recorded=db.prepare('SELECT owner_account FROM briefsip_backup_authority').all();
  if(recorded.length!==1||recorded[0].owner_account!==actor.accountId)throw restoreDenied();
  if(!db.prepare("SELECT 1 FROM accounts a JOIN projects p ON p.account=a.id JOIN project_members m ON m.project=p.id AND m.account=a.id WHERE a.id=? AND a.issuer=? AND a.clerk_sub=? AND a.blocked=0 AND p.deleted=0 AND m.deleted=0 AND m.role='owner'").get(actor.accountId,actor.issuer,actor.subject))throw restoreDenied();
  const state=db.prepare("SELECT * FROM authority_state WHERE id=1 AND serving_state='read_only_recovery'").get();
  if(!state)throw restoreDenied();return state;
}
export function prepareRestoreBootstrap(db:DatabaseSync){
  return transaction(db,()=>{
    const state=db.prepare("SELECT * FROM authority_state WHERE id=1 AND serving_state='read_only_recovery'").get();
    if(!state)throw restoreDenied();
    const bootstrap=randomBytes(32).toString('base64url'),expiresAt=Date.now()+900000;
    db.prepare('UPDATE authority_state SET recovery_session_hash=?,recovery_expires_at=?,revision=revision+1 WHERE id=1').run(sha256(bootstrap),expiresAt);
    return {bootstrap,recoveryGeneration:String(state.generation),expiresAt};
  });
}
export function issueRestoreSession(db:DatabaseSync,auth:Pick<HumanAuth,'requireCurrent'>,actor:HumanActor,bootstrap:string){
  return transaction(db,()=>{
    const state=recoveryOwner(db,auth,actor);
    if(!/^[A-Za-z0-9_-]{43}$/.test(bootstrap)||!state.recovery_session_hash||Number(state.recovery_expires_at)<=Date.now()||!constantTimeEqualHex(sha256(bootstrap),String(state.recovery_session_hash)))throw restoreDenied();
    const session=randomBytes(32).toString('base64url'),expiresAt=Date.now()+900000;
    db.prepare('UPDATE authority_state SET recovery_session_hash=?,recovery_expires_at=?,revision=revision+1 WHERE id=1').run(restoreSessionDigest(actor,session),expiresAt);
    return {session,recoveryGeneration:String(state.generation),expiresAt};
  });
}
export function requireRestoreSession(db:DatabaseSync,auth:Pick<HumanAuth,'requireCurrent'>,actor:HumanActor,proof:string,generation:string){
  const state=recoveryOwner(db,auth,actor);
  if(!/^[A-Za-z0-9_-]{43}$/.test(proof)||state.generation!==generation||!state.recovery_session_hash||Number(state.recovery_expires_at)<=Date.now()||!constantTimeEqualHex(restoreSessionDigest(actor,proof),String(state.recovery_session_hash)))throw restoreDenied();
  return state;
}

export async function workspaceSnapshot(db: DatabaseSync, ownerAccountId?:string) {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-backup-')), file = join(directory, 'briefsip.sqlite');
  try {
    await backup(db, file);
    chmodSync(file, 0o600);
    const snapshot = testDatabase(file);
    try {
      snapshot.exec(`CREATE TABLE IF NOT EXISTS briefsip_backup (format TEXT NOT NULL,version INTEGER NOT NULL,created TEXT NOT NULL) STRICT;
        DELETE FROM briefsip_backup;`);
      snapshot.prepare('INSERT INTO briefsip_backup VALUES (?,?,?)').run('briefsip-workspace', 1, new Date().toISOString());
      if (schemaVersion(snapshot)) {
        const authority=snapshot.prepare('SELECT generation FROM authority_state WHERE id=1').get();
        if(!authority)throw new Error('Canonical authority is missing');
        snapshot.prepare("UPDATE briefsip_backup SET format='briefsip-canonical-v6',version=6").run();
        snapshot.exec('CREATE TABLE IF NOT EXISTS briefsip_backup_authority(generation TEXT NOT NULL,owner_account TEXT REFERENCES accounts(id)) STRICT;');
        if(!snapshot.prepare('PRAGMA table_info(briefsip_backup_authority)').all().some(row=>row.name==='owner_account'))snapshot.exec('ALTER TABLE briefsip_backup_authority ADD COLUMN owner_account TEXT REFERENCES accounts(id)');
        const previous=snapshot.prepare('SELECT owner_account FROM briefsip_backup_authority').get(),owners=snapshot.prepare('SELECT DISTINCT account FROM projects').all();
        const owner=ownerAccountId??previous?.owner_account??(owners.length===1?owners[0].account:null);
        if(owners.length>0&&(owner===null||!snapshot.prepare('SELECT 1 FROM projects WHERE account=?').get(owner)))throw new Error('Canonical backup requires its recorded owner');
        snapshot.exec('DELETE FROM briefsip_backup_authority');
        snapshot.prepare('INSERT INTO briefsip_backup_authority VALUES (?,?)').run(authority.generation,owner);
      }
    } finally { snapshot.close(); }
    return { file, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}
