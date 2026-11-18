import { usePolling } from './hooks/usePolling';
import { useState } from 'react';
import type { HostMetrics } from '../shared/host-metrics';
import { Alert, Badge, Card, Collapsible, IconButton, Row, Section, Tooltip } from './ui/kit';
import './machines-data.css';
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
  usePolling(async signal => {
    setBusy(true);
    try { const result = await request<HostMetrics>('/api/host-metrics'); if (!signal.aborted) { setMetrics(result); setError(''); } }
    catch (error) { if (!signal.aborted) setError(error instanceof Error ? error.message : 'Host metrics are unavailable.'); }
    finally { if (!signal.aborted) setBusy(false); }
  }, { interval: 10000 }, [refresh, request]);
  return <Section title="System resources" actions={<IconButton label="Reload metrics" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden /></IconButton>}>
    {error && <Alert tone="error">{error}{metrics ? ' Last readings may have changed.' : ''}</Alert>}
    {!metrics && !error && <Card><Row title="System resources" trailing="Loading..." /></Card>}
    {metrics && <>
      <Tooltip content={<span className="bs-root set4-tooltip">{"Server host, separate from the browser. Refreshes every 10 seconds while visible."}</span>}><span className="k-field__hint" tabIndex={0}>{new Date(metrics.sampledAt).toLocaleString('en-US')} · {metrics.platform}</span></Tooltip>
      {metrics.filesystem?.pressure !== 'normal' && metrics.filesystem && <Alert tone="error">{metrics.filesystem.pressure === 'critical' ? 'Storage space is critically low.' : 'Storage is almost full.'} Check free space on the host before adding data.</Alert>}
      <Collapsible title="CPU" defaultOpen><Card>
        <Row title={<Tooltip content={<span className="bs-root set4-tooltip">{`Not normalized to container quotas.${metrics.cpu.intervalMs !== null ? ` Measured over ${(metrics.cpu.intervalMs / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} seconds.` : ''}`}</span>}><span tabIndex={0}>Host CPU</span></Tooltip>} trailing={percent(metrics.cpu.percent, metrics.cpu.cores > 0 && metrics.cpu.intervalMs === null)} />
        <Row title="Logical cores" trailing={metrics.cpu.cores} />
        <Row title={<Tooltip content={<span className="bs-root set4-tooltip">{"100% equals one core"}</span>}><span tabIndex={0}>Briefsip process CPU</span></Tooltip>} trailing={percent(metrics.process.cpuPercent, metrics.cpu.intervalMs === null)} />
      </Card></Collapsible>
      <Collapsible title="Memory"><Card><Row title="Available host memory" trailing={`${bytes(metrics.memory.available)} of ${bytes(metrics.memory.total)}`} /><Row title="Briefsip process memory" trailing={bytes(metrics.process.rss)} /><Row title="OS process memory limit" trailing={metrics.process.memoryLimit === null ? 'Unlimited or unknown' : bytes(metrics.process.memoryLimit)} /><Row title="Memory available to the process" trailing={bytes(metrics.process.availableMemory)} /></Card></Collapsible>
      <Collapsible title="Storage"><Card>{metrics.filesystem ? <><Row title="Available" trailing={bytes(metrics.filesystem.available)} /><Row title={<Tooltip content={<span className="bs-root set4-tooltip">{"Percent of effective capacity, excluding reserved space"}</span>}><span tabIndex={0}>Used</span></Tooltip>} trailing={`${bytes(metrics.filesystem.used)} · ${metrics.filesystem.percent.toLocaleString('en-US')}%`} /><Row title={<Tooltip content={<span className="bs-root set4-tooltip">{`Filesystem size, not a container quota. Total ${bytes(metrics.filesystem.total)}; ${bytes(metrics.filesystem.reserved)} reserved and excluded from available space.`}</span>}><span tabIndex={0}>Capacity</span></Tooltip>} trailing={metrics.filesystem.pressure === 'normal' ? <Badge tone="success">Normal</Badge> : <Badge tone="warn">{metrics.filesystem.pressure === 'critical' ? 'Critically low' : 'Almost full'}</Badge>} /></> : <Row title="Filesystem size" trailing="Unavailable" />}</Card></Collapsible>
      <Collapsible title="Database"><Card><Row title={<Tooltip content={<span className="bs-root set4-tooltip">{"Logical sizes, not allocated blocks. Includes data and free internal space; do not add pages to file sizes. Excludes backups and other project directories."}</span>}><span tabIndex={0}>SQLite database pages</span></Tooltip>} trailing={bytes(metrics.storage.databaseBytes)} /><Row title="Reusable internal space" trailing={bytes(metrics.storage.reusableBytes)} />{metrics.storage.files.map(file => <Row key={file.kind} title={fileNames[file.kind] ?? file.kind} trailing={file.status === 'present' ? bytes(file.bytes) : file.status === 'missing' ? 'File missing' : file.status === 'not-regular' ? 'Not a regular file; not followed' : 'Unreadable'} />)}</Card></Collapsible>
    </>}
  </Section>;
}
