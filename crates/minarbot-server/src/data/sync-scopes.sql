
CREATE TABLE IF NOT EXISTS sync_scope_revisions(project TEXT PRIMARY KEY REFERENCES projects(id),revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE TRIGGER IF NOT EXISTS sync_scope_update AFTER UPDATE ON record_scopes
WHEN NEW.project<>OLD.project OR NEW.account<>OLD.account OR NEW.visibility<>OLD.visibility OR NEW.root_kind<>OLD.root_kind OR NEW.root_id<>OLD.root_id OR NEW.table_name<>OLD.table_name OR NEW.key_json<>OLD.key_json
BEGIN
  INSERT INTO sync_scope_revisions VALUES (OLD.project,1) ON CONFLICT(project) DO UPDATE SET revision=revision+1;
  INSERT INTO sync_scope_revisions SELECT NEW.project,1 WHERE NEW.project<>OLD.project ON CONFLICT(project) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS sync_scope_delete AFTER DELETE ON record_scopes BEGIN
  INSERT INTO sync_scope_revisions VALUES (OLD.project,1) ON CONFLICT(project) DO UPDATE SET revision=revision+1;
END;
