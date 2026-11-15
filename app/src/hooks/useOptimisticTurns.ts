import { useRef } from 'react';

type Turn = { id: string; seq: number; status: string; optimistic?: boolean };
export function reconcileOptimisticTurns<T extends Turn>(pending: Map<string, T>, rows: T[], acknowledge = true) {
  const ids = new Set(rows.map(row => row.id));
  const merged = rows.map(row => {
    const local = pending.get(row.id);
    if (!local) return row;
    if (acknowledge) pending.delete(row.id);
    return { ...row, optimistic: !acknowledge };
  });
  return [...merged, ...[...pending.values()].filter(row => !ids.has(row.id))].sort((a, b) => a.seq - b.seq);
}
export function useOptimisticTurns<T extends Turn>() {
  const pending = useRef(new Map<string, T>());
  return {
    add(turn: T) { pending.current.set(turn.id, turn); },
    remove(id: string) { pending.current.delete(id); },
    merge(rows: T[], acknowledge = true) { return reconcileOptimisticTurns(pending.current, rows, acknowledge); },
  };
}
