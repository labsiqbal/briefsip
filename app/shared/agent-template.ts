export const defaultToolBudget = 90;
export function parseToolBudget(value: unknown = defaultToolBudget): number {
  if (!Number.isSafeInteger(value) || Number(value) < 10 || Number(value) > 200) throw new Error('Tool steps per task must be 10 to 200.');
  return Number(value);
}

export function parseAgentRole(value: unknown = ''): string {
  if (typeof value !== 'string' || value.trim().length > 60 || /[\p{Cc}\u2028\u2029]/u.test(value)) throw new Error('Role must be a single line of up to 60 characters without control characters.');
  return value.trim();
}

export type AgentTemplate = { format: 'minarbot-agent'; version: 1; name: string; role?: string; model: string; backupModel?: string; instructions: string; threadLimit: number; toolBudget?: number; avatar?: string };
export function parseAgentTemplate(value: unknown): AgentTemplate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Template must be a JSON object.');
  const data = value as Record<string, unknown>;
  if (String(data.format) !== 'minarbot-agent' || data.version !== 1 || Object.keys(data).some(key => !['format', 'version', 'name', 'role', 'model', 'backupModel', 'instructions', 'threadLimit', 'toolBudget', 'avatar'].includes(key))) throw new Error('Unsupported template format or version.');
  if (data.avatar !== undefined) {
    if (typeof data.avatar !== 'string' || data.avatar.length > 699052 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.avatar)) throw new Error('Invalid template avatar.');
    const bytes = atob(data.avatar);
    if (btoa(bytes) !== data.avatar || bytes.length > 512 * 1024 || !bytes.startsWith('\x89PNG\r\n\x1a\n') || bytes.slice(12,16) !== 'IHDR' || bytes.slice(16,24) !== '\x00\x00\x01\x00\x00\x00\x01\x00') throw new Error('Template avatar must be a 256x256 PNG, up to 512 KiB.');
    const view = new DataView(Uint8Array.from(bytes, char => char.charCodeAt(0)).buffer);
    let offset = 8, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset), kind = bytes.slice(offset + 4, offset + 8);
      if (offset + 12 + length > bytes.length) throw new Error('Incomplete PNG avatar.');
      if (['acTL','fcTL','fdAT'].includes(kind)) throw new Error('Use a static avatar, not an animation.');
      offset += 12 + length;
      if (kind === 'IEND') { ended = length === 0; break; }
    }
    if (!ended || offset !== bytes.length) throw new Error('Incomplete PNG avatar.');
  }
  const text = (key: string, max: number) => {
    const value = data[key];
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Field ${key} is invalid.`);
    return value.trim();
  };
  const role = parseAgentRole(data.role);
  if (data.toolBudget !== undefined) parseToolBudget(data.toolBudget);
  if (!Number.isSafeInteger(data.threadLimit) || Number(data.threadLimit) < 1 || Number(data.threadLimit) > 32) throw new Error('Side thread count must be 1 to 32.');
  const model = text('model', 160);
  if (data.backupModel !== undefined && (typeof data.backupModel !== 'string' || data.backupModel.length > 160 || /[\x00-\x1f\x7f]/.test(data.backupModel) || data.backupModel.trim() === model)) throw new Error('Fallback model is invalid or matches the primary model.');
  return { format: 'minarbot-agent', version: 1, name: text('name', 80), role, model, ...(data.backupModel === undefined ? {} : { backupModel: (data.backupModel as string).trim() }), instructions: text('instructions', 8000), threadLimit: Number(data.threadLimit), ...(data.toolBudget === undefined ? {} : { toolBudget: Number(data.toolBudget) }), ...(data.avatar === undefined ? {} : { avatar: data.avatar as string }) };
}
export function templateCommand(template: AgentTemplate, id: string) {
  const { name, role, model, instructions, threadLimit, toolBudget, backupModel, avatar } = parseAgentTemplate(template);
  return { id, name, role: role ?? '', model, instructions, threadLimit, ...(toolBudget === undefined ? {} : { toolBudget }), ...(backupModel === undefined ? {} : { backupModel }), ...(avatar === undefined ? {} : { avatar }) };
}
export function restoreTemplateImport(raw: string | null): { template: AgentTemplate; id: string } | null {
  if (raw === null) return null;
  if (raw.length > 750000) throw new Error('Import recovery data is too large.');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['template', 'id'].includes(key)) || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.id)) throw new Error('Invalid import recovery data.');
  return { id: value.id, template: parseAgentTemplate(value.template) };
}
