import { useEffect, useRef, useState } from 'react';
type Table = { name: string; owner: string; columns: { name: string; type: string }[] };
type Listing = { tables: Table[]; next_after: string | null; revision: number };
type Pending = { id: string; revision: number; table: string };
const key = 'briefsip:shared-data-drop';
export function SharedDataPanel({ request, onClose, agents }: { agents: { id: string; name: string }[]; request: <T>(path: string, data?: unknown) => Promise<T>; onClose: () => void }) {
  const [listing, setListing] = useState<Listing | null>(null), [after, setAfter] = useState(''), [reload, setReload] = useState(0);
  const [sql, setSQL] = useState(''), [result, setResult] = useState<unknown>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(() => { try { const p = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return p && typeof p.id === 'string' && /^[0-9a-f-]{36}$/i.test(p.id) && typeof p.table === 'string' && p.table.length > 0 && p.table.length <= 128 && Number.isSafeInteger(p.revision) && p.revision >= 0 ? p : null; } catch { return null; } });
  const heading = useRef<HTMLHeadingElement>(null), version = useRef(0);
  useEffect(() => { heading.current?.focus(); return () => { version.current++; }; }, []);
  useEffect(() => {
    const active = ++version.current; setListing(null); setError('');
    void request<Listing>(`/api/data?after=${encodeURIComponent(after)}`).then(value => { if (active === version.current) setListing(value); }).catch(error => { if (active === version.current) setError(error.message); });
    return () => { version.current++; };
  }, [after, reload]);
  async function execute(table?: string) {
    if (busy || !listing) return;
    let command = pending;
    if (table && !command) {
      if (!confirm(`Hapus tabel ${table} beserta seluruh datanya? Tindakan ini tidak dapat dibatalkan.`)) return;
      command = { id: crypto.randomUUID(), revision: listing.revision, table };
      try { sessionStorage.setItem(key, JSON.stringify(command)); } catch { setError('Browser tidak bisa menyimpan ID pemulihan. Penghapusan belum dikirim.'); return; }
      setPending(command);
    }
    const active = ++version.current; setBusy(true); setError('');
    try {
      const value = await request('/api/data/' + (command ? 'drop' : 'query'), command ?? { id: crypto.randomUUID(), revision: listing.revision, sql });
      if (command && JSON.parse(sessionStorage.getItem(key) ?? 'null')?.id === command.id) sessionStorage.removeItem(key);
      if (active !== version.current) return;
      setPending(null); setResult(value); setReload(n => n + 1);
    } catch (error) { if (active === version.current) setError((error as Error).message); }
    finally { if (active === version.current) setBusy(false); }
  }
  return <section className="setup workflow-panel shared-data-panel"><h1 ref={heading} tabIndex={-1}>Data bersama</h1>
    <p>Semua agent dapat membaca dan mengubah baris. Hanya pembuat tabel yang dapat mengubah struktur. Jangan simpan rahasia atau data yang tidak boleh dibagikan.</p>
    <div className="form-actions"><button className="secondary" onClick={onClose}>Kembali ke percakapan</button><button className="secondary" disabled={busy} onClick={() => setReload(n => n + 1)}>Muat ulang data</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    {pending && <div><p className="message-text">Penghapusan {pending.table} belum terkonfirmasi. Coba lagi tidak mengulang penghapusan yang sudah tersimpan.</p><button disabled={busy || !listing} onClick={() => void execute()}>Coba hapus lagi</button><button className="secondary" disabled={busy} onClick={() => { sessionStorage.removeItem(key); setPending(null); setReload(n => n + 1); }}>Tutup pemulihan dan muat ulang</button></div>}
    {!listing ? <p role="status">{error ? 'Data belum tersedia.' : 'Memuat tabel...'}</p> : <>
      {!listing.tables.length && <p>Tidak ada tabel di halaman ini. Minta agent membuat tabel melalui percakapan.</p>}
      {listing.tables.map(table => <details key={table.name}><summary className="message-text">{table.name}</summary><p className="message-text">Pembuat: {agents.find(agent => agent.id === table.owner)?.name ?? table.owner}</p><p className="message-text">{table.columns.map(column => `${column.name}: ${column.type || 'tanpa tipe'}`).join('\n')}</p><button className="secondary" disabled={busy || !!pending} onClick={() => void execute(table.name)}>Hapus tabel {table.name}</button></details>)}
      <div className="form-actions"><button className="secondary" disabled={busy || !after} onClick={() => { setAfter(''); heading.current?.focus(); }}>Halaman pertama</button><button className="secondary" disabled={busy || !listing.next_after} onClick={() => { setAfter(listing.next_after!); heading.current?.focus(); }}>Tabel berikutnya</button></div>
      <label>Query baca saja<textarea rows={4} placeholder={'SELECT * FROM "nama_tabel" LIMIT 50'} value={sql} maxLength={16000} disabled={busy || !!pending} onChange={event => setSQL(event.target.value)} /></label><button disabled={busy || !!pending || !sql.trim()} onClick={() => void execute()}>{busy ? 'Memproses...' : 'Jalankan query baca'}</button>
    </>}
    {result !== null && <details open><summary>Hasil query terakhir</summary><pre className="message-text">{JSON.stringify(result, null, 2)}</pre></details>}
  </section>;
}
