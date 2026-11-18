CREATE TABLE IF NOT EXISTS device_recovery_entries(action_id TEXT NOT NULL REFERENCES device_journal(action_id),journal_sequence INTEGER NOT NULL,entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),PRIMARY KEY(action_id,journal_sequence)) STRICT;
      CREATE TABLE IF NOT EXISTS device_enrollment_keys(authority_generation TEXT NOT NULL,device_generation INTEGER NOT NULL,signing_ref TEXT NOT NULL,signing_public_key TEXT NOT NULL,PRIMARY KEY(authority_generation,device_generation)) STRICT;
      CREATE TABLE IF NOT EXISTS device_wait_secrets(
        wait_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN('turn','workflow')),
        key_reference TEXT NOT NULL UNIQUE,
        secret_generation INTEGER NOT NULL CHECK(secret_generation>0),
        deadline INTEGER NOT NULL,
        closed INTEGER NOT NULL CHECK(closed IN(0,1)),
        provision_id TEXT NOT NULL UNIQUE,
        payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
        provision_json TEXT NOT NULL CHECK(json_valid(provision_json)),
        result_request_id TEXT NOT NULL UNIQUE,
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        state TEXT NOT NULL CHECK(state IN('staging','ready','failed','acknowledged')),
        ack_json TEXT CHECK(ack_json IS NULL OR json_valid(ack_json)),
        cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_pending IN(0,1)),
        PRIMARY KEY(wait_key,secret_generation),
        CHECK((state='staging' AND result_json IS NULL) OR (state<>'staging' AND result_json IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS device_wait_recovery ON device_wait_secrets(state,json_extract(provision_json,'$.sourceDeviceGeneration'),json_extract(provision_json,'$.authorityGeneration'));
      CREATE INDEX IF NOT EXISTS device_wait_cleanup ON device_wait_secrets(cleanup_pending) WHERE closed=1;
