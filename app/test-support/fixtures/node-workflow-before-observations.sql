-- Historical Node DDL frozen from the compatibility paths at cd2c23fe.
CREATE TABLE schedules(
    id TEXT PRIMARY KEY,project TEXT NOT NULL,agent TEXT NOT NULL,home_device TEXT NOT NULL REFERENCES devices(id),
    initiator_account TEXT NOT NULL REFERENCES accounts(id),assignment_revision INTEGER NOT NULL CHECK(assignment_revision>0),
    authority_generation TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('instant','once','interval','cron','legacy_interval')),
    zone TEXT NOT NULL,zone_revision INTEGER NOT NULL CHECK(zone_revision>0),spec_json TEXT NOT NULL CHECK(json_valid(spec_json)),
    next_at INTEGER,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),revision INTEGER NOT NULL CHECK(revision>0),
    FOREIGN KEY(project,agent) REFERENCES agent_projects(project,agent)
  ) STRICT;
  CREATE INDEX schedules_due ON schedules(enabled,next_at,id);
  CREATE INDEX schedules_enabled_id ON schedules(enabled,id);
  CREATE TABLE scheduler_cursors(id INTEGER PRIMARY KEY CHECK(id=1),after_id TEXT NOT NULL) STRICT;
  INSERT INTO scheduler_cursors VALUES (1,'') ON CONFLICT(id) DO NOTHING;
  CREATE TABLE workflow_schedule_targets(
    schedule TEXT PRIMARY KEY REFERENCES schedules(id),workflow TEXT NOT NULL UNIQUE REFERENCES workflows(id),input TEXT NOT NULL
  ) STRICT;
  CREATE TABLE occurrences(
    schedule TEXT NOT NULL REFERENCES schedules(id),occurrence_id TEXT NOT NULL,due_at INTEGER NOT NULL,
    schedule_revision INTEGER NOT NULL,zone_revision INTEGER NOT NULL,initiator_account TEXT NOT NULL REFERENCES accounts(id),
    assignment_revision INTEGER NOT NULL CHECK(assignment_revision>0),authority_generation TEXT NOT NULL,
    task TEXT REFERENCES tasks(id),state TEXT NOT NULL CHECK(state IN('pending','admitted','consumed','blocked')),
    missed_count INTEGER NOT NULL CHECK(missed_count>=0),run TEXT UNIQUE REFERENCES workflow_runs(id),admission_id TEXT NOT NULL UNIQUE,PRIMARY KEY(schedule,occurrence_id)
  ) STRICT;
  CREATE UNIQUE INDEX occurrence_pending ON occurrences(schedule,schedule_revision) WHERE state IN('pending','blocked');
