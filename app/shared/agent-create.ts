import type { Runtime } from './runtime.ts';
import { parseAgentTemplate } from './agent-template.ts';

export type AgentCreation = { id: string; name: string; role?: string; model: string; backupModel: string; instructions: string; threadLimit: number; toolBudget?: number; providerAccount: string; setup?: boolean; runtime?: Runtime };
export function restoreAgentCreation(raw: string | null): AgentCreation | null {
  if (raw === null) return null;
  if (raw.length > 64000) throw new Error('Agent creation data is too large.');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['id','name','role','model','backupModel','instructions','threadLimit','toolBudget','providerAccount','setup','runtime'].includes(key)) || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.id) || typeof value.providerAccount !== 'string' || value.providerAccount.length > 64 || value.setup !== undefined && typeof value.setup !== 'boolean' || typeof value.backupModel !== 'string') throw new Error('Invalid agent creation data.');
  if (value.runtime !== undefined && !['api', 'codex', 'claude', 'hermes', 'antigravity', 'grok', 'pi', 'opencode', 'gemini', 'kiro'].includes(value.runtime)) throw new Error('Invalid agent runtime.');
  parseAgentTemplate({ format: 'minarbot-agent', version: 1, name: value.name, role: value.role, model: value.model, backupModel: value.backupModel, instructions: value.instructions, toolBudget: value.toolBudget, threadLimit: value.threadLimit });
  return value;
}
