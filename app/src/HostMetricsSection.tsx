import { useEffect, useState } from 'react';
import type { HostMetrics } from '../host-metrics';
const bytes = (value: string | number | null) => {
  if (value === null) return 'Tidak tersedia';
  const size = BigInt(value), units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']; let scale = 1n, unit = 0;
  while (unit < units.length - 1 && size >= scale * 1024n) { scale *= 1024n; unit++; }
  return `${(Number(size * 10n / scale) / 10).toLocaleString('id-ID', { maximumFractionDigits: 1 })} ${units[unit]}`;
};
const percent = (value: number | null, pending: boolean) => value === null ? (pending ? 'Menunggu dua pembacaan' : 'Tidak tersedia') : `${value.toLocaleString('id-ID')}%`;
const fileNames: Record<string, string> = { database: 'Database', wal: 'Journal WAL', 'shared-memory': 'Shared memory SQLite', 'rollback-journal': 'Rollback journal', 'mcp-key': 'Kunci MCP' };
export function HostMetricsSection({ request }: { request: <T>(path: string) => Promise<T> }) {
  const [metrics, setMetrics] = useState<HostMetrics | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    async function load() {
      if (document.visibilityState === 'hidden') { timer = setTimeout(() => void load(), 10000); return; }
      setBusy(true);
      try { const result = await request<HostMetrics>('/api/host-metrics'); if (!stopped) { setMetrics(result); setError(''); } }
      catch (error) { if (!stopped) setError(error instanceof Error ? error.message : 'Metrik host belum tersedia.'); }
      finally { if (!stopped) { setBusy(false); timer = setTimeout(() => void load(), 10000); } }
    }
    void load(); return () => { stopped = true; clearTimeout(timer); };
  }, [refresh, request]);
  return <section className="host-metrics" aria-labelledby="host-metrics-title"><h2 id="host-metrics-title">Mesin dan penyimpanan</h2>
    <p>Host tempat server Briefsip berjalan, bukan perangkat browser. Diperbarui setiap 10 detik selama panel terlihat.</p>
    <button className="secondary" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{busy ? 'Memuat metrik...' : 'Muat ulang metrik'}</button>
    {error && <p className="error" role="alert">{error}{metrics ? ' Angka terakhir mungkin sudah berubah.' : ''}</p>}
    {metrics && <><p className="muted">Pembacaan {new Date(metrics.sampledAt).toLocaleString('id-ID')} · {metrics.platform}</p>
      <dl><dt>CPU seluruh host</dt><dd>{percent(metrics.cpu.percent, metrics.cpu.cores > 0 && metrics.cpu.intervalMs === null)} · {metrics.cpu.cores} core logis</dd><dt>CPU proses Briefsip</dt><dd>{percent(metrics.process.cpuPercent, metrics.cpu.intervalMs === null)} (100% setara satu core)</dd><dt>Memori host tersedia</dt><dd>{bytes(metrics.memory.available)} dari {bytes(metrics.memory.total)}</dd><dt>Memori proses Briefsip</dt><dd>{bytes(metrics.process.rss)}</dd><dt>Batas memori proses dari OS</dt><dd>{metrics.process.memoryLimit === null ? 'Tidak dibatasi atau tidak diketahui' : bytes(metrics.process.memoryLimit)}</dd><dt>Memori tersedia bagi proses</dt><dd>{bytes(metrics.process.availableMemory)}</dd></dl>
      <p className="muted">CPU host tidak dinormalisasi terhadap kuota container. Memori proses dapat dibatasi OS; ukuran filesystem bukan kuota container.</p>
      {metrics.cpu.intervalMs !== null && <p className="muted">CPU dihitung dari selang {(metrics.cpu.intervalMs / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} detik antar pembacaan.</p>}
      {metrics.filesystem ? <><h3>Filesystem folder data</h3><p>{bytes(metrics.filesystem.available)} tersedia · {bytes(metrics.filesystem.used)} terpakai · {metrics.filesystem.percent.toLocaleString('id-ID')}% kapasitas efektif terpakai</p><p className="muted">Total {bytes(metrics.filesystem.total)}; {bytes(metrics.filesystem.reserved)} dicadangkan filesystem dan tidak dihitung sebagai ruang tersedia.</p>{metrics.filesystem.pressure !== 'normal' && <p className="error" role="status">{metrics.filesystem.pressure === 'critical' ? 'Ruang penyimpanan kritis.' : 'Ruang penyimpanan hampir penuh.'} Periksa ruang kosong pada host sebelum menambah data.</p>}</> : <p>Ukuran filesystem tidak tersedia.</p>}
      <h3>Data Briefsip</h3><dl><dt>Halaman database SQLite</dt><dd>{bytes(metrics.storage.databaseBytes)}</dd><dt>Ruang internal yang dapat dipakai ulang</dt><dd>{bytes(metrics.storage.reusableBytes)}</dd></dl><dl>{metrics.storage.files.map(file => <div key={file.kind}><dt>{fileNames[file.kind] ?? file.kind}</dt><dd>{file.status === 'present' ? bytes(file.bytes) : file.status === 'missing' ? 'File tidak ada' : file.status === 'not-regular' ? 'Bukan file reguler; tidak diikuti' : 'Tidak dapat dibaca'}</dd></div>)}</dl>
      <p className="muted">Ukuran file logis, bukan blok fisik yang dialokasikan. Halaman database mencakup data dan ruang internal kosong; jangan menjumlahkannya lagi dengan ukuran file. Tidak mencakup backup atau folder proyek lain.</p>
    </>}
  </section>;
}
