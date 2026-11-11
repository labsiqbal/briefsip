import { useEffect, useRef, useState } from 'react';
type Summary = { version: string; through: number; summary: string; source_count: number; sources: { id: string; seq: number; status: string }[]; next_after: number | null };
export function CompactionPanel({ path, request }: { path: string; request: <T>(path: string) => Promise<T> }) {
  const [open, setOpen] = useState(false), [data, setData] = useState<Summary | null>(null), [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  const [pages, setPages] = useState<number[]>([]), [refresh, setRefresh] = useState(0), after = pages.at(-1) ?? 0;
  const heading = useRef<HTMLHeadingElement>(null), focusPage = useRef(false);
  useEffect(() => { if (loaded && focusPage.current) { heading.current?.focus(); focusPage.current = false; } }, [loaded]);
  useEffect(() => {
    if (!open) return;
    let stopped = false; setLoaded(false); setError('');
    void request<Summary | null>(`${path}?after=${after}`).then(value => { if (!stopped) { setData(value); setLoaded(true); } }).catch(error => { if (!stopped) setError(error instanceof TypeError ? 'Ringkasan belum termuat. Coba muat ulang.' : error.message); });
    return () => { stopped = true; };
  }, [open, after, refresh, path]);
  return <details className="conversation-files" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>Ringkasan riwayat</summary>
    {open && <><p>Pesan lama diringkas bertahap dengan provider; panggilan tambahan tercatat di Pemakaian. Riwayat asli tetap utuh. Ringkasan bisa melewatkan detail; periksa pesan sumber untuk keputusan penting.</p>
      <button className="secondary" onClick={() => setRefresh(n => n + 1)}>Muat ulang ringkasan</button>
      {error ? <p role="alert">{error}</p> : !loaded ? <p role="status">Memuat ringkasan...</p> : !data ? <p>Belum ada ringkasan yang valid. Jawaban tetap memakai riwayat terbaru.</p> : <><p>{data.source_count} pesan sumber, sampai posisi eksekusi {data.through}. Urutan penerimaan pesan tetap ditampilkan pada daftar sumber.</p><pre>{data.summary}</pre><details open><summary>Sumber pesan</summary><h2 ref={heading} tabIndex={-1}>Daftar sumber</h2><ul>{data.sources.map(source => <li key={source.id}><span>Urutan {source.seq} · {source.status}</span><code>{source.id}</code></li>)}</ul><div className="form-actions routine-actions"><button className="secondary" disabled={!pages.length} onClick={() => { focusPage.current = true; setPages(v => v.slice(0, -1)); }}>Sumber sebelumnya</button><button className="secondary" disabled={!data.next_after} onClick={() => { focusPage.current = true; setPages(v => [...v, data.next_after!]); }}>Sumber berikutnya</button></div></details></>}
    </>}
  </details>;
}
