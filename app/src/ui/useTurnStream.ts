import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { newestPartial, parseTurnSnapshot, type StreamPartial } from '../../turn-stream';

type Turn = { id: string; status: string; partial?: StreamPartial | null };
export function useTurnStream<T extends Turn>(path: string, setTurns: Dispatch<SetStateAction<T[] | null>>, enabled: boolean) {
  const snapshots = useRef(new Map<string, StreamPartial>());
  const merge = useCallback((turns: T[]) => turns.map(turn => {
    if (turn.status !== 'running') { if (turn.status !== 'queued') snapshots.current.delete(turn.id); return turn; }
    return { ...turn, partial: newestPartial(turn.partial, snapshots.current.get(turn.id)) };
  }), []);
  useEffect(() => {
    snapshots.current.clear();
    if (!enabled) return;
    const source = new EventSource(`${path}/stream`);
    source.onmessage = event => {
      let value; try { value = parseTurnSnapshot(JSON.parse(event.data)); } catch { return; }
      if (!value) return;
      snapshots.current.set(value.id, newestPartial(snapshots.current.get(value.id), value.partial)!);
      setTurns(current => current && merge(current));
    };
    // EventSource reconnects read-only; initial persisted snapshots repair any missed delivery.
    return () => source.close();
  }, [path, enabled, merge, setTurns]);
  return merge;
}
