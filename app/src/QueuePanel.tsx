import { useEffect, useRef, useState } from 'react';
type Entry = { id: string; agent: string; text: string; revision: number; paused: number; editing: boolean };
type Command = { id: string; target: string; other: string; revision: number; otherRevision: number };
export function QueuePanel({ path, request, onOpen }: { path: string; request: <T>(path: string, data?: unknown) => Promise<T>; onOpen: (id: string) => void }) {
  const endpoint = path.replace(/\/turns$/, '/queue'), key = `briefsip-queue-order:${endpoint}`;
  const [open, setOpen] = useState(false), [rows, setRows] = useState<Entry[]>([]), [more, setMore] = useState(false), [error, setError] = useState(''), [loadError, setLoadError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
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
      const version = ++generation.current;
      try { const result = await request<{ turns: Entry[]; more: boolean }>(endpoint); if (!stopped && version === generation.current) { setRows(result.turns); setMore(result.more); setLoadError(''); } }
      catch { if (!stopped && version === generation.current) setLoadError('Antrean belum dimuat. Coba muat ulang.'); }
      finally { if (!stopped) timer = setTimeout(() => void load(), 1500); }
    }
    void load(); return () => { stopped = true; generation.current++; clearTimeout(timer); };
  }, [open, endpoint, request, refresh]);
  async function move(row?: Entry, other?: Entry) {
    if (flight.current || invalid || (!pending && (!row || !other))) return;
    const command = pending ?? { id: crypto.randomUUID(), target: row!.id, other: other!.id, revision: row!.revision, otherRevision: other!.revision };
    try { sessionStorage.setItem(key, JSON.stringify(command)); setPending(command); } catch { setError('Urutan belum disimpan di browser. Periksa penyimpanan situs.'); return; }
    flight.current = true; setBusy(true); generation.current++;
    try { await request(endpoint, command); if (!mounted.current) return; sessionStorage.removeItem(key); setPending(null); setError(''); setRefresh(value => value + 1); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Urutan belum terkonfirmasi. Coba lagi.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  return <details className="queue-panel" onToggle={event => setOpen(event.currentTarget.open)}><summary>Antrean pesan{pending || invalid ? ' - perlu pemulihan' : ''}</summary>
    <p>Urutan dapat diubah untuk pesan yang belum mulai pada agent yang sama. Riwayat tetap mengikuti waktu pesan diterima.</p>
    <button className="secondary" onClick={() => setRefresh(value => value + 1)}>Muat ulang antrean</button>
    {loadError && <p role="alert" className="error">{loadError}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {invalid && <p role="alert">Permintaan urutan tersimpan tidak valid.</p>}
    {(pending || invalid) && <div className="form-actions">{pending && <button disabled={busy} onClick={() => void move()}>Coba urutan lagi</button>}<button className="secondary" disabled={busy} onClick={() => { if (!window.confirm('Buang permintaan urutan tersimpan? Perubahan yang sudah diterima server tetap berlaku.')) return; try { sessionStorage.removeItem(key); setPending(null); setInvalid(false); setError(''); setRefresh(value => value + 1); } catch { setError('Penyimpanan browser belum tersedia.'); } }}>Buang permintaan tersimpan</button></div>}
    {!rows.length && !error && !loadError && <p>Belum ada pesan dalam antrean.</p>}
    <ol>{rows.map((row, index) => <li key={row.id}><p className="message-text">{row.text}</p><p>{row.editing ? 'Sedang diedit' : row.paused ? 'Dijeda' : 'Menunggu giliran'}</p><div className="form-actions"><button className="secondary" onClick={() => onOpen(row.id)}>Buka pesan</button>{[-1,1].map(direction => { const other = direction < 0 ? rows.slice(0, index).findLast(item => item.agent === row.agent) : rows.slice(index + 1).find(item => item.agent === row.agent); return <button key={direction} className="secondary" disabled={busy || !!pending || invalid || row.editing || !other || other.agent !== row.agent || other.editing} onClick={() => void move(row, other)}>{direction < 0 ? 'Naik' : 'Turun'}</button>; })}</div></li>)}</ol>
    {more && <p>Menampilkan 100 pesan pertama. Pesan berikutnya muncul setelah antrean berkurang.</p>}
  </details>;
}
