import { useEffect, useState } from 'react';
import type { HostMetrics } from '../host-metrics';
const bytes = (value: string | number | null) => {
  if (value === null) return 'Unavailable';
  const size = BigInt(value), units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']; let scale = 1n, unit = 0;
  while (unit < units.length - 1 && size >= scale * 1024n) { scale *= 1024n; unit++; }
  return `${(Number(size * 10n / scale) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })} ${units[unit]}`;
};
const percent = (value: number | null, pending: boolean) => value === null ? (pending ? 'Waiting for two readings' : 'Unavailable') : `${value.toLocaleString('en-US')}%`;
const fileNames: Record<string, string> = { database: 'Database', wal: 'WAL journal', 'shared-memory': 'SQLite shared memory', 'rollback-journal': 'Rollback journal', 'mcp-key': 'MCP keys' };
export function HostMetricsSection({ request }: { request: <T>(path: string) => Promise<T> }) {
  const [metrics, setMetrics] = useState<HostMetrics | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    async function load() {
      if (document.visibilityState === 'hidden') { timer = setTimeout(() => void load(), 10000); return; }
      setBusy(true);
      try { const result = await request<HostMetrics>('/api/host-metrics'); if (!stopped) { setMetrics(result); setError(''); } }
      catch (error) { if (!stopped) setError(error instanceof Error ? error.message : 'Host metrics are unavailable.'); }
      finally { if (!stopped) { setBusy(false); timer = setTimeout(() => void load(), 10000); } }
    }
    void load(); return () => { stopped = true; clearTimeout(timer); };
  }, [refresh, request]);
  return <section className="host-metrics" aria-labelledby="host-metrics-title"><h2 id="host-metrics-title">Machine and storage</h2>
    <p>The host running the Briefsip server, separate from the browser device. Updates every 10 seconds while this panel is visible.</p>
    <button className="secondary" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{busy ? 'Loading metrics...' : 'Reload metrics'}</button>
    {error && <p className="error" role="alert">{error}{metrics ? ' The last readings may have changed.' : ''}</p>}
    {metrics && <><p className="muted">Reading {new Date(metrics.sampledAt).toLocaleString('en-US')} · {metrics.platform}</p>
      <dl><dt>Host CPU</dt><dd>{percent(metrics.cpu.percent, metrics.cpu.cores > 0 && metrics.cpu.intervalMs === null)} · {metrics.cpu.cores} logical cores</dd><dt>Briefsip process CPU</dt><dd>{percent(metrics.process.cpuPercent, metrics.cpu.intervalMs === null)} (100% equals one core)</dd><dt>Available host memory</dt><dd>{bytes(metrics.memory.available)} of {bytes(metrics.memory.total)}</dd><dt>Briefsip process memory</dt><dd>{bytes(metrics.process.rss)}</dd><dt>OS process memory limit</dt><dd>{metrics.process.memoryLimit === null ? 'Unlimited or unknown' : bytes(metrics.process.memoryLimit)}</dd><dt>Memory available to the process</dt><dd>{bytes(metrics.process.availableMemory)}</dd></dl>
      <p className="muted">Host CPU is not normalized to container quotas. The OS may limit process memory; filesystem size is not a container quota.</p>
      {metrics.cpu.intervalMs !== null && <p className="muted">CPU is calculated over {(metrics.cpu.intervalMs / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} seconds between readings.</p>}
      {metrics.filesystem ? <><h3>Data directory filesystem</h3><p>{bytes(metrics.filesystem.available)} available · {bytes(metrics.filesystem.used)} used · {metrics.filesystem.percent.toLocaleString('en-US')}% of effective capacity used</p><p className="muted">Total {bytes(metrics.filesystem.total)}; {bytes(metrics.filesystem.reserved)} reserved by the filesystem and excluded from available space.</p>{metrics.filesystem.pressure !== 'normal' && <p className="error" role="status">{metrics.filesystem.pressure === 'critical' ? 'Storage space is critically low.' : 'Storage is almost full.'} Check free space on the host before adding data.</p>}</> : <p>Filesystem size is unavailable.</p>}
      <h3>Briefsip data</h3><dl><dt>SQLite database pages</dt><dd>{bytes(metrics.storage.databaseBytes)}</dd><dt>Reusable internal space</dt><dd>{bytes(metrics.storage.reusableBytes)}</dd></dl><dl>{metrics.storage.files.map(file => <div key={file.kind}><dt>{fileNames[file.kind] ?? file.kind}</dt><dd>{file.status === 'present' ? bytes(file.bytes) : file.status === 'missing' ? 'File missing' : file.status === 'not-regular' ? 'Not a regular file; not followed' : 'Unreadable'}</dd></div>)}</dl>
      <p className="muted">Logical file sizes, not allocated physical blocks. Database pages include data and free internal space; do not add them to file sizes again. Excludes backups and other project directories.</p>
    </>}
  </section>;
}
