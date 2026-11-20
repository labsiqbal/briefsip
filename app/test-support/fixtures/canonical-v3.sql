-- Frozen from ec4367a0 app/schema.ts, Node canonical migration v3.
CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,agent TEXT NOT NULL REFERENCES agents(id),name TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,archived INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0) STRICT;
        CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,instructions TEXT NOT NULL,lead TEXT REFERENCES agents(id),revision INTEGER NOT NULL DEFAULT 1,archived INTEGER NOT NULL DEFAULT 0) STRICT;
        CREATE TABLE IF NOT EXISTS channel_members(channel TEXT NOT NULL REFERENCES channels(id),agent TEXT NOT NULL REFERENCES agents(id),PRIMARY KEY(channel,agent)) STRICT;
ALTER TABLE turns ADD COLUMN thread TEXT REFERENCES threads(id);
ALTER TABLE turns ADD COLUMN channel TEXT REFERENCES channels(id);
ALTER TABLE turns ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
ALTER TABLE turns ADD COLUMN recipient TEXT REFERENCES agents(id);
ALTER TABLE turns ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turns ADD COLUMN routing TEXT;
ALTER TABLE turns ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turns ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE turns ADD COLUMN profile_setup INTEGER NOT NULL DEFAULT 0;
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
INSERT INTO schema_migrations VALUES (3,'v3_task_fencing','f933c4c0663fa9680a4b6227e578052b31afa9c8d377bd753e1e8f0ffd0c5b1a',123);
CREATE TABLE IF NOT EXISTS recovery_quarantine(
      request_id TEXT NOT NULL REFERENCES receipts(request_id), owner_account TEXT NOT NULL REFERENCES accounts(id),
      task TEXT NOT NULL, action TEXT NOT NULL, source_device TEXT NOT NULL REFERENCES devices(id), source_authority TEXT NOT NULL,
      recovery_generation TEXT NOT NULL, watermark INTEGER NOT NULL CHECK(watermark>=0), envelope_digest TEXT NOT NULL,
      envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)), reason TEXT NOT NULL, created INTEGER NOT NULL,
      PRIMARY KEY(request_id,action)) STRICT;
      CREATE INDEX IF NOT EXISTS recovery_quarantine_scope ON recovery_quarantine(owner_account,task,created);
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
ALTER TABLE turns ADD COLUMN parent TEXT REFERENCES turns(id);
ALTER TABLE turns ADD COLUMN no_update INTEGER NOT NULL DEFAULT 0 CHECK(no_update IN(0,1));
CREATE TABLE IF NOT EXISTS agent_visibility(agent TEXT PRIMARY KEY REFERENCES agents(id),hidden INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE IF NOT EXISTS agent_visibility_skips(agent TEXT NOT NULL REFERENCES agents(id),routine TEXT NOT NULL,scheduled_at INTEGER NOT NULL,missed INTEGER NOT NULL,PRIMARY KEY(agent,routine,scheduled_at)) STRICT;
    CREATE TABLE IF NOT EXISTS agent_visibility_commands(id TEXT PRIMARY KEY,request TEXT NOT NULL,result TEXT NOT NULL) STRICT;
ALTER TABLE turns ADD COLUMN origin TEXT;
CREATE TABLE IF NOT EXISTS agent_requests(id TEXT PRIMARY KEY,turn TEXT NOT NULL REFERENCES turns(id),call_id TEXT NOT NULL,expects_reply INTEGER NOT NULL,settled INTEGER NOT NULL DEFAULT 0,UNIQUE(turn,call_id)) STRICT;
    CREATE TABLE IF NOT EXISTS agent_deliveries(request TEXT NOT NULL REFERENCES agent_requests(id),turn TEXT PRIMARY KEY REFERENCES turns(id)) STRICT;
    CREATE TABLE IF NOT EXISTS agent_reply_captures(turn TEXT PRIMARY KEY REFERENCES turns(id)) STRICT;
    CREATE TABLE IF NOT EXISTS agent_reply_claims(delivery TEXT PRIMARY KEY REFERENCES turns(id),consumer TEXT NOT NULL REFERENCES turns(id),snapshot TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS agent_reply_claims_consumer ON agent_reply_claims(consumer);
    CREATE INDEX IF NOT EXISTS agent_deliveries_request ON agent_deliveries(request);
    CREATE INDEX IF NOT EXISTS turns_parent ON turns(parent);
    CREATE INDEX IF NOT EXISTS turns_agent_status ON turns(agent,status);
CREATE TABLE IF NOT EXISTS remote_agent_calls(
    id TEXT PRIMARY KEY, machine TEXT NOT NULL, agent TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL,
    depth INTEGER NOT NULL, delivery TEXT UNIQUE REFERENCES turns(id), state TEXT NOT NULL CHECK(state IN ('intent','sending','sent','result','uncertain')),
    remote_turn TEXT, next_poll INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL,
    cancel_requested INTEGER NOT NULL DEFAULT 0, cancel_sent INTEGER NOT NULL DEFAULT 0, error TEXT, status TEXT NOT NULL DEFAULT 'queued', reply TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS remote_agent_calls_latest ON remote_agent_calls(machine,agent,created DESC,id DESC) WHERE delivery IS NULL;
  CREATE TABLE IF NOT EXISTS peer_message_events(id TEXT PRIMARY KEY,peer TEXT NOT NULL,created INTEGER NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS peer_message_cooldowns(peer TEXT PRIMARY KEY,until INTEGER NOT NULL) STRICT;
ALTER TABLE turns ADD COLUMN message_depth INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS delegation_tasks(id TEXT PRIMARY KEY,creator_turn TEXT NOT NULL REFERENCES turns(id),parent_task TEXT REFERENCES delegation_tasks(id),request TEXT NOT NULL REFERENCES agent_requests(id),delivery TEXT NOT NULL REFERENCES turns(id),wait INTEGER NOT NULL DEFAULT 0,wake_delivered INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS delegation_tasks_creator ON delegation_tasks(creator_turn);
    CREATE TABLE IF NOT EXISTS delegation_waits(id TEXT PRIMARY KEY,turn TEXT NOT NULL REFERENCES turns(id),call_id TEXT NOT NULL,call TEXT NOT NULL,task TEXT NOT NULL REFERENCES delegation_tasks(id),deadline INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('waiting','received','expired','closed')),after_output INTEGER NOT NULL,after_action INTEGER NOT NULL,result TEXT,UNIQUE(turn,call_id)) STRICT;
    CREATE TABLE IF NOT EXISTS agent_message_events(id TEXT PRIMARY KEY,agent TEXT NOT NULL REFERENCES agents(id),created INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS agent_message_cooldowns(agent TEXT PRIMARY KEY REFERENCES agents(id),until INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS room_discussions(root TEXT PRIMARY KEY REFERENCES turns(id),members TEXT NOT NULL,lead TEXT,mentioned INTEGER NOT NULL,fallback INTEGER NOT NULL DEFAULT 0,note TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS room_turns(turn TEXT PRIMARY KEY REFERENCES turns(id),root TEXT NOT NULL REFERENCES room_discussions(root),round INTEGER NOT NULL,speaker TEXT,silent TEXT,processed INTEGER NOT NULL DEFAULT 0,fallback INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE IF NOT EXISTS room_stops(id TEXT PRIMARY KEY,request TEXT NOT NULL,result TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS room_dispatches(turn TEXT PRIMARY KEY REFERENCES turns(id),root TEXT NOT NULL REFERENCES room_discussions(root)) STRICT;
    CREATE INDEX IF NOT EXISTS room_turns_root ON room_turns(root);
    CREATE TABLE IF NOT EXISTS room_admissions(turn TEXT PRIMARY KEY REFERENCES turns(id),watermark INTEGER NOT NULL,cutoff INTEGER NOT NULL,context TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS room_watermarks(root TEXT NOT NULL REFERENCES room_discussions(root),agent TEXT NOT NULL,through INTEGER NOT NULL,PRIMARY KEY(root,agent)) STRICT;
    CREATE TABLE IF NOT EXISTS room_invitations(source TEXT NOT NULL REFERENCES turns(id),target TEXT NOT NULL,root TEXT NOT NULL REFERENCES room_discussions(root),seq INTEGER NOT NULL,round INTEGER NOT NULL,resolved TEXT REFERENCES turns(id),PRIMARY KEY(source,target)) STRICT;
    CREATE TABLE IF NOT EXISTS room_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,root TEXT NOT NULL REFERENCES room_discussions(root),turn TEXT NOT NULL REFERENCES turns(id),kind TEXT NOT NULL,agent TEXT NOT NULL,target TEXT,text TEXT NOT NULL,UNIQUE(turn,kind,target)) STRICT;
ALTER TABLE room_discussions ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0;
