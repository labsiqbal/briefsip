export function visibilityCommand(value: unknown): { id: string; revision: number; hidden: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid agent status request.');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !['id','revision','hidden'].includes(key)) || typeof item.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(item.id) || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0 || typeof item.hidden !== 'boolean') throw new Error('Invalid agent status request.');
  return { id: item.id, revision: Number(item.revision), hidden: item.hidden };
}
