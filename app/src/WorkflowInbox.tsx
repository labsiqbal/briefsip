import { useEffect, useRef, useState } from 'react';

type Notice = { seq: number; run: string; name: string; created: string; read: number };
type Page = { notifications: Notice[]; next_before: number | null; unread: number };
export function WorkflowInbox({ request, onBack }: {
  request: <T>(path: string, data?: unknown) => Promise<T>; onBack: () => void;
}) {
  const [page, setPage] = useState<Page | null>(null), [cursors, setCursors] = useState<number[]>([]);
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ name: string; last: string } | null>(null);
  const [busy, setBusy] = useState(false), [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState('Notification' in window ? Notification.permission : 'unsupported');
  const heading = useRef<HTMLHeadingElement>(null), version = useRef(0), seen = useRef<number | null>(null);
  const before = cursors.at(-1);
  useEffect(() => { heading.current?.focus(); }, [result, before]);
  useEffect(() => () => { version.current++; }, []);
  // ponytail: inbox-only delivery; use push infrastructure for notifications after closing the app.
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    setPage(null); setError('');
    async function load() {
      try {
        const [data, latest] = await Promise.all([
          request<Page>(`/api/workflow-notifications${before ? `?before=${before}` : ''}`),
          before && enabled ? request<Page>('/api/workflow-notifications') : Promise.resolve(null),
        ]);
        if (stopped) return;
        setPage(data); setError('');
        if (!before || latest) {
          const current = latest ?? data, newest = current.notifications[0]?.seq ?? 0;
          if (enabled && seen.current !== null && newest > seen.current && Notification.permission === 'granted') {
            const count = current.notifications.filter(item => item.seq > seen.current! && !item.read).length;
            if (count) {
              try { new Notification('Hasil workflow tersedia', { body: 'Buka inbox Briefsip untuk membaca hasil.', tag: 'briefsip-workflow-results' }); }
              catch { setEnabled(false); setError('Notifikasi browser tidak tersedia. Hasil tetap tersimpan di inbox.'); }
            }
          }
          seen.current = newest;
        }
      } catch (error) { if (!stopped) setError(error instanceof Error ? error.message : 'Inbox gagal dimuat. Coba lagi.'); }
      finally { if (!stopped) timer = setTimeout(load, 5000); }
    }
    void load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [before, refresh, enabled]);
  async function open(item: Notice) {
    if (busy) return;
    const current = ++version.current; setBusy(true); setError('');
    try {
      const run = await request<{ last: string }>(`/api/workflow-runs/${item.run}`);
      if (current !== version.current) return;
      await request(`/api/workflow-notifications/${item.run}/read`, { id: crypto.randomUUID() });
      if (current !== version.current) return;
      setResult({ name: item.name, last: run.last }); setRefresh(value => value + 1);
    } catch (error) { if (current === version.current) setError(error instanceof Error ? error.message : 'Hasil gagal dibuka. Coba lagi.'); }
    finally { if (current === version.current) setBusy(false); }
  }
  return <section className="setup workflow-panel"><h1 ref={heading} tabIndex={-1}>{result ? result.name : 'Inbox workflow'}</h1>
    <div className="form-actions routine-actions"><button className="secondary" onClick={onBack}>Kembali ke workflow</button>{result && <button className="secondary" onClick={() => setResult(null)}>Kembali ke inbox</button>}</div>
    {error && <p className="error" role="alert">{error}</p>}
    {result ? <p className="message-text">{result.last || 'Workflow selesai tanpa teks hasil.'}</p> : <>
      <p>Hasil tersimpan di server. Notifikasi browser hanya untuk hasil baru selama inbox ini terbuka; isi hasil tidak ditampilkan di notifikasi.</p>
      <button className="secondary" disabled={permission === 'unsupported' || permission === 'denied'} onClick={async () => {
        if (enabled) { setEnabled(false); return; }
        try { const value = await Notification.requestPermission(); setPermission(value); setEnabled(value === 'granted'); }
        catch { setError('Izin notifikasi gagal diminta. Periksa pengaturan browser.'); }
      }}>{enabled ? 'Matikan notifikasi browser' : 'Aktifkan notifikasi browser'}</button>
      {permission === 'unsupported' && <p>Browser ini tidak mendukung notifikasi.</p>}{permission === 'denied' && <p>Notifikasi diblokir. Ubah izin situs melalui pengaturan browser.</p>}
      <button className="secondary" onClick={() => setRefresh(value => value + 1)}>Muat ulang inbox</button>
      {page ? <><p>{page.unread} hasil belum dibaca</p><ul className="routine-list">{page.notifications.map(item => <li key={item.run}><h2>{item.name}</h2><p>{new Date(item.created).toLocaleString()} · {item.read ? 'Sudah dibaca' : 'Belum dibaca'}</p><button className="secondary" disabled={busy} onClick={() => void open(item)}>Buka hasil {item.name}</button></li>)}</ul>{!page.notifications.length && <p>Belum ada hasil pada halaman ini.</p>}</> : !error && <p role="status">Memuat inbox...</p>}
      <div className="form-actions routine-actions"><button className="secondary" disabled={!cursors.length || busy} onClick={() => setCursors(value => value.slice(0, -1))}>Hasil lebih baru</button><button className="secondary" disabled={!page?.next_before || busy} onClick={() => { if (page?.next_before) setCursors(value => [...value, page.next_before!]); }}>Hasil lebih lama</button></div>
    </>}
  </section>;
}
