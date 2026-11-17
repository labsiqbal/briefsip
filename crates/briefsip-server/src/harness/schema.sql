CREATE TABLE IF NOT EXISTS harness_catalog(runtime TEXT PRIMARY KEY,models TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS harness_models(agent TEXT NOT NULL REFERENCES agents(id),runtime TEXT NOT NULL,model TEXT NOT NULL,PRIMARY KEY(agent,runtime)) STRICT;
CREATE TABLE IF NOT EXISTS harness_sessions(agent TEXT NOT NULL REFERENCES agents(id),conversation TEXT NOT NULL,runtime TEXT NOT NULL,workspace TEXT NOT NULL,session TEXT NOT NULL,PRIMARY KEY(agent,conversation,runtime,workspace)) STRICT;
