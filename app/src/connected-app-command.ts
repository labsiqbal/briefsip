export type ConnectedAppCommand = { path: string; body: { id: string; revision?: number; enabled?: boolean; fingerprint?: string; confirmed?: boolean; decision?: 'allow' | 'always' | 'deny' } };
export function restoreConnectedAppCommand(raw: string | null): ConnectedAppCommand | null {
  if (raw === null) return null;
  if (raw.length > 4000) throw new Error('Connected apps recovery data is too large.');
  const value = JSON.parse(raw), uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
  if (!value || typeof value.path !== 'string' || !new RegExp(`^/api/(connected-apps/(key(?:/remove)?|connect/[a-z0-9_-]{1,100}|grant-all/[a-z0-9_-]{1,100}|disconnect/[a-zA-Z0-9_-]{1,160})|agents/${uuid}/connected-apps/[a-z0-9_-]{1,100}|agents/${uuid}/connected-app-policies|(agents|channels|threads)/${uuid}/turns/${uuid}/app-approvals/[^/]{1,500})$`, 'i').test(value.path) || !value.body || typeof value.body !== 'object' || Array.isArray(value.body) || !new RegExp(`^${uuid}$`, 'i').test(value.body.id) || Object.keys(value.body).some(key => !['id','revision','enabled','fingerprint','decision','confirmed'].includes(key)) || Object.keys(value).some(key=>!['path','body'].includes(key))) throw new Error('Connected apps recovery data is invalid.');
  const body = value.body;
  if (/^\/api\/connected-apps\/key(?:\/remove)?$/.test(value.path)) { if (!Number.isSafeInteger(body.revision) || body.revision < 0 || Object.keys(body).some(key=>!['id','revision'].includes(key))) throw new Error('API key recovery data is invalid.'); }
  else if (value.path.includes('/app-approvals/')) { if (!Number.isSafeInteger(body.revision) || body.revision < 1 || !['allow','always','deny'].includes(body.decision)) throw new Error('Approval recovery data is invalid.'); }
  else if (value.path.includes('/connected-apps/') && value.path.startsWith('/api/agents/')) { if (!Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.enabled !== 'boolean') throw new Error('Access recovery data is invalid.'); }
  else if (value.path.endsWith('/connected-app-policies') && !/^[a-f0-9]{64}$/.test(body.fingerprint)) throw new Error('Policy recovery data is invalid.');
  return value;
}
