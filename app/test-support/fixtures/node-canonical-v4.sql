-- Frozen from ec4367a0 app/schema.ts, Node canonical migration v4.
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
  AND briefsip_capability_digest(NEW.capability_snapshot_json)=briefsip_capability_digest(participation.capabilities_json)
  AND NEW.capability_digest=briefsip_capability_digest(participation.capabilities_json)
  AND NEW.assignment_revision=CASE WHEN member.role='owner' THEN member.grant_revision ELSE assignment.revision END
  AND (member.role='owner' OR assignment.enabled=1)
  AND NEW.provider_binding_id IS home.provider_binding
  AND (home.provider_binding IS NULL OR (binding.device=NEW.home_device AND binding.owner_account=project.account AND binding.revision=NEW.provider_binding_revision AND binding.owner_account=NEW.provider_binding_owner AND binding.readiness='ready'))
  AND (previous.provider_binding_owner IS NULL OR previous.provider_binding_owner=NEW.provider_binding_owner)
) BEGIN SELECT RAISE(ABORT,'invalid task successor provenance'); END;
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
INSERT INTO schema_migrations VALUES (4,'v4_sync_retention','9c7b5684504ef6d121413585b4b78322e9149188af0ebb1d7e7e4a354cae0a7e',123);
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
CREATE TABLE IF NOT EXISTS agent_visibility(agent TEXT PRIMARY KEY REFERENCES agents(id),hidden INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE IF NOT EXISTS agent_visibility_skips(agent TEXT NOT NULL REFERENCES agents(id),routine TEXT NOT NULL,scheduled_at INTEGER NOT NULL,missed INTEGER NOT NULL,PRIMARY KEY(agent,routine,scheduled_at)) STRICT;
    CREATE TABLE IF NOT EXISTS agent_visibility_commands(id TEXT PRIMARY KEY,request TEXT NOT NULL,result TEXT NOT NULL) STRICT;
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
