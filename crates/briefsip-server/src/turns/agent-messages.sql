CREATE TABLE IF NOT EXISTS agent_requests(id TEXT PRIMARY KEY,turn TEXT NOT NULL REFERENCES turns(id),call_id TEXT NOT NULL,expects_reply INTEGER NOT NULL,settled INTEGER NOT NULL DEFAULT 0,UNIQUE(turn,call_id)) STRICT;
CREATE TABLE IF NOT EXISTS agent_deliveries(request TEXT NOT NULL REFERENCES agent_requests(id),turn TEXT PRIMARY KEY REFERENCES turns(id)) STRICT;
CREATE TABLE IF NOT EXISTS agent_reply_captures(turn TEXT PRIMARY KEY REFERENCES turns(id)) STRICT;
CREATE TABLE IF NOT EXISTS agent_reply_claims(delivery TEXT PRIMARY KEY REFERENCES turns(id),consumer TEXT NOT NULL REFERENCES turns(id),snapshot TEXT NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS agent_reply_claims_consumer ON agent_reply_claims(consumer);
CREATE INDEX IF NOT EXISTS agent_deliveries_request ON agent_deliveries(request);
CREATE INDEX IF NOT EXISTS turns_parent ON turns(parent);
CREATE INDEX IF NOT EXISTS turns_agent_status ON turns(agent,status);
