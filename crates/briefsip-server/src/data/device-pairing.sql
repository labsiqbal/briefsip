CREATE TABLE IF NOT EXISTS browser_pairing_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    required INTEGER NOT NULL CHECK (required IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS browser_devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    last_seen INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
) STRICT;

CREATE TEMP TABLE IF NOT EXISTS browser_pairing_challenge (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    origin TEXT NOT NULL,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 5
) STRICT;
