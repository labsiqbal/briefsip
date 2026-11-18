import type { DatabaseSync } from 'node:sqlite';

export function requireSkillSchema(db: DatabaseSync) {
  db.prepare('SELECT skill, version, removed, pack FROM agent_skills LIMIT 0').all();
  db.prepare('SELECT skill, revision, files FROM skill_files LIMIT 0').all();
}

export function seedSkillVersion(db: DatabaseSync, id: string, data: {
  revision: number; name: string; description: string; content: string;
}) {
  const { name, description, content } = data;
  const revision = data.revision + 1;
  db.prepare('INSERT INTO skills VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=excluded.revision').run(id, name, revision);
  db.prepare('INSERT INTO skill_versions VALUES (?,?,?,?,?)').run(id, revision, name, description, content);
}
