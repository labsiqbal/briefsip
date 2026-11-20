CREATE TABLE IF NOT EXISTS provider_accounts(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    family TEXT NOT NULL CHECK(family IN('openai-compatible','anthropic','gemini')),
    base_url TEXT NOT NULL,
    key_ciphertext TEXT NOT NULL,
    default_model TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
) STRICT;
