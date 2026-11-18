export type ReleaseInfo = { id: string; version: string; notes: string; created: string; commit: string };
export type UpdateAttempt = { id: string; target: string; version: string; status: string; reason?: string; started: string; finished?: string };
export type UpdateState = { current: ReleaseInfo; previous?: ReleaseInfo; available?: ReleaseInfo; feed?: ReleaseInfo; lastAttempt?: UpdateAttempt; launcherAvailable: boolean; runningTurns: number };
