import { useEffect, useRef } from 'react';

type PanelRequest = { seq: number; id: string; name: string; openedAt: string; deleted?: number };
type Turn = { panelFile?: PanelRequest | null };

export function usePanelFileRequests(turns: Turn[] | null, open: (file: PanelRequest) => void) {
  const mountedAt = useRef(Date.now()), seen = useRef(new Set<number>());
  useEffect(() => {
    const requests = (turns ?? []).flatMap(turn => turn.panelFile ? [turn.panelFile] : []);
    const latest = requests.filter(request => !seen.current.has(request.seq) && Date.parse(request.openedAt) >= mountedAt.current).sort((a, b) => a.seq - b.seq).at(-1);
    for (const request of requests) seen.current.add(request.seq);
    if (latest && !latest.deleted) open(latest);
  }, [turns, open]);
}
