import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { sha256, digestCommand } from '../shared/protocol.ts';
import { initializeAgentMessages } from './agent-messages.ts';
import { markMinarbotData } from './database.ts';

export const SCHEMA_VERSION = 4;
export const migration = `
CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL, instructions TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1) STRICT;
CREATE TABLE IF NOT EXISTS turns(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, agent TEXT NOT NULL REFERENCES agents(id), text TEXT NOT NULL, reply TEXT, status TEXT NOT NULL CHECK(status IN('queued','running','done','failed','interrupted','cancelled')), error TEXT, created TEXT NOT NULL) STRICT;
CREATE TABLE accounts(id TEXT PRIMARY KEY, issuer TEXT NOT NULL, clerk_sub TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN(0,1)), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), created INTEGER NOT NULL, UNIQUE(issuer,clerk_sub)) STRICT;
CREATE TABLE projects(id TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL, private INTEGER NOT NULL CHECK(private IN(0,1)), deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN(0,1)), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0)) STRICT;
CREATE TABLE project_members(project TEXT NOT NULL REFERENCES projects(id), account TEXT NOT NULL REFERENCES accounts(id), role TEXT NOT NULL CHECK(role IN('owner','member')), grant_revision INTEGER NOT NULL CHECK(grant_revision>0), deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN(0,1)), PRIMARY KEY(project,account)) STRICT;
CREATE TABLE agent_projects(project TEXT NOT NULL REFERENCES projects(id), agent TEXT NOT NULL REFERENCES agents(id), rules TEXT NOT NULL, capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)), revision INTEGER NOT NULL CHECK(revision>0), deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN(0,1)), PRIMARY KEY(project,agent)) STRICT;
CREATE TABLE collaborator_agents(project TEXT NOT NULL, account TEXT NOT NULL, agent TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN(0,1)), revision INTEGER NOT NULL CHECK(revision>0), PRIMARY KEY(project,account,agent), FOREIGN KEY(project,account) REFERENCES project_members(project,account), FOREIGN KEY(project,agent) REFERENCES agent_projects(project,agent)) STRICT;
CREATE TABLE response_policies(project TEXT NOT NULL, account TEXT NOT NULL, agent TEXT NOT NULL, respond INTEGER NOT NULL CHECK(respond IN(0,1)), revision INTEGER NOT NULL CHECK(revision>0), PRIMARY KEY(project,account,agent), FOREIGN KEY(project,account,agent) REFERENCES collaborator_agents(project,account,agent)) STRICT;
CREATE TABLE invitations(id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), authority_generation TEXT NOT NULL, email_hash TEXT NOT NULL, target_clerk_sub TEXT, state TEXT NOT NULL CHECK(state IN('pending_delivery','sent','delivery_unknown','accepted','revoked','expired','failed')), token_digest TEXT NOT NULL UNIQUE, assignments_json TEXT NOT NULL CHECK(json_valid(assignments_json)), expires_at INTEGER NOT NULL, used_at INTEGER, revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE UNIQUE INDEX invitations_pending ON invitations(project,email_hash) WHERE state IN('pending_delivery','sent');
CREATE TABLE mail_outbox(id TEXT PRIMARY KEY REFERENCES invitations(id), revision INTEGER NOT NULL, ciphertext BLOB NOT NULL, state TEXT NOT NULL CHECK(state IN('queued','sending','sent','unknown','failed','revoked')), first_attempt INTEGER, next_attempt INTEGER, attempts INTEGER NOT NULL CHECK(attempts>=0), remote_id TEXT, payload_digest TEXT NOT NULL) STRICT;
CREATE TABLE receipts(request_id TEXT PRIMARY KEY, actor TEXT NOT NULL, project TEXT REFERENCES projects(id), scope TEXT NOT NULL, payload_digest TEXT NOT NULL, status INTEGER NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)), created INTEGER NOT NULL) STRICT;
CREATE TABLE session_denials(issuer TEXT NOT NULL, sid TEXT NOT NULL, account TEXT NOT NULL REFERENCES accounts(id), expires_at INTEGER NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(issuer,sid)) STRICT;
CREATE TABLE record_scopes(table_name TEXT NOT NULL, key_json TEXT NOT NULL CHECK(json_valid(key_json)), account TEXT NOT NULL REFERENCES accounts(id), project TEXT NOT NULL REFERENCES projects(id), visibility TEXT NOT NULL CHECK(visibility IN('owner','project')), root_kind TEXT NOT NULL, root_id TEXT NOT NULL, PRIMARY KEY(table_name,key_json)) STRICT;
CREATE INDEX record_scope_lookup ON record_scopes(project,root_kind,root_id);
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT;
CREATE TABLE authority_state(id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL, serving_state TEXT NOT NULL CHECK(serving_state IN('offline','read_only_recovery','active')), cutover_version INTEGER NOT NULL, recovery_session_hash TEXT, recovery_expires_at INTEGER, revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
`;
export const migrationV2 = `
CREATE TABLE installations(id TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), signing_public_key TEXT NOT NULL, signing_thumbprint TEXT NOT NULL UNIQUE, proof_revision INTEGER NOT NULL DEFAULT 1 CHECK(proof_revision>0), revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN(0,1)), revision INTEGER NOT NULL CHECK(revision>0), created INTEGER NOT NULL) STRICT;
CREATE TABLE devices(id TEXT PRIMARY KEY, installation TEXT NOT NULL REFERENCES installations(id), account TEXT NOT NULL REFERENCES accounts(id), signing_public_key TEXT NOT NULL, encryption_public_key TEXT NOT NULL, signing_thumbprint TEXT NOT NULL, encryption_thumbprint TEXT NOT NULL, descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)), generation INTEGER NOT NULL CHECK(generation>0), connection_generation INTEGER NOT NULL CHECK(connection_generation>=0), status TEXT NOT NULL CHECK(status IN('offline','connecting','ready','blocked','revoked')), zone TEXT NOT NULL, zone_revision INTEGER NOT NULL CHECK(zone_revision>0), last_seen INTEGER, capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)), revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE TABLE provider_bindings(id TEXT PRIMARY KEY, device TEXT NOT NULL REFERENCES devices(id), owner_account TEXT NOT NULL REFERENCES accounts(id), provider_id TEXT NOT NULL CHECK(provider_id IN('openai-compatible','anthropic','gemini')), provider_account_id TEXT NOT NULL, label TEXT NOT NULL, readiness TEXT NOT NULL CHECK(readiness IN('missing','ready','unreadable','unavailable','revoked')), revision INTEGER NOT NULL CHECK(revision>0), UNIQUE(device,provider_id,provider_account_id)) STRICT;
CREATE TABLE agent_authority(agent TEXT PRIMARY KEY REFERENCES agents(id), owner_account TEXT NOT NULL REFERENCES accounts(id), home_device TEXT NOT NULL REFERENCES devices(id), provider_binding TEXT REFERENCES provider_bindings(id), revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE TRIGGER agent_home_immutable BEFORE UPDATE OF agent,owner_account,home_device ON agent_authority WHEN NEW.agent<>OLD.agent OR NEW.owner_account<>OLD.owner_account OR NEW.home_device<>OLD.home_device BEGIN SELECT RAISE(ABORT,'agent_home_immutable'); END;
CREATE TABLE link_challenges(id TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), sid TEXT NOT NULL, installation TEXT NOT NULL, device TEXT NOT NULL, installation_thumbprint TEXT NOT NULL, signing_thumbprint TEXT NOT NULL, encryption_thumbprint TEXT NOT NULL, candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)), nonce_digest TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL CHECK(consumed IN(0,1))) STRICT;
CREATE TABLE device_sessions(id_hash TEXT PRIMARY KEY, device TEXT NOT NULL REFERENCES devices(id), generation INTEGER NOT NULL, authority_generation TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN(0,1))) STRICT;
CREATE TABLE proof_replays(device TEXT NOT NULL REFERENCES devices(id), nonce_digest TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(device,nonce_digest)) STRICT;
CREATE INDEX link_challenges_expiry ON link_challenges(expires_at);
CREATE INDEX proof_replays_expiry ON proof_replays(expires_at);
CREATE TABLE IF NOT EXISTS agent_creations(id TEXT PRIMARY KEY REFERENCES agents(id), request TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS agent_avatars(agent TEXT PRIMARY KEY REFERENCES agents(id),revision INTEGER NOT NULL,image BLOB) STRICT;
`;
export const migrationV3 = `
CREATE TABLE tasks(id TEXT PRIMARY KEY, logical_turn TEXT NOT NULL REFERENCES turns(id), predecessor_task TEXT UNIQUE REFERENCES tasks(id), project TEXT NOT NULL, agent TEXT NOT NULL, initiator_account TEXT NOT NULL REFERENCES accounts(id), home_device TEXT NOT NULL REFERENCES devices(id), assignment_revision INTEGER NOT NULL CHECK(assignment_revision>0), capability_revision INTEGER NOT NULL CHECK(capability_revision>0), capability_digest TEXT NOT NULL CHECK(length(capability_digest)=64), capability_snapshot_json TEXT NOT NULL CHECK(json_valid(capability_snapshot_json)), provider_binding_id TEXT REFERENCES provider_bindings(id), provider_binding_revision INTEGER, provider_binding_owner TEXT REFERENCES accounts(id), state TEXT NOT NULL CHECK(state IN('queued','waiting_device','waiting_resource','running','paused','approval','uncertain','completed','failed','cancelled','transferred')), payload_digest TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), revision INTEGER NOT NULL CHECK(revision>0), created INTEGER NOT NULL, CHECK((provider_binding_id IS NULL AND provider_binding_revision IS NULL AND provider_binding_owner IS NULL) OR (provider_binding_id IS NOT NULL AND provider_binding_revision IS NOT NULL AND provider_binding_revision>0 AND provider_binding_owner IS NOT NULL)), FOREIGN KEY(project,agent) REFERENCES agent_projects(project,agent), CHECK(predecessor_task IS NULL OR predecessor_task<>id), UNIQUE(id,logical_turn,project), FOREIGN KEY(predecessor_task,logical_turn,project) REFERENCES tasks(id,logical_turn,project)) STRICT;
CREATE TABLE task_context_snapshots(task TEXT NOT NULL REFERENCES tasks(id), context_revision INTEGER NOT NULL CHECK(context_revision>0), snapshot_id TEXT NOT NULL UNIQUE, authority_generation TEXT NOT NULL, project_revision INTEGER NOT NULL, agent_revision INTEGER NOT NULL, assignment_revision INTEGER NOT NULL, capability_revision INTEGER NOT NULL, context_digest TEXT NOT NULL CHECK(length(context_digest)=64), snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB))<=8388608), receipt_id TEXT NOT NULL REFERENCES receipts(request_id), created INTEGER NOT NULL, PRIMARY KEY(task,context_revision)) STRICT;
CREATE UNIQUE INDEX tasks_root_turn ON tasks(logical_turn) WHERE predecessor_task IS NULL;
CREATE INDEX tasks_turn ON tasks(logical_turn,created,id);
CREATE INDEX tasks_queue ON tasks(home_device,project,state,created);
CREATE TABLE execution_owners(task TEXT PRIMARY KEY REFERENCES tasks(id), device TEXT NOT NULL REFERENCES devices(id), authority_generation TEXT NOT NULL, device_generation INTEGER NOT NULL, executor_generation INTEGER NOT NULL CHECK(executor_generation>0), token_hash TEXT NOT NULL, lock_proof_json TEXT NOT NULL CHECK(json_valid(lock_proof_json)), reconciled_through INTEGER NOT NULL CHECK(reconciled_through>=0), last_seen INTEGER NOT NULL, stopped INTEGER NOT NULL CHECK(stopped IN(0,1))) STRICT;
CREATE TABLE task_actions(id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), sequence INTEGER NOT NULL CHECK(sequence>=0), action_kind TEXT NOT NULL CHECK(action_kind IN('provider','canonical','resource','read','compute','local','browser')), authority_generation TEXT NOT NULL, device_generation INTEGER NOT NULL, executor_generation INTEGER NOT NULL, intent_digest TEXT NOT NULL, context_snapshot_id TEXT NOT NULL REFERENCES task_context_snapshots(snapshot_id), context_digest TEXT NOT NULL CHECK(length(context_digest)=64), binding_id TEXT REFERENCES provider_bindings(id), binding_revision INTEGER, grant_revision INTEGER NOT NULL, resource_intent_json TEXT CHECK(resource_intent_json IS NULL OR json_valid(resource_intent_json)), mcp_intent_json TEXT CHECK(mcp_intent_json IS NULL OR (json_valid(mcp_intent_json) AND action_kind='local')), state TEXT NOT NULL CHECK(state IN('prepared','committed','in_flight','reported','acknowledged','not_sent','uncertain')), committed_at INTEGER, result_digest TEXT, effect_status TEXT CHECK(effect_status IN('none','known','unknown')), uncertain_reason TEXT, CHECK((action_kind='provider' AND binding_id IS NOT NULL AND binding_revision IS NOT NULL AND binding_revision>0) OR (action_kind<>'provider' AND binding_id IS NULL AND binding_revision IS NULL)), UNIQUE(task,sequence), UNIQUE(id,task)) STRICT;
CREATE TABLE task_action_resolutions(action TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), request_id TEXT NOT NULL UNIQUE REFERENCES receipts(request_id), actor TEXT NOT NULL REFERENCES accounts(id), resolution TEXT NOT NULL CHECK(resolution IN('known_result','not_sent','retry_with_risk')), evidence_request_id TEXT REFERENCES receipts(request_id), replacement_action_id TEXT UNIQUE, created INTEGER NOT NULL, FOREIGN KEY(action,task) REFERENCES task_actions(id,task), CHECK((resolution='known_result' AND evidence_request_id IS NOT NULL AND replacement_action_id IS NULL) OR (resolution='not_sent' AND evidence_request_id IS NOT NULL AND replacement_action_id IS NOT NULL) OR (resolution='retry_with_risk' AND evidence_request_id IS NULL AND replacement_action_id IS NOT NULL)), CHECK(replacement_action_id IS NULL OR replacement_action_id<>action)) STRICT;
CREATE TRIGGER task_resolution_immutable_update BEFORE UPDATE ON task_action_resolutions BEGIN SELECT RAISE(ABORT,'immutable task resolution'); END;
CREATE TRIGGER task_resolution_immutable_delete BEFORE DELETE ON task_action_resolutions BEGIN SELECT RAISE(ABORT,'immutable task resolution'); END;
CREATE TABLE task_results(action TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'), size INTEGER NOT NULL CHECK(size>=0 AND size<=8388608), encoding TEXT NOT NULL CHECK(encoding='canonical-json-v1'), content_json TEXT NOT NULL CHECK(json_valid(content_json)), created INTEGER NOT NULL, FOREIGN KEY(action,task) REFERENCES task_actions(id,task), CHECK(length(CAST(content_json AS BLOB))=size)) STRICT;
CREATE TABLE task_reports(action TEXT PRIMARY KEY REFERENCES task_actions(id), report_digest TEXT NOT NULL, device TEXT NOT NULL REFERENCES devices(id), journal_sequence INTEGER NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), result_ref TEXT REFERENCES task_results(action), receipt_id TEXT NOT NULL REFERENCES receipts(request_id), CHECK(result_ref IS NULL OR result_ref=action)) STRICT;
CREATE TRIGGER task_results_immutable_update BEFORE UPDATE ON task_results BEGIN SELECT RAISE(ABORT,'immutable task result'); END;
CREATE TRIGGER task_results_immutable_delete BEFORE DELETE ON task_results BEGIN SELECT RAISE(ABORT,'immutable task result'); END;
CREATE TRIGGER task_context_immutable_update BEFORE UPDATE ON task_context_snapshots BEGIN SELECT RAISE(ABORT,'immutable task context'); END;
CREATE TRIGGER task_context_immutable_delete BEFORE DELETE ON task_context_snapshots BEGIN SELECT RAISE(ABORT,'immutable task context'); END;
CREATE TRIGGER task_admission_immutable BEFORE UPDATE OF logical_turn,predecessor_task,project,agent,initiator_account,home_device,assignment_revision,capability_revision,capability_digest,capability_snapshot_json,provider_binding_id,provider_binding_revision,provider_binding_owner,payload_digest,payload_json,created ON tasks BEGIN SELECT RAISE(ABORT,'immutable task admission'); END;
CREATE TABLE recovery_evidence_sessions(id_hash TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES receipts(request_id), recovery_generation TEXT NOT NULL UNIQUE, authority_generation TEXT NOT NULL, owner_account TEXT NOT NULL REFERENCES accounts(id), task TEXT NOT NULL REFERENCES tasks(id), source_device TEXT NOT NULL REFERENCES devices(id), source_generation INTEGER NOT NULL CHECK(source_generation>0), expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN(0,1))) STRICT;
CREATE INDEX recovery_evidence_expiry ON recovery_evidence_sessions(expires_at);
CREATE TABLE recovery_imports(request_id TEXT PRIMARY KEY REFERENCES receipts(request_id), source_device TEXT NOT NULL REFERENCES devices(id), source_authority TEXT NOT NULL, watermark INTEGER NOT NULL CHECK(watermark>=0), recovery_generation TEXT NOT NULL, envelope_digest TEXT NOT NULL, envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)), UNIQUE(recovery_generation,source_device,source_authority,watermark)) STRICT;
`;
export const migrationV4 = `
CREATE TABLE sync_events(
  position INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL REFERENCES accounts(id),
  project TEXT NOT NULL REFERENCES projects(id),
  authorization_generation TEXT NOT NULL,
  previous_position INTEGER NOT NULL CHECK(previous_position>=0),
  record_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  operation TEXT NOT NULL CHECK(operation IN('upsert','delete','revoke')),
  body_json TEXT CHECK(body_json IS NULL OR json_valid(body_json)),
  committed_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sync_events_project_position ON sync_events(project,position);
CREATE INDEX sync_events_account_project ON sync_events(account,project,position);
CREATE TABLE sync_heads(account TEXT NOT NULL REFERENCES accounts(id),project TEXT NOT NULL REFERENCES projects(id),event_position INTEGER NOT NULL CHECK(event_position>=0),PRIMARY KEY(account,project)) STRICT;
CREATE TABLE retention_floors(
  account TEXT NOT NULL REFERENCES accounts(id),
  project TEXT NOT NULL REFERENCES projects(id),
  event_position INTEGER NOT NULL CHECK(event_position>=0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account,project)
) STRICT;
`;
const protectedWaitSchema = `
CREATE TABLE IF NOT EXISTS wait_provisions(
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  agent TEXT NOT NULL,
  source_device TEXT NOT NULL REFERENCES devices(id),
  source_generation INTEGER NOT NULL CHECK(source_generation>0),
  authority_generation TEXT NOT NULL,
  target_key TEXT NOT NULL,
  secret_generation INTEGER NOT NULL CHECK(secret_generation>0),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB))<=65536),
  deadline INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN('pending','activated','closed','failed')),
  result_request_id TEXT UNIQUE REFERENCES receipts(request_id),
  UNIQUE(target_key,secret_generation),
  FOREIGN KEY(project,agent) REFERENCES agent_projects(project,agent)
) STRICT;
CREATE INDEX IF NOT EXISTS wait_provisions_pending ON wait_provisions(state,deadline,id);
CREATE TABLE IF NOT EXISTS turn_waits(
  id TEXT PRIMARY KEY,turn TEXT NOT NULL REFERENCES turns(id),call_id TEXT NOT NULL,call TEXT NOT NULL,event TEXT NOT NULL,
  secret_ref TEXT NOT NULL,secret_generation INTEGER NOT NULL CHECK(secret_generation>0),source_device_id TEXT NOT NULL REFERENCES devices(id),
  deadline INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN('waiting','received','expired','closed')),
  delivery TEXT,digest TEXT,result TEXT,after_output INTEGER NOT NULL,after_action INTEGER NOT NULL,UNIQUE(turn,call_id)
) STRICT;
CREATE INDEX IF NOT EXISTS turn_waits_pending ON turn_waits(turn,status);
CREATE TABLE IF NOT EXISTS flow_tool_calls(seq INTEGER PRIMARY KEY AUTOINCREMENT,turn TEXT NOT NULL REFERENCES turns(id),call_id TEXT NOT NULL,call TEXT NOT NULL,result TEXT NOT NULL,after_output INTEGER NOT NULL,after_action INTEGER,UNIQUE(turn,call_id)) STRICT;
`;


const taskSuccessorConstraint = `
CREATE TRIGGER IF NOT EXISTS task_successor_provenance BEFORE INSERT ON tasks WHEN NEW.predecessor_task IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM tasks previous JOIN projects project ON project.id=previous.project
  JOIN agent_authority home ON home.agent=NEW.agent AND home.owner_account=project.account
  JOIN agent_projects participation ON participation.project=project.id AND participation.agent=NEW.agent
  JOIN project_members member ON member.project=project.id AND member.account=NEW.initiator_account
  LEFT JOIN collaborator_agents assignment ON assignment.project=project.id AND assignment.account=member.account AND assignment.agent=NEW.agent
  LEFT JOIN provider_bindings binding ON binding.id=home.provider_binding
  WHERE previous.id=NEW.predecessor_task AND previous.state='transferred'
  AND previous.logical_turn=NEW.logical_turn AND previous.project=NEW.project AND previous.initiator_account=NEW.initiator_account
  AND home.home_device=NEW.home_device AND participation.deleted=0 AND member.deleted=0
  AND NEW.capability_revision=participation.revision
  AND minarbot_capability_digest(NEW.capability_snapshot_json)=minarbot_capability_digest(participation.capabilities_json)
  AND NEW.capability_digest=minarbot_capability_digest(participation.capabilities_json)
  AND NEW.assignment_revision=CASE WHEN member.role='owner' THEN member.grant_revision ELSE assignment.revision END
  AND (member.role='owner' OR assignment.enabled=1)
  AND NEW.provider_binding_id IS home.provider_binding
  AND (home.provider_binding IS NULL OR (binding.device=NEW.home_device AND binding.owner_account=project.account AND binding.revision=NEW.provider_binding_revision AND binding.owner_account=NEW.provider_binding_owner AND binding.readiness='ready'))
  AND (previous.provider_binding_owner IS NULL OR previous.provider_binding_owner=NEW.provider_binding_owner)
) BEGIN SELECT RAISE(ABORT,'invalid task successor provenance'); END;
`;

const syncScopeSchema = `
CREATE TABLE IF NOT EXISTS sync_scope_revisions(project TEXT PRIMARY KEY REFERENCES projects(id),revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE TRIGGER IF NOT EXISTS sync_scope_update AFTER UPDATE ON record_scopes
WHEN NEW.project<>OLD.project OR NEW.account<>OLD.account OR NEW.visibility<>OLD.visibility OR NEW.root_kind<>OLD.root_kind OR NEW.root_id<>OLD.root_id OR NEW.table_name<>OLD.table_name OR NEW.key_json<>OLD.key_json
BEGIN
  INSERT INTO sync_scope_revisions VALUES (OLD.project,1) ON CONFLICT(project) DO UPDATE SET revision=revision+1;
  INSERT INTO sync_scope_revisions SELECT NEW.project,1 WHERE NEW.project<>OLD.project ON CONFLICT(project) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS sync_scope_delete AFTER DELETE ON record_scopes BEGIN
  INSERT INTO sync_scope_revisions VALUES (OLD.project,1) ON CONFLICT(project) DO UPDATE SET revision=revision+1;
END;
`;

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const value = work(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function schemaVersion(db: DatabaseSync): number {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_migrations'").get()) return 0;
  return Number(db.prepare('SELECT coalesce(max(version),0) AS version FROM schema_migrations').get()!.version);
}

export function initializeCanonicalSchema(db: DatabaseSync, now = Date.now(), through: 1 | 2 | 3 | 4 = SCHEMA_VERSION): void {
  if (db.isTransaction) throw new Error('Schema initialization requires an idle connection');
  db.function('minarbot_capability_digest', { deterministic: true }, value => digestCommand(['minarbot-capabilities-v1', JSON.parse(String(value))]));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
  markMinarbotData(db);
  transaction(db, () => {
    let version = schemaVersion(db);
    if (version > SCHEMA_VERSION) throw new Error('Database schema is newer than this server');
    if (version > through) throw new Error('Schema downgrade is not supported');
    const checksum = sha256(migration);
    if (version === 0) {
      db.exec(migration);
      const agentColumns = db.prepare('PRAGMA table_info(agents)').all().map(row => row.name);
      if (!agentColumns.includes('revision')) db.exec('ALTER TABLE agents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
      db.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?)').run(1, 'v1_owner_project', checksum, now);
      db.prepare("INSERT INTO authority_state VALUES (1,?,'active',0,NULL,NULL,1)").run(randomUUID());
      version = 1;
    } else {
      const saved = db.prepare('SELECT name,checksum FROM schema_migrations WHERE version=1').get();
      if (!saved || saved.name !== 'v1_owner_project' || saved.checksum !== checksum) throw new Error('Schema migration checksum mismatch');
    }
    if (!db.prepare('PRAGMA table_info(agents)').all().some(row => row.name === 'role')) db.exec("ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT ''");
    if (!db.prepare('PRAGMA table_info(agents)').all().some(row => row.name === 'tool_budget')) db.exec('ALTER TABLE agents ADD COLUMN tool_budget INTEGER NOT NULL DEFAULT 90');
    if (through === 1) return;
    if (version === 1) {
      db.exec(migrationV2);
      const columns = db.prepare('PRAGMA table_info(agents)').all().map(row => row.name);
      if (!columns.includes('thread_limit')) db.exec('ALTER TABLE agents ADD COLUMN thread_limit INTEGER NOT NULL DEFAULT 2');
      if (!columns.includes('backup_model')) db.exec("ALTER TABLE agents ADD COLUMN backup_model TEXT NOT NULL DEFAULT ''");
      if (!columns.includes('provider_account')) db.exec("ALTER TABLE agents ADD COLUMN provider_account TEXT NOT NULL DEFAULT ''");
      db.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?)').run(2, 'v2_device_authority', sha256(migrationV2), now);
      version = 2;
    }
    const current = db.prepare('SELECT name,checksum FROM schema_migrations WHERE version=2').get();
    if (!current || current.name !== 'v2_device_authority' || current.checksum !== sha256(migrationV2)) throw new Error('Schema migration checksum mismatch');
    if (through === 2) return;
    if (version === 2) {
      db.exec(`CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,agent TEXT NOT NULL REFERENCES agents(id),name TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,archived INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0) STRICT;
        CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,instructions TEXT NOT NULL,lead TEXT REFERENCES agents(id),revision INTEGER NOT NULL DEFAULT 1,archived INTEGER NOT NULL DEFAULT 0) STRICT;
        CREATE TABLE IF NOT EXISTS channel_members(channel TEXT NOT NULL REFERENCES channels(id),agent TEXT NOT NULL REFERENCES agents(id),PRIMARY KEY(channel,agent)) STRICT;`);
      const columns = db.prepare('PRAGMA table_info(turns)').all().map(row => row.name);
      for (const [column, definition] of [
        ['thread', 'TEXT REFERENCES threads(id)'], ['channel', 'TEXT REFERENCES channels(id)'], ['attachments', "TEXT NOT NULL DEFAULT '[]'"], ['recipient', 'TEXT REFERENCES agents(id)'], ['automatic', 'INTEGER NOT NULL DEFAULT 0'], ['routing', 'TEXT'], ['paused', 'INTEGER NOT NULL DEFAULT 0'], ['revision', 'INTEGER NOT NULL DEFAULT 1'], ['profile_setup', 'INTEGER NOT NULL DEFAULT 0'],
      ]) if (!columns.includes(column)) db.exec(`ALTER TABLE turns ADD COLUMN ${column} ${definition}`);
      db.exec(migrationV3);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?)').run(3, 'v3_task_fencing', sha256(migrationV3), now);
      version = 3;
    }
    const recovery = db.prepare('SELECT name,checksum FROM schema_migrations WHERE version=3').get();
    if (!recovery || recovery.name !== 'v3_task_fencing' || recovery.checksum !== sha256(migrationV3)) throw new Error('Schema migration checksum mismatch');
    db.exec(`CREATE TABLE IF NOT EXISTS recovery_quarantine(
      request_id TEXT NOT NULL REFERENCES receipts(request_id), owner_account TEXT NOT NULL REFERENCES accounts(id),
      task TEXT NOT NULL, action TEXT NOT NULL, source_device TEXT NOT NULL REFERENCES devices(id), source_authority TEXT NOT NULL,
      recovery_generation TEXT NOT NULL, watermark INTEGER NOT NULL CHECK(watermark>=0), envelope_digest TEXT NOT NULL,
      envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)), reason TEXT NOT NULL, created INTEGER NOT NULL,
      PRIMARY KEY(request_id,action)) STRICT;
      CREATE INDEX IF NOT EXISTS recovery_quarantine_scope ON recovery_quarantine(owner_account,task,created);`);
    db.exec(taskSuccessorConstraint);
    if (!db.prepare('PRAGMA table_info(turns)').all().some(row => row.name === 'parent')) db.exec('ALTER TABLE turns ADD COLUMN parent TEXT REFERENCES turns(id)');
    if (!db.prepare('PRAGMA table_info(turns)').all().some(row => row.name === 'no_update')) db.exec('ALTER TABLE turns ADD COLUMN no_update INTEGER NOT NULL DEFAULT 0 CHECK(no_update IN(0,1))');
    if (through === 3) { initializeAgentMessages(db); return; }
    if (version === 3) {
      db.exec(migrationV4);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?)').run(4, 'v4_sync_retention', sha256(migrationV4), now);
      version = 4;
    }
    const sync = db.prepare('SELECT name,checksum FROM schema_migrations WHERE version=4').get();
    if (!sync || sync.name !== 'v4_sync_retention' || sync.checksum !== sha256(migrationV4)) throw new Error('Schema migration checksum mismatch');
    db.exec(protectedWaitSchema);
    db.exec(syncScopeSchema);
    initializeAgentMessages(db);
  });
}
