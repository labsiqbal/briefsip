import { useEffect, useState } from 'react';
import type { HostMetrics } from '../host-metrics';
import { Alert, Badge, Card, IconButton, Row, Section } from './ui/kit';
import { RefreshCw } from 'lucide-react';
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
  return <Section title="Machine and storage" actions={<IconButton label="Reload metrics" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden /></IconButton>}>
    <p className="k-field__hint">The host running the Briefsip server, separate from the browser device. Updates every 10 seconds while this panel is visible.</p>
    {error && <Alert tone="error">{error}{metrics ? ' The last readings may have changed.' : ''}</Alert>}
    {!metrics && !error && <Card><Row title="Machine metrics" trailing="Loading..." /></Card>}
    {metrics && <>
      <p className="k-field__hint">Reading {new Date(metrics.sampledAt).toLocaleString('en-US')} · {metrics.platform}</p>
      <Card><Row title="Host CPU" trailing={<>{percent(metrics.cpu.percent, metrics.cpu.cores > 0 && metrics.cpu.intervalMs === null)} · {metrics.cpu.cores} logical cores</>} /><Row title="Briefsip process CPU" trailing={<>{percent(metrics.process.cpuPercent, metrics.cpu.intervalMs === null)} (100% equals one core)</>} /><Row title="Available host memory" trailing={`${bytes(metrics.memory.available)} of ${bytes(metrics.memory.total)}`} /><Row title="Briefsip process memory" trailing={bytes(metrics.process.rss)} /><Row title="OS process memory limit" trailing={metrics.process.memoryLimit === null ? 'Unlimited or unknown' : bytes(metrics.process.memoryLimit)} /><Row title="Memory available to the process" trailing={bytes(metrics.process.availableMemory)} /></Card>
      <p className="k-field__hint">Host CPU is not normalized to container quotas. The OS may limit process memory; filesystem size is not a container quota.</p>
      {metrics.cpu.intervalMs !== null && <p className="k-field__hint">CPU is calculated over {(metrics.cpu.intervalMs / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} seconds between readings.</p>}
      <Section title="Data directory filesystem"><Card>{metrics.filesystem ? <><Row title="Available" trailing={bytes(metrics.filesystem.available)} /><Row title="Used" trailing={`${bytes(metrics.filesystem.used)} · ${metrics.filesystem.percent.toLocaleString('en-US')}% of effective capacity`} /><Row title="Capacity" meta={`Total ${bytes(metrics.filesystem.total)}; ${bytes(metrics.filesystem.reserved)} reserved by the filesystem and excluded from available space.`} trailing={metrics.filesystem.pressure === 'normal' ? <Badge tone="success">Normal</Badge> : <Badge tone="warn">{metrics.filesystem.pressure === 'critical' ? 'Critically low' : 'Almost full'}</Badge>} /></> : <Row title="Filesystem size" trailing="Unavailable" />}</Card>{metrics.filesystem?.pressure !== 'normal' && metrics.filesystem && <Alert tone="error">{metrics.filesystem.pressure === 'critical' ? 'Storage space is critically low.' : 'Storage is almost full.'} Check free space on the host before adding data.</Alert>}</Section>
      <Section title="Briefsip data"><Card><Row title="SQLite database pages" trailing={bytes(metrics.storage.databaseBytes)} /><Row title="Reusable internal space" trailing={bytes(metrics.storage.reusableBytes)} />{metrics.storage.files.map(file => <Row key={file.kind} title={fileNames[file.kind] ?? file.kind} trailing={file.status === 'present' ? bytes(file.bytes) : file.status === 'missing' ? 'File missing' : file.status === 'not-regular' ? 'Not a regular file; not followed' : 'Unreadable'} />)}</Card><p className="k-field__hint">Logical file sizes, not allocated physical blocks. Database pages include data and free internal space; do not add them to file sizes again. Excludes backups and other project directories.</p></Section>
    </>}
  </Section>;
}
