export type ThreadCommand = { path: string; data: { id: string; revision?: number; name?: string; archived?: boolean } };
export function restoreThreadCommand(raw: string | null, agent: string): ThreadCommand | null {
  if (raw === null) return null;
  const value = JSON.parse(raw), uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  const edit = /^\/api\/threads\/([a-f0-9-]+)\/(edit|delete)$/.exec(value?.path ?? '');
  const create = value?.path === `/api/agents/${agent}/threads`, data = value?.data;
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !['path','data'].includes(key)) || !(create || edit && uuid.test(edit[1]))
    || !data || Array.isArray(data) || Object.keys(data).some(key => !['id','revision','name','archived'].includes(key)) || !uuid.test(data.id)
    || !create && (!Number.isSafeInteger(data.revision) || data.revision < 1)
    || edit?.[2] !== 'delete' && (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80)
    || edit?.[2] === 'edit' && typeof data.archived !== 'boolean') throw new Error('Conversation recovery could not be read. Check history before discarding it.');
  return value;
}
