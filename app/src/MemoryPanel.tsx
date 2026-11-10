import { useEffect, useRef, useState } from 'react';
import { memoryCommand, memoryDraft, type MemoryCommand, type MemoryDraft, type MemoryEntry } from '../memory-command.ts';

type Entry = MemoryEntry;
type Page = { items: Entry[]; next_after: string | null };
export function MemoryPanel({ path, channel, archived, request, onClose }: { path: string; channel: boolean; archived: boolean; request: <T>(path: string, data?: unknown) => Promise<T>; onClose: () => void }) {
  const key = `briefsip:memory:${path}`;
  const draftKey = `${key}:draft`;
  const [recovery] = useState(() => {
    try { const raw = sessionStorage.getItem(key), draft = sessionStorage.getItem(draftKey); return { pending: raw ? memoryCommand(JSON.parse(raw)) : null, draft: draft ? memoryDraft(JSON.parse(draft)) : null, error: '' }; }
    catch { return { pending: null, draft: null, error: 'Perubahan tersimpan tidak terbaca. Buang pemulihan untuk melanjutkan.' }; }
  });
  const [pending, setPending] = useState<MemoryCommand | null>(recovery.pending), [blocked, setBlocked] = useState(recovery.error);
  const [page, setPage] = useState<Page | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [cursors, setCursors] = useState<string[]>([]), [refresh, setRefresh] = useState(0);
  const [entry, setEntry] = useState<Entry | null>(recovery.draft?.entry ?? null), [text, setText] = useState(recovery.draft?.text ?? ''), [essential, setEssential] = useState(recovery.draft?.essential ?? false), [busy, setBusy] = useState(false);
  const mounted = useRef(false), generation = useRef(0), sending = useRef(false), heading = useRef<HTMLHeadingElement>(null), editor = useRef<HTMLTextAreaElement>(null);
  const [draftStored, setDraftStored] = useState(true);
  const after = cursors.at(-1) ?? '', locked = !!pending || !!blocked || busy || archived;
  const dirty = text !== (entry?.text ?? '') || essential !== !!entry?.essential;
  useEffect(() => { mounted.current = true; heading.current?.focus(); return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    const version = ++generation.current; setPage(null); setError('');
    void request<Page>(`${path}?${new URLSearchParams({ query: search, after })}`).then(value => { if (mounted.current && generation.current === version) setPage(value); }).catch(error => { if (mounted.current && generation.current === version) setError(error instanceof TypeError ? 'Memori belum termuat. Coba muat ulang.' : error.message); });
    return () => { generation.current++; };
  }, [after, search, refresh]);
  function draft(value: MemoryDraft) {
    try { sessionStorage.setItem(draftKey, JSON.stringify(value)); setDraftStored(true); }
    catch { setDraftStored(false); setError('Draft belum tersimpan di browser. Jangan pindah halaman sebelum menyalin teks.'); }
    setEntry(value.entry); setText(value.text); setEssential(value.essential);
  }
  function clear() { sessionStorage.removeItem(draftKey); setEntry(null); setText(''); setEssential(false); }
  function choose(value: Entry | null) {
    if (locked || dirty && !window.confirm('Buang perubahan catatan yang belum disimpan?')) return;
    draft({ entry: value, text: value?.text ?? '', essential: !!value?.essential }); editor.current?.focus();
  }
  function discard() {
    if (!window.confirm('Hapus data pemulihan? Perubahan mungkin sudah tersimpan di server. Periksa daftar sebelum membuat perubahan baru.')) return;
    try { sessionStorage.removeItem(key); setPending(null); setBlocked(''); setError(''); setNotice('Draft dipertahankan. Untuk konflik revisi, pilih Edit catatan dari daftar terbaru.'); if (blocked) clear(); setRefresh(n => n + 1); }
    catch { setError('Data pemulihan belum bisa dihapus. Periksa penyimpanan browser.'); }
  }
  async function save(remove = false) {
    if (sending.current || archived && !pending || blocked) return;
    if (!pending && remove && (!entry || !window.confirm('Hapus catatan memori ini? Riwayat percakapan dan backup tetap menyimpan salinan sebelumnya.'))) return;
    let command;
    try {
      command = pending ?? memoryCommand({ id: crypto.randomUUID(), entry: entry?.id ?? crypto.randomUUID(), revision: entry?.revision ?? 0, text: remove ? '' : text, essential: remove ? false : essential, remove });
      sessionStorage.setItem(key, JSON.stringify(command));
    } catch (error) { setError(error instanceof Error ? error.message : 'Perubahan belum bisa disimpan di browser.'); return; }
    sending.current = true; generation.current++; setPending(command); setBusy(true); setError(''); setNotice('');
    try {
      await request(path, command);
      if (!mounted.current) return;
      clear(); sessionStorage.removeItem(key); setPending(null); setNotice('Perubahan tersimpan.'); setRefresh(n => n + 1); heading.current?.focus();
    } catch (error) {
      if (mounted.current && error && typeof error === 'object' && 'status' in error && [400, 413].includes(Number(error.status))) {
        try { sessionStorage.removeItem(key); setPending(null); } catch { /* Keep exact retry if recovery storage cannot be cleared. */ }
      }
      if (mounted.current) setError(error instanceof TypeError ? 'Hasil simpan belum diketahui. Coba lagi dengan perubahan yang sama.' : error instanceof Error ? error.message : 'Perubahan belum terkonfirmasi. Coba lagi.');
    } finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  return <section className="setup workflow-panel"><h1 ref={heading} tabIndex={-1}>Memori {channel ? 'channel' : 'agent'}</h1>
    <p>{channel ? 'Dipakai anggota saat menjawab di channel ini. Memori pribadi agent tidak ikut disertakan.' : 'Dipakai agent di chat utama dan seluruh percakapan sampingnya. Tidak disertakan dalam channel.'} Catatan dikirim ke provider saat disertakan atau dicari. Agent dapat menambah atau mengedit isi catatan, tetapi tidak mengubah pilihan konteks atau menghapus catatan. Perubahan yang sudah tersimpan tetap ada meski tugas dibatalkan. Muat ulang untuk melihat perubahan terbaru.</p>
    <div className="form-actions routine-actions"><button className="secondary" onClick={() => { if (draftStored || window.confirm('Draft belum tersimpan di browser. Keluar dan buang perubahan?')) onClose(); }}>Kembali ke percakapan</button><button className="secondary" disabled={busy} onClick={() => setRefresh(n => n + 1)}>Muat ulang memori</button></div>
    {archived && <p>Channel diarsipkan. Pulihkan channel untuk mengubah memori.</p>}
    {(blocked || error) && <p role="alert" className="error">{blocked || error}</p>}{notice && <p role="status">{notice}</p>}
    {(pending || blocked) && <div><p>Perubahan menunggu konfirmasi. Retry memakai data yang sama.</p>{pending && <p className="message-text">{pending.remove ? 'Hapus catatan' : pending.text}</p>}<div className="form-actions routine-actions">{pending && <button disabled={busy} onClick={() => void save()}>Coba simpan lagi</button>}<button className="secondary" disabled={busy} onClick={discard}>Buang pemulihan dan muat ulang</button></div></div>}
    <form onSubmit={event => { event.preventDefault(); if (!locked) void save(); }}>
      <h2>{entry ? 'Edit catatan' : 'Catatan baru'}</h2><label>Isi memori<textarea ref={editor} maxLength={2000} required value={text} disabled={locked} onChange={event => draft({ entry, text: event.target.value, essential })} /></label>
      <label className="member-option"><input type="checkbox" checked={essential} disabled={locked} onChange={event => draft({ entry, text, essential: event.target.checked })} />Selalu sertakan dalam konteks</label>
      <p className="muted">Jika tidak dicentang, agent bisa menemukan catatan lewat pencarian. Maksimum 2.000 karakter per catatan, 128 catatan, dan 8 KiB konteks gabungan.</p>
      <div className="form-actions routine-actions"><button disabled={locked || !text.trim()}>Simpan catatan</button><button type="button" className="secondary" disabled={locked} onClick={() => choose(null)}>Catatan baru</button>{entry && <button type="button" className="secondary" disabled={locked} onClick={() => void save(true)}>Hapus catatan</button>}</div>
    </form>
    <form onSubmit={event => { event.preventDefault(); setCursors([]); setSearch(query); setRefresh(n => n + 1); }}><label>Cari memori<input value={query} maxLength={200} disabled={busy} onChange={event => setQuery(event.target.value)} /></label><button className="secondary" disabled={busy}>Cari</button></form>
    {!page ? !error && <p role="status">Memuat memori...</p> : <><ul className="routine-list">{page.items.map(row => <li key={row.id}><p className="message-text">{row.text}</p><p className="muted">{row.essential ? 'Selalu disertakan' : 'Dicari saat diperlukan'}</p><button className="secondary" disabled={locked} onClick={() => choose(row)}>Edit catatan</button></li>)}</ul>{!page.items.length && <p>Belum ada catatan yang cocok.</p>}
      <div className="form-actions routine-actions"><button className="secondary" disabled={busy || !cursors.length} onClick={() => setCursors(v => v.slice(0, -1))}>Halaman sebelumnya</button><button className="secondary" disabled={busy || !page.next_after} onClick={() => setCursors(v => [...v, page.next_after!])}>Halaman berikutnya</button></div></>}
  </section>;
}
