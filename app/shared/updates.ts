export type UpdateSource = 'GitHub' | 'Local feed';
export type ReleaseInfo = { id: string; version: string; notes: string; created: string; commit: string; source?: UpdateSource };
export type UpdateDownload = { source?: UpdateSource | null; bytesTransferred?: number; totalBytes?: number | null };
export type UpdateAttempt = UpdateDownload & { id: string; target: string; version: string; status: string; reason?: string; started: string; finished?: string };
export type UpdateState = { current: ReleaseInfo; previous?: ReleaseInfo; available?: ReleaseInfo; feed?: ReleaseInfo; github?: ReleaseInfo; githubError?: string; lastAttempt?: UpdateAttempt; launcherAvailable: boolean; runningTurns: number };
