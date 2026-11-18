
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
