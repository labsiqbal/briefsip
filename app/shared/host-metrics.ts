export type HostMetrics = {
  sampledAt: string;
  platform: string;
  cpu: { scope: 'host'; cores: number; availableParallelism: number; percent: number | null; intervalMs: number | null };
  memory: { total: number | null; available: number | null; source: string };
  process: { rss: number; cpuPercent: number | null; memoryLimit: number | null; availableMemory: number | null; uptimeSeconds: number };
  filesystem: { total: string; available: string; used: string; reserved: string; percent: number; pressure: string } | null;
  storage: { files: { kind: string; status: string; bytes: string | null }[]; databaseBytes: string; reusableBytes: string };
};
