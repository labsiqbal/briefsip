export type PeerAgentSummary = { id: string; name: string; role?: string; model: string; status: string };
export type Environment = { id: string; name: string; version: string; origin?: string };
export type PairedMachine = { id: string; environmentId: string; name: string; origin: string; status: 'online' | 'offline' | 'unauthorized' | 'version-mismatch'; lastSeen: number | null; agentCount: number; agents: PeerAgentSummary[]; pairingState: 'paired' | 'pending'; version: string; allowAgentMessaging: boolean; remoteAgentMessaging?: boolean; allowUpdates: boolean };
