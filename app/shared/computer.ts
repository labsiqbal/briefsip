export type ComputerControl = { mode: 'agent' | 'user'; who: string; since: string; revision: number };
export type ComputerWait = { turn: string; call_id: string; reason: string; state: string };
export type DesktopStatus = { available: boolean; state: 'off' | 'starting' | 'running' | 'idle'; stopsInMs: number | null; width: number; height: number };
