import { useEffect, useRef, useState } from 'react';
type Neighbor = { id: string; agent: string; revision: number; editing: boolean };
type Entry = { previous: Neighbor | null; next: Neighbor | null; id: string; agent: string; text: string; revision: number; paused: number; editing: boolean };
type Command = { id: string; target: string; other: string; revision: number; otherRevision: number };
export function QueuePanel({ path, request, onOpen }: { path: string; request: <T>(path: string, data?: unknown) => Promise<T>; onOpen: (id: string) => void }) {
  const endpoint = path.replace(/\/turns$/, '/queue'), key = `briefsip-queue-order:${endpoint}`;
  const [open, setOpen] = useState(false), [rows, setRows] = useState<Entry[]>([]), [more, setMore] = useState(false), [error, setError] = useState(''), [loadError, setLoadError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const [pages, setPages] = useState<{ after: number; snapshot: string }[]>([]), [nextPage, setNextPage] = useState<{ after: number; snapshot: string } | null>(null), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true);
  const page = pages.at(-1);
  const [recovery] = useState(() => {
    try {
      const saved = sessionStorage.getItem(key); if (!saved) return { pending: null, invalid: false };
      const value = JSON.parse(saved), uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
      if (!value || !['id','target','other'].every(field => typeof value[field] === 'string' && uuid.test(value[field])) || !['revision','otherRevision'].every(field => Number.isSafeInteger(value[field]) && value[field] >= 1)) throw new Error();
      return { pending: value as Command, invalid: false };
    } catch { return { pending: null, invalid: true }; }
  });
  const [pending, setPending] = useState<Command | null>(recovery.pending), [invalid, setInvalid] = useState(recovery.invalid);
  const generation = useRef(0), flight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    if (!open) return; let stopped = false; let timer: ReturnType<typeof setTimeout>;
    async function load() {
      const version = ++generation.current; setLoading(true);
      try { const result = await request<{ turns: Entry[]; more: boolean; next_after: number | null; snapshot: string }>(endpoint + (page ? `?after=${page.after}&snapshot=${page.snapshot}` : '')); if (!stopped && version === generation.current) { setRows(result.turns); setMore(result.more); setNextPage(result.next_after === null ? null : { after: result.next_after, snapshot: result.snapshot }); setLoadError(''); } }
      catch (error) {
        if (!stopped && version === generation.current) {
          if (page && error && typeof error === 'object' && 'status' in error && error.status === 409) { setRows([]); setNextPage(null); setPages([]); setNotice('Antrean berubah. Daftar kembali ke halaman pertama.'); }
          else setLoadError('Antrean belum dimuat. Coba muat ulang.');
        }
      }
      finally { if (!stopped && version === generation.current) setLoading(false); if (!stopped) timer = setTimeout(() => void load(), 1500); }
    }
    void load(); return () => { stopped = true; generation.current++; clearTimeout(timer); };
  }, [open, endpoint, request, refresh, page]);
  async function move(row?: Entry, other?: Neighbor | null) {
    if (flight.current || invalid || (!pending && (!row || !other))) return;
    const command = pending ?? { id: crypto.randomUUID(), target: row!.id, other: other!.id, revision: row!.revision, otherRevision: other!.revision };
    try { sessionStorage.setItem(key, JSON.stringify(command)); setPending(command); } catch { setError('Urutan belum disimpan di browser. Periksa penyimpanan situs.'); return; }
    flight.current = true; setBusy(true); generation.current++;
    try { await request(endpoint, command); if (!mounted.current) return; sessionStorage.removeItem(key); setPending(null); setError(''); setPages([]); setRefresh(value => value + 1); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Urutan belum terkonfirmasi. Coba lagi.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  return <details className="queue-panel" onToggle={event => setOpen(event.currentTarget.open)}><summary>Antrean pesan{pending || invalid ? ' - perlu pemulihan' : ''}</summary>
    <p>Urutan dapat diubah untuk pesan yang belum mulai pada agent yang sama. Riwayat tetap mengikuti waktu pesan diterima.</p>
    <button className="secondary" onClick={() => { generation.current++; setPages([]); setRefresh(value => value + 1); }}>Muat ulang antrean</button>
    {notice && <p role="status">{notice}</p>}
    {loadError && <p role="alert" className="error">{loadError}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {invalid && <p role="alert">Permintaan urutan tersimpan tidak valid.</p>}
    {(pending || invalid) && <div className="form-actions">{pending && <button disabled={busy} onClick={() => void move()}>Coba urutan lagi</button>}<button className="secondary" disabled={busy} onClick={() => { if (!window.confirm('Buang permintaan urutan tersimpan? Perubahan yang sudah diterima server tetap berlaku.')) return; try { sessionStorage.removeItem(key); setPending(null); setInvalid(false); setError(''); setRefresh(value => value + 1); } catch { setError('Penyimpanan browser belum tersedia.'); } }}>Buang permintaan tersimpan</button></div>}
    {loading && <p role="status">Memuat antrean...</p>}
    {!loading && !rows.length && !error && !loadError && <p>Belum ada pesan dalam antrean.</p>}
    <ol>{rows.map(row => <li key={row.id}><p className="message-text">{row.text}</p><p>{row.editing ? 'Sedang diedit' : row.paused ? 'Dijeda' : 'Menunggu giliran'}</p><div className="form-actions"><button className="secondary" onClick={() => onOpen(row.id)}>Buka pesan</button>{[-1,1].map(direction => { const other = direction < 0 ? row.previous : row.next; return <button key={direction} className="secondary" disabled={busy || loading || !!pending || invalid || row.editing || !other || other.agent !== row.agent || other.editing} onClick={() => void move(row, other)}>{direction < 0 ? 'Naik' : 'Turun'}</button>; })}</div></li>)}</ol>
    <div className="form-actions"><button className="secondary" aria-disabled={busy || loading || !pages.length} onClick={() => { if (!busy && !loading && pages.length) { generation.current++; setRows([]); setLoading(true); setPages(values => values.slice(0,-1)); } }}>Antrean sebelumnya</button><button className="secondary" aria-disabled={busy || loading || !more || !nextPage} onClick={() => { if (!busy && !loading && more && nextPage) { generation.current++; setRows([]); setLoading(true); setPages(values => [...values, nextPage]); } }}>Antrean berikutnya</button></div>
  </details>;
}
