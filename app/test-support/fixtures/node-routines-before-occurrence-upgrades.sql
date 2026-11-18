-- Historical Node DDL frozen from the compatibility paths at cd2c23fe.
CREATE TABLE routines(id TEXT PRIMARY KEY,agent TEXT NOT NULL REFERENCES agents(id),
    name TEXT NOT NULL,prompt TEXT NOT NULL,next_at INTEGER NOT NULL,interval_ms INTEGER,enabled INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1) STRICT;
    CREATE TABLE routine_flows(routine TEXT PRIMARY KEY REFERENCES routines(id),graph TEXT NOT NULL CHECK(json_valid(graph)),revision INTEGER NOT NULL) STRICT;
CREATE TABLE routine_schedule_bindings(
    routine TEXT PRIMARY KEY REFERENCES routines(id),project TEXT NOT NULL REFERENCES projects(id),
    initiator_account TEXT NOT NULL REFERENCES accounts(id),assignment_revision INTEGER NOT NULL CHECK(assignment_revision>0),
    authority_generation TEXT NOT NULL,home_device TEXT NOT NULL REFERENCES devices(id),zone TEXT NOT NULL,zone_revision INTEGER NOT NULL CHECK(zone_revision>0)
  ) STRICT;
CREATE TABLE routine_occurrences (seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,routine TEXT NOT NULL REFERENCES routines(id),
  project TEXT NOT NULL REFERENCES projects(id),due_at INTEGER NOT NULL,schedule_revision INTEGER NOT NULL,
  initiator_account TEXT NOT NULL REFERENCES accounts(id),assignment_revision INTEGER NOT NULL CHECK(assignment_revision>0),
  authority_generation TEXT NOT NULL,home_device TEXT NOT NULL REFERENCES devices(id),zone TEXT NOT NULL,zone_revision INTEGER NOT NULL,
  missed_count INTEGER NOT NULL CHECK(missed_count>=0),state TEXT NOT NULL CHECK(state IN('pending','admitted','done','failed','blocked')),
  graph_json TEXT CHECK(graph_json IS NULL OR json_valid(graph_json)),task TEXT UNIQUE REFERENCES tasks(id)) STRICT;
CREATE TABLE routine_steps (occurrence TEXT NOT NULL REFERENCES routine_occurrences(id),agent TEXT NOT NULL REFERENCES agents(id),
  turn TEXT UNIQUE REFERENCES turns(id),state TEXT NOT NULL CHECK(state IN('waiting','queued','done','failed','skipped')),
  result TEXT NOT NULL,PRIMARY KEY(occurrence,agent)) STRICT;
CREATE UNIQUE INDEX legacy_routine_time ON routine_occurrences(routine,schedule_revision,due_at);
