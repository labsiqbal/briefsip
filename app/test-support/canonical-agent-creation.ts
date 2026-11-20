import { parseAgentTemplate } from '../shared/agent-template.ts';

export function parseCanonicalAgentCreation(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid agent creation data.');
  const d = value as Record<string, unknown>;
  if (Object.keys(d).some(key => !['requestId','id','name','role','model','backupModel','instructions','threadLimit','toolBudget','projectId','homeDeviceId','expectedProjectRevision','expectedHomeDeviceRevision','providerBinding','setup','avatar'].includes(key))) throw new Error('Unknown agent creation field.');
  const identifier = (value: unknown) => { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new Error('Invalid agent creation ID.'); return value.toLowerCase(); };
  const positive = (value: unknown) => { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('Invalid agent creation revision.'); return Number(value); };
  const requestId = identifier(d.requestId), agentId = identifier(d.id);
  if (requestId !== agentId || typeof d.backupModel !== 'string' || d.setup !== undefined && typeof d.setup !== 'boolean' || d.avatar !== undefined && (typeof d.avatar !== 'string' || !d.avatar || d.avatar.length > 699052)) throw new Error('Invalid agent creation data.');
  const profile = parseAgentTemplate({ format: 'minarbot-agent', version: 1, name: d.name, role: d.role, model: d.model, backupModel: d.backupModel, instructions: d.instructions, toolBudget: d.toolBudget, threadLimit: d.threadLimit });
  let providerBinding: null | { bindingId: string; expectedRevision: number } = null;
  if (d.providerBinding !== null) {
    if (!d.providerBinding || typeof d.providerBinding !== 'object' || Array.isArray(d.providerBinding)) throw new Error('Provider binding must be selected or null.');
    const binding = d.providerBinding as Record<string, unknown>;
    if (Object.keys(binding).some(key => !['bindingId','expectedRevision'].includes(key))) throw new Error('Invalid provider binding.');
    providerBinding = { bindingId: identifier(binding.bindingId), expectedRevision: positive(binding.expectedRevision) };
  }
  return { requestId, id: agentId, name: profile.name, ...(d.role === undefined ? {} : { role: profile.role! }), model: profile.model, backupModel: profile.backupModel!, instructions: profile.instructions, threadLimit: profile.threadLimit, ...(d.toolBudget === undefined ? {} : { toolBudget: profile.toolBudget! }), projectId: identifier(d.projectId), homeDeviceId: identifier(d.homeDeviceId), expectedProjectRevision: positive(d.expectedProjectRevision), expectedHomeDeviceRevision: positive(d.expectedHomeDeviceRevision), providerBinding, setup: d.setup === true, ...(d.avatar === undefined ? {} : { avatar: d.avatar as string }) };
}

export function restoreCanonicalAgentCreation(raw: string | null) {
  if (raw === null) return null;
  if (raw.length > 750000) throw new Error('Agent creation data is too large.');
  return parseCanonicalAgentCreation(JSON.parse(raw));
}
