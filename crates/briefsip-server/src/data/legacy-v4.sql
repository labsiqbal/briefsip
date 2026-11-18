
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
