-- Historical Node DDL frozen from the compatibility paths at cd2c23fe.
CREATE TABLE workflows (id TEXT PRIMARY KEY,agent TEXT NOT NULL REFERENCES agents(id),name TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))) STRICT;
    CREATE TABLE workflow_versions (workflow TEXT NOT NULL REFERENCES workflows(id),revision INTEGER NOT NULL,graph TEXT NOT NULL,PRIMARY KEY(workflow,revision)) STRICT;
CREATE TABLE workflow_runs (id TEXT PRIMARY KEY,workflow TEXT NOT NULL REFERENCES workflows(id),version INTEGER NOT NULL,agent TEXT NOT NULL REFERENCES agents(id),graph TEXT NOT NULL,
      input TEXT NOT NULL,last TEXT NOT NULL,cursor TEXT NOT NULL,steps INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK(status IN ('ready','waiting','approval','done','failed','cancelled')),error TEXT,created TEXT NOT NULL,retry_settings TEXT) STRICT;
CREATE TABLE workflow_schedules(workflow TEXT PRIMARY KEY REFERENCES workflows(id),revision INTEGER NOT NULL,next_at INTEGER NOT NULL,interval_ms INTEGER,input TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN(0,1))) STRICT;
    CREATE TABLE workflow_occurrences(workflow TEXT NOT NULL REFERENCES workflows(id),scheduled_at INTEGER NOT NULL,run TEXT REFERENCES workflow_runs(id),missed INTEGER NOT NULL,reason TEXT,PRIMARY KEY(workflow,scheduled_at)) STRICT;
