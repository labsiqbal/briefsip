import { validatePackMembers } from './skill-pack-schema.ts';
import { parseSkillFiles } from './skill-files.ts';
export type SkillCommand = { path: string; body: Record<string, unknown> & { id: string } };
export function restoreSkillCommand(raw: string | null): SkillCommand | null {
  if (raw === null) return null;
  if (raw.length > 4 * 1024 * 1024) throw new Error('Skill recovery data is too large.');
  const value = JSON.parse(raw), uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['path', 'body'].includes(key)) || typeof value.path !== 'string' || !new RegExp(`^/api/((?:skills|skill-packs)(?:/${uuid})?|agents/${uuid}/(?:skills|skill-packs)/${uuid})$`, 'i').test(value.path)) throw new Error('Invalid skill recovery route.');
  const body = value.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.id !== 'string' || !new RegExp(`^${uuid}$`, 'i').test(body.id) || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error('Invalid skill recovery command.');
  const install = value.path.startsWith('/api/agents/'), pack = value.path.includes('/skill-packs');
  if (Object.keys(body).some(key => !(install ? ['id', 'revision', 'version', 'enabled', 'remove'] : pack ? ['id', 'revision', 'name', 'members'] : body.files !== undefined ? ['id', 'revision', 'files'] : ['id', 'revision', 'name', 'description', 'content']).includes(key))) throw new Error('Invalid skill recovery field.');
  if (!install && !pack && body.files !== undefined) { parseSkillFiles(body.files); return value as SkillCommand; }
  if (!install && pack) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw new Error('Invalid skill pack name.');
    validatePackMembers(body.members); return value as SkillCommand;
  }
  if (install ? !Number.isSafeInteger(body.version) || body.version < 1 || typeof body.enabled !== 'boolean' || (body.remove !== undefined && (body.remove !== true || body.enabled)) : ['name', 'description', 'content'].some((key, index) => typeof body[key] !== 'string' || !body[key].trim() || body[key].length > [80, 1024, 16000][index])) throw new Error('Invalid skill recovery content.');
  return value as SkillCommand;
}
