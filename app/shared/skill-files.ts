import { parseDocument } from 'yaml';

export type SkillFile = { path: string; content: string; encoding?: 'base64' };
export const skillBinaryLimit = 2 * 1024 * 1024;
export function skillFileBytes(file: SkillFile): Uint8Array {
  return file.encoding === 'base64' ? Uint8Array.from(atob(file.content), char => char.charCodeAt(0)) : new TextEncoder().encode(file.content);
}
export function skillFileFromBytes(path: string, bytes: Uint8Array, binary = false): SkillFile {
  if (!binary) try {
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) return { path, content };
  } catch { /* Binary assets retain exact bytes rather than replacement characters. */ }
  let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte);
  return { path, content: btoa(raw), encoding: 'base64' };
}
export function exportedSkillFiles(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('File is not a Minarbot version 1 skill folder export.');
  const bundle = value as Record<string, unknown>;
  if ((bundle.format !== 'minarbot-skill-folder' && bundle.format !== 'briefsip-skill-folder') || bundle.version !== 1 || Object.keys(bundle).some(key => !['format', 'version', 'files'].includes(key))) throw new Error('File is not a Minarbot version 1 skill folder export.');
  return bundle.files;
}
export function parseSkillFiles(value: unknown) {
  // ponytail: bounded immutable snapshots; packages above 2 MiB need a streamed asset store.
  if (!Array.isArray(value) || !value.length || value.length > 32 || new TextEncoder().encode(JSON.stringify(value)).length > 4 * 1024 * 1024) throw new Error('Skill folder limit is 32 files, 48 KB of text, and 2 MiB of binary assets.');
  const files: SkillFile[] = [], names = new Set<string>(); let binarySize = 0;
  for (const file of value) {
    if (!file || typeof file !== 'object' || Object.keys(file).some(key => !['path', 'content', 'encoding'].includes(key)) || typeof file.path !== 'string' || file.path.length > 240 || !file.path.split('/').every((part: string) => part && part !== '.' && part !== '..') || /[\\\x00-\x1f\x7f:]/.test(file.path) || typeof file.content !== 'string' || !file.content.isWellFormed() || file.encoding !== undefined && file.encoding !== 'base64' || file.encoding === undefined && /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(file.content) || names.has(file.path.toLowerCase())) throw new Error('Invalid skill file path or content. Use UTF-8 text files without duplicate paths.');
    if (file.encoding === 'base64') {
      if (file.path === 'SKILL.md' || file.content.length > Math.ceil(skillBinaryLimit / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) throw new Error('Binary assets must use standard base64; SKILL.md must be UTF-8 text.');
      const raw = atob(file.content);
      if (btoa(raw) !== file.content || (binarySize += raw.length) > skillBinaryLimit) throw new Error('Binary assets are invalid or their total exceeds 2 MiB.');
    }
    names.add(file.path.toLowerCase()); files.push({ path: file.path, content: file.content, ...(file.encoding ? { encoding: 'base64' as const } : {}) });
  }
  if (new TextEncoder().encode(JSON.stringify(files.filter(file => !file.encoding))).length > 48000) throw new Error('Skill text file limit is 48 KB.');
  if (files.some(file => file.path.split('/').slice(0, -1).some((_, index, parts) => names.has(parts.slice(0, index + 1).join('/').toLowerCase())))) throw new Error('File path conflicts with a folder. Rename the file or folder before importing.');
  const source = files.find(file => file.path === 'SKILL.md')?.content;
  const match = source?.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error('SKILL.md must have YAML frontmatter.');
  const doc = parseDocument(match[1], { uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length) throw new Error('Invalid SKILL.md frontmatter.');
  const meta = doc.toJS({ maxAliasCount: 0 });
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || typeof meta.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) || meta.name.length > 64 || typeof meta.description !== 'string' || !meta.description.trim() || meta.description.length > 1024 || !match[2].trim() || match[2].trim().length > 16000) throw new Error('SKILL.md requires a slug name, a description up to 1024 characters, and instructions up to 16000 characters.');
  if (Object.keys(meta).some(key => !['name', 'description', 'license', 'compatibility', 'metadata'].includes(key))) throw new Error('Skill uses unsupported tool, activation, or provider rules. Import cancelled so these rules are not ignored.');
  if (meta.license !== undefined && typeof meta.license !== 'string' || meta.compatibility !== undefined && (typeof meta.compatibility !== 'string' || !meta.compatibility.trim() || meta.compatibility.length > 500) || meta.metadata !== undefined && (!meta.metadata || typeof meta.metadata !== 'object' || Array.isArray(meta.metadata) || Object.values(meta.metadata).some(value => typeof value !== 'string'))) throw new Error('License and compatibility must be text; metadata must contain name and text pairs.');
  return { name: meta.name as string, description: meta.description.trim() as string, content: match[2].trim(), files };
}
