export type Session = { accountId: string; name: string; csrf: string; expiresAt: number; projectId?: string; role?: string };
export type Member = { accountId: string; name: string; role: string; revision: number };
export type Project = { id: string; name: string; host: string; role: string };
export type Policy = { sectionIds: string[]; invocation: { mode: 'owner' | 'all-members' } | { mode: 'members'; accountIds: string[] }; scopes: ('read' | 'invoke')[]; localPolicyDigest: string; payerBindingRef: string; maxCostMicros: number };
export type Participant = { id: string; agentId: string; name: string; ownerAccountId: string; ownerName: string; nodeId: string; nodeStatus: string; state: string; revision: number; policy: Policy; policyDigest: string; ownerConsentRevision: number; projectConsentRevision: number };
export type Message = { id: string; requester_account_id: string; text: string; created_at: number };
export type Result = { turnId: string; agentId: string; requesterAccountId: string; payerAccountId: string; kind: string; sequence: number; payload: { text?: string; code?: string } };
export type Turn = { id: string; messageId: string; agentId: string; requesterAccountId: string; payerAccountId: string; state: string };
export type History = { messages: Message[]; results: Result[] };
export class HubError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; } }
export async function hubRequest<T>(path: string, body?: unknown, csrf?: string, token?: string): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ?? '' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new HubError(response.status, data.error?.code ?? 'request_failed', data.error?.message ?? 'Request failed. Try again.');
  return data as T;
}
export const invocationLabel = (policy: Policy) => policy.invocation.mode === 'owner' ? 'Owner only' : policy.invocation.mode === 'members' ? 'Specific members' : 'All members';
export type Draft = { text: string; mentions: string[]; pending: { requestId: string; sectionId: string; text: string; mentions: string[] } | null };
export function parseDraft(raw: string | null): Draft {
  if (!raw) return { text: '', mentions: [], pending: null };
  const value = JSON.parse(raw) as Draft;
  const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
  const ids = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 100 && v.every(uuid) && new Set(v).size === v.length;
  if (!value || typeof value.text !== 'string' || value.text.length > 16000 || !ids(value.mentions) || value.pending !== null && (!value.pending || !uuid(value.pending.requestId) || !uuid(value.pending.sectionId) || typeof value.pending.text !== 'string' || value.pending.text.length > 16000 || !ids(value.pending.mentions))) throw new Error('Saved draft could not be read. Discard recovery before sending.');
  return value;
}

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
export type JoinMetadata = { nodeId: string; agentId: string; name: string; localPolicyDigest: string; maxCostMicros: number; providerMaxCostMicros: number };
export function parseJoin(raw: string): JoinMetadata {
  if (raw.length > 4096) throw new Error('Invalid agent handoff. Start again from the local app.');
  const value = JSON.parse(raw) as JoinMetadata;
  if (!value || !uuid(value.nodeId) || !uuid(value.agentId) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160 || typeof value.localPolicyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.localPolicyDigest) || !positive(value.maxCostMicros) || !positive(value.providerMaxCostMicros) || value.providerMaxCostMicros > value.maxCostMicros) throw new Error('Invalid agent handoff. Start again from the local app.');
  return value;
}
export type LocalGrant = { projectId: string; participationId: string; agentId: string; localAgentId: string; revision: number; policy: Policy; providerMaxCostMicros: number; enabled?: boolean };
export function parseGrant(raw: string): LocalGrant {
  if (raw.length > 65536) throw new Error('Invalid participation request. Get a new request from the hub.');
  const value = JSON.parse(raw) as LocalGrant, policy = value?.policy;
  const ids = (list: unknown): list is string[] => Array.isArray(list) && list.length > 0 && list.length <= 100 && list.every(uuid) && new Set(list).size === list.length;
  if (!value || !uuid(value.projectId) || !uuid(value.participationId) || !uuid(value.agentId) || !uuid(value.localAgentId) || !positive(value.revision) || !positive(value.providerMaxCostMicros) || !policy || !ids(policy.sectionIds) || !Array.isArray(policy.scopes) || policy.scopes.length !== 2 || !policy.scopes.includes('read') || !policy.scopes.includes('invoke') || !policy.invocation || !['owner','members','all-members'].includes(policy.invocation.mode) || policy.invocation.mode === 'members' && !ids(policy.invocation.accountIds) || typeof policy.localPolicyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(policy.localPolicyDigest) || typeof policy.payerBindingRef !== 'string' || !policy.payerBindingRef || policy.payerBindingRef.length > 160 || !positive(policy.maxCostMicros) || value.providerMaxCostMicros > policy.maxCostMicros) throw new Error('Invalid participation request. Get a new request from the hub.');
  return value;
}
