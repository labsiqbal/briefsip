export class SiteError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function siteCommand(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SiteError(400, 'Invalid site change.');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !['id', 'site', 'revision', 'name', 'source', 'delete'].includes(key)) || typeof data.id !== 'string' || !uuid.test(data.id) ||
    (data.site !== undefined && (typeof data.site !== 'string' || !uuid.test(data.site))) ||
    (data.site === undefined ? data.revision !== undefined || data.delete !== undefined : !Number.isSafeInteger(data.revision) || Number(data.revision) < 1) ||
    (data.delete !== undefined && data.delete !== true)) throw new SiteError(400, 'Invalid site identity or revision.');
  if (data.delete === true) {
    if (data.name !== undefined || data.source !== undefined) throw new SiteError(400, 'Deletion does not accept site content.');
    return { id: data.id, site: data.site as string, revision: data.revision as number, delete: true as const };
  }
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80 || /[\x00-\x1f\x7f]/.test(data.name) || typeof data.source !== 'string' || !data.source.trim() || data.source.length > 262144 || new TextEncoder().encode(data.source).length > 262144) throw new SiteError(400, 'Name is required, up to 80 characters. HTML limit is 256 KiB.');
  return { id: data.id, ...(data.site === undefined ? {} : { site: data.site as string, revision: data.revision as number }), name: data.name.trim(), source: data.source };
}
