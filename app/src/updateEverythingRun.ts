// Adapted from T3 updateEverythingRun.tsx (MIT). See app/t3/provenance.json.
import type { UpdateCommand, UpdateRun } from './updateEverything.logic.ts';

export type UpdateRequest = <T>(path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
type Receipt = { machine: string; status: string; reason?: string; id?: string };

export const updateRunKey = 'briefsip:update-everything';
export const localUpdateKey = 'briefsip:update';
const validSource = (source: unknown) => source === undefined || source === 'GitHub' || source === 'Local feed';
const validId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,36}$/.test(value);

export function readSavedUpdateRun(storage: Pick<Storage, 'getItem'>): UpdateRun | null {
  const raw = storage.getItem(updateRunKey);
  if (!raw) return null;
  const run = JSON.parse(raw) as UpdateRun;
  if (!Array.isArray(run?.rows) || !Array.isArray(run.commands) || !run.commands.length
    || run.rows.some(row => !row || !validId(row.id) || typeof row.name !== 'string'
      || typeof row.current !== 'string' || row.local !== (row.id === 'local') || !Number.isSafeInteger(row.running) || row.running < 0
      || typeof row.status !== 'string' || !validSource(row.source) || row.skipped !== null && typeof row.skipped !== 'string')
    || new Set(run.rows.map(row => row.id)).size !== run.rows.length
    || run.commands.some(command => !command || !validId(command.id) || typeof command.version !== 'string' || !validSource(command.source)
      || !Array.isArray(command.machines) || !command.machines.length || command.machines.length > 16
      || command.machines.some(id => !run.rows.some(row => row.id === id && !row.skipped && row.target === command.version && row.source === command.source))
      || command.startedAt !== undefined && !Number.isFinite(command.startedAt)
      || command.submitted !== undefined && typeof command.submitted !== 'boolean')
    || run.commands.flatMap(command => command.machines).length !== run.rows.filter(row => !row.skipped).length
    || new Set(run.commands.flatMap(command => command.machines)).size !== run.commands.flatMap(command => command.machines).length
    || run.commands.slice(0, -1).some(command => command.machines.includes('local'))
    || run.commands.at(-1)?.machines.includes('local') && run.commands.at(-1)?.machines.length !== 1) {
    throw new Error('Saved update could not be read. Check update history before starting another update.');
  }
  return run;
}

export function readLocalUpdate(storage: Pick<Storage, 'getItem'>): Pick<UpdateCommand, 'id' | 'version' | 'source'> | null {
  const value = JSON.parse(storage.getItem(localUpdateKey) ?? 'null') as Pick<UpdateCommand, 'id' | 'version' | 'source'> | null;
  if (value && (!validId(value.id) || typeof value.version !== 'string' || !validSource(value.source))) throw new Error('Saved update could not be read.');
  return value;
}

export function updateRunCommand(run: UpdateRun, command: UpdateCommand): UpdateRun {
  return { ...run, commands: run.commands.map(entry => entry.id === command.id ? command : entry) };
}

export async function submitUpdateCommand(request: UpdateRequest, command: UpdateCommand): Promise<Receipt[]> {
  const body = { id: command.id, version: command.version, ...(command.source && { source: command.source }) };
  if (command.machines[0] === 'local') {
    const result = await request<{ id: string }>('/api/updates/apply', body);
    return [{ machine: 'local', status: 'accepted', id: result.id }];
  }
  const result = await request<{ machines: Receipt[] }>('/api/updates/fan-out', { ...body, machines: command.machines });
  return result.machines;
}

export function withUpdateReceipts(run: UpdateRun, command: UpdateCommand, receipts: Receipt[]): UpdateRun {
  const rows = run.rows.map(row => {
    if (!command.machines.includes(row.id)) return row;
    const receipt = receipts.find(item => item.machine === row.id);
    return {
      ...row, attemptId: receipt?.id,
      status: receipt?.status === 'failed' ? 'failed' : receipt?.status === 'accepted' ? 'accepted' : 'uncertain',
      reason: receipt?.reason,
    };
  });
  return updateRunCommand({ ...run, rows }, { ...command, submitted: true });
}
