export type StreamSegment = { seq: number; ordinal: number; id: string; kind: 'text' | 'tool'; text: string; state: string; final: number; revision: number };
export type StreamPartial = { seq: number; text: string; model: string; status: string; segment?: string; revision?: number; final?: boolean };
// Snapshots replace text, never concatenate. A resumed provider call supersedes its predecessor.
export function newestPartial(current: StreamPartial | null | undefined, incoming: StreamPartial | null | undefined) {
  if (!current) return incoming;
  if (!incoming) return current;
  if (incoming.seq !== current.seq) return incoming.seq > current.seq ? incoming : current;
  if (incoming.status !== current.status) return current.status === 'pending' ? incoming : current;
  if (incoming.revision !== undefined || current.revision !== undefined) return (incoming.revision ?? 0) > (current.revision ?? 0) ? incoming : current;
  return incoming.text.length >= current.text.length ? incoming : current;
}
export function parseTurnSnapshot(value: unknown): { id: string; partial: StreamPartial } | null {
  if (!value || typeof value !== 'object') return null;
  const { id, partial } = value as { id?: unknown; partial?: StreamPartial };
  return typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id) && partial && Number.isSafeInteger(partial.seq) && partial.seq > 0 && typeof partial.text === 'string' && partial.text.length <= 2 * 1024 * 1024 && typeof partial.model === 'string' && partial.model.length <= 300 && ['pending', 'received', 'failed'].includes(partial.status)
    && (partial.segment === undefined || typeof partial.segment === 'string' && partial.segment.length <= 310)
    && (partial.revision === undefined || Number.isSafeInteger(partial.revision) && partial.revision >= 0)
    && (partial.final === undefined || typeof partial.final === 'boolean') ? { id, partial } : null;
}
