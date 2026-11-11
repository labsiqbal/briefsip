import { useEffect, useRef, useState, type FormEvent } from 'react';
import { siteCommand } from '../site-command';

type Site = { id: string; name: string; source: string; revision: number; deleted: number };
type Page = { sites: Site[]; next_after: string | null };
type Command = ReturnType<typeof siteCommand>;
export function SitesPanel({ agent, request }: { agent: string; request: <T>(path: string, data?: unknown) => Promise<T> }) {
  const path = `/api/agents/${agent}/sites`, key = `briefsip-sites:${agent}`;
  const [open, setOpen] = useState(false), [page, setPage] = useState<Page | null>(null), [cursors, setCursors] = useState(['']);
  const [editing, setEditing] = useState<Site | null>(null), [name, setName] = useState(''), [source, setSource] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState<Command | null>(null), [invalid, setInvalid] = useState(false);
  const [reload, setReload] = useState(0), [notice, setNotice] = useState(''), [confirmed, setConfirmed] = useState(false);
  const generation = useRef(0), heading = useRef<HTMLHeadingElement>(null), nameInput = useRef<HTMLInputElement>(null);
  const after = cursors.at(-1)!;
  const failure = (reason: unknown) => reason instanceof TypeError ? 'Koneksi terputus. Coba lagi dengan permintaan yang sama.' : reason instanceof Error ? reason.message : 'Situs belum dapat dimuat. Coba lagi.';
  useEffect(() => {
    try { const stored = sessionStorage.getItem(key); if (stored) { setPending(siteCommand(JSON.parse(stored))); setOpen(true); } }
    catch { setInvalid(true); setOpen(true); }
    return () => { generation.current++; };
  }, [key]);
  useEffect(() => {
    if (!open) return;
    let stopped = false; setPage(null); heading.current?.focus();
    void request<Page>(`${path}?after=${after}`).then(value => { if (!stopped) setPage(value); }).catch(reason => { if (!stopped) setError(failure(reason)); });
    return () => { stopped = true; };
  }, [open, path, after, reload, request]);
  useEffect(() => { if (editing && !busy && !pending) nameInput.current?.focus(); }, [editing, busy, pending]);
  function reset() { generation.current++; setEditing(null); setName(''); setSource(''); setConfirmed(false); setError(''); nameInput.current?.focus(); }
  async function edit(id: string) {
    const version = ++generation.current; setBusy(true); setError('');
    try { const value = await request<Site>(`${path}/${id}`); if (generation.current !== version) return; if (value.deleted) throw new Error('Situs sudah dihapus. Muat ulang daftar.'); setEditing(value); setName(value.name); setSource(value.source); setConfirmed(false); }
    catch (reason) { if (generation.current === version) setError(failure(reason)); }
    finally { if (generation.current === version) setBusy(false); }
  }
  async function save(event?: FormEvent, deleting = false) {
    event?.preventDefault(); if (busy || invalid || deleting && !confirmed) return;
    const version = generation.current; setError(''); setNotice(''); setBusy(true);
    try {
      const command = pending ?? siteCommand({ id: crypto.randomUUID(), ...(editing ? { site: editing.id, revision: editing.revision } : {}), ...(deleting ? { delete: true } : { name, source }) });
      sessionStorage.setItem(key, JSON.stringify(command)); setPending(command);
      const result = await request<Site>(path, command);
      if (sessionStorage.getItem(key) === JSON.stringify(command)) sessionStorage.removeItem(key);
      if (version !== generation.current) return;
      setPending(null); reset(); setNotice(result.deleted ? 'Situs sudah dihapus.' : 'Situs tersimpan. Buka tautan pada daftar untuk melihat hasilnya.'); setReload(value => value + 1);
    } catch (reason) { if (version === generation.current) setError(failure(reason)); }
    finally { if (version === generation.current || version + 1 === generation.current) setBusy(false); }
  }
  function discard() {
    if (!confirm('Perubahan mungkin sudah tersimpan. Buang pemulihan, lalu periksa daftar situs sebelum membuat perubahan baru?')) return;
    try { sessionStorage.removeItem(key); setPending(null); setInvalid(false); reset(); setReload(value => value + 1); }
    catch { setError('Pemulihan belum dapat dibersihkan. Periksa penyimpanan browser.'); }
  }
  return <section className="local-sites">
    <button type="button" className="secondary" aria-expanded={open} onClick={() => setOpen(value => !value)}>Situs lokal</button>
    {open && <><h2 ref={heading} tabIndex={-1}>Situs lokal agent</h2>
      <p className="muted">Halaman HTML dengan tautan tetap di server lokal ini. Hanya teks, tabel, dan gaya inline yang didukung. Script, formulir, gambar, dan koneksi luar dibuang. Bukan publikasi internet.</p>
      {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      {(pending || invalid) && <div><p className="notice">{invalid ? 'Data pemulihan tidak dapat dibaca. Periksa daftar situs sebelum membuangnya.' : 'Perubahan belum terkonfirmasi. Retry memakai isi dan ID yang sama.'}</p><div className="form-actions">{pending && <button type="button" disabled={busy} onClick={() => void save()}>Coba perubahan lagi</button>}<button type="button" className="secondary" disabled={busy} onClick={discard}>Buang pemulihan</button></div></div>}
      <button type="button" className="secondary" onClick={() => { setError(''); setReload(value => value + 1); }}>Muat ulang situs</button>
      {!page ? <p role="status">Memuat situs...</p> : !page.sites.length ? <p>Belum ada situs pada halaman ini.</p> : <ul className="site-list">{page.sites.map(site => <li key={site.id}><a href={`/sites/${site.id}`} target="_blank" rel="noopener noreferrer">Buka {site.name}</a><button type="button" className="secondary" disabled={busy || !!pending || invalid} onClick={() => void edit(site.id)}>Edit {site.name}</button></li>)}</ul>}
      <div className="form-actions"><button type="button" className="secondary" disabled={cursors.length < 2} onClick={() => setCursors(values => values.slice(0,-1))}>Situs sebelumnya</button><button type="button" className="secondary" disabled={!page?.next_after} onClick={() => setCursors(values => [...values, page!.next_after!])}>Situs berikutnya</button></div>
      <form onSubmit={event => void save(event)}><h3>{editing ? 'Ganti isi situs' : 'Situs baru'}</h3>
        <label>Nama situs<input ref={nameInput} required maxLength={80} value={name} disabled={busy || !!pending || invalid} onChange={event => setName(event.target.value)} /></label>
        <label>Isi HTML<textarea required rows={8} maxLength={262144} value={source} disabled={busy || !!pending || invalid} onChange={event => setSource(event.target.value)} /></label>
        <div className="form-actions"><button disabled={busy || !!pending || invalid}>{busy ? 'Menyimpan...' : editing ? 'Simpan pengganti' : 'Buat situs lokal'}</button>{editing && <button type="button" className="secondary" disabled={busy || !!pending || invalid} onClick={reset}>Batal edit</button>}</div>
        {editing && <><label className="member-option"><input type="checkbox" checked={confirmed} disabled={busy || !!pending || invalid} onChange={event => setConfirmed(event.target.checked)} />Saya mengerti tautan situs tidak bisa dibuka setelah dihapus</label><button type="button" className="secondary" disabled={!confirmed || busy || !!pending || invalid} onClick={() => void save(undefined, true)}>Hapus situs</button></>}
      </form>
    </>}
  </section>;
}
