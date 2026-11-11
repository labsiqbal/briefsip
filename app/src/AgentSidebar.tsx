import { useEffect, useRef, useState, type ReactNode } from 'react';
import { parseSections, type Sidebar, type SidebarSection } from '../sidebar';

const storage = 'briefsip-sidebar-pending';
type Command = Sidebar & { id: string };
function recover(): Command | null {
  const raw = sessionStorage.getItem(storage);
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (!value || Object.keys(value).some(key => !['id', 'revision', 'sections'].includes(key)) || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id)
    || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('Permintaan sidebar tersimpan tidak valid.');
  return { id: value.id, revision: value.revision, sections: parseSections(value.sections) };
}
export function AgentSidebar({ agents, renderAgent, request }: {
  agents: { id: string; name: string; hidden?: boolean }[]; renderAgent: (id: string) => ReactNode;
  request: <T>(path: string, body?: unknown) => Promise<T>;
}) {
  const [saved, setSaved] = useState<Sidebar | null>(null), [draft, setDraft] = useState<SidebarSection[]>([]);
  const [pending, setPending] = useState<Command | null>(null), [invalid, setInvalid] = useState(false), [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const generation = useRef(0), flight = useRef(false), editButton = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null);
  async function load() {
    const current = ++generation.current;
    setBusy(true); setError(''); setNotice('');
    try { const result = await request<Sidebar>('/api/sidebar'); if (current === generation.current) { setSaved(result); setDraft(result.sections); } }
    catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Sidebar belum dapat dimuat. Coba lagi.'); }
    finally { if (current === generation.current) setBusy(false); }
  }
  useEffect(() => {
    try { const command = recover(); if (command) { setPending(command); setEditing(true); } }
    catch { setInvalid(true); setEditing(true); setError('Permintaan tersimpan tidak dapat dibaca. Muat ulang pengaturan untuk melanjutkan.'); }
    void load(); return () => { generation.current++; };
  }, [request]);
  useEffect(() => { if (editing) heading.current?.focus(); }, [editing]);
  async function save() {
    if (flight.current || busy || invalid || !saved) return;
    let command: Command;
    try { command = pending ?? { id: crypto.randomUUID(), revision: saved.revision, sections: parseSections(draft) }; }
    catch (error) { setError(error instanceof Error ? error.message : 'Periksa nama bagian sebelum menyimpan.'); return; }
    const current = ++generation.current;
    flight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      sessionStorage.setItem(storage, JSON.stringify(command)); setPending(command);
      await request('/api/sidebar', command);
      // A replay receipt is historical; render only the authoritative directory.
      const latest = await request<Sidebar>('/api/sidebar');
      if (current !== generation.current) return;
      if (sessionStorage.getItem(storage) === JSON.stringify(command)) sessionStorage.removeItem(storage);
      setSaved(latest); setDraft(latest.sections); setPending(null); setNotice('Perubahan diterima. Daftar menampilkan pengaturan terbaru.');
    } catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Perubahan belum terkonfirmasi. Coba simpan lagi.'); }
    finally { flight.current = false; if (current === generation.current) setBusy(false); }
  }
  async function reload() {
    if (busy || flight.current || !window.confirm('Buang perubahan form dan muat sidebar terbaru? Perubahan yang sudah diterima server tetap tersimpan.')) return;
    try { sessionStorage.removeItem(storage); setPending(null); setInvalid(false); await load(); }
    catch { setError('Penyimpanan browser tidak tersedia. Periksa pengaturan browser lalu coba lagi.'); }
  }
  const shown = new Set(agents.filter(agent => !agent.hidden).map(agent => agent.id)), assigned = new Set(saved?.sections.flatMap(section => section.agents));
  const displayed = pending?.sections ?? draft;
  const patch = (id: string, value: Partial<SidebarSection>) => setDraft(draft.map(section => section.id === id ? { ...section, ...value } : section));
  function move(index: number, offset: number) {
    const next = [...draft]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; setDraft(next);
  }
  return <nav aria-label="Pilih agent" className="agent-sidebar">
    <button ref={editButton} className="secondary" aria-expanded={editing} onClick={() => setEditing(!editing)}>Atur bagian agent</button>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!saved && <button className="secondary" disabled={busy} onClick={() => void load()}>{busy ? 'Memuat bagian...' : 'Muat ulang bagian'}</button>}
    {editing && <section className="sidebar-editor" aria-labelledby="sidebar-editor-title"><h2 id="sidebar-editor-title" ref={heading} tabIndex={-1}>Bagian agent</h2><p>Bagian hanya mengatur daftar. Menghapus bagian tidak menghapus agent atau riwayat.</p>
      {(pending || invalid) && <p role="status">Perubahan belum terkonfirmasi. Coba simpan lagi atau muat pengaturan terbaru.</p>}
      <form onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy || !!pending || invalid || !saved}><legend>Susunan bagian</legend>
        {displayed.map((section, index) => <div key={section.id} className="sidebar-section-editor"><label>Nama bagian<input required maxLength={80} value={section.name} onChange={event => patch(section.id, { name: event.target.value })} /></label>
          <div className="form-actions"><button type="button" className="secondary" disabled={index === 0} aria-label={`Naikkan ${section.name}`} onClick={() => move(index, -1)}>Naik</button><button type="button" className="secondary" disabled={index === draft.length - 1} aria-label={`Turunkan ${section.name}`} onClick={() => move(index, 1)}>Turun</button><button type="button" className="secondary" onClick={() => { if (window.confirm(`Hapus bagian ${section.name}? Agent kembali ke Tanpa bagian; riwayat tetap tersimpan.`)) { setDraft(draft.filter(item => item.id !== section.id)); heading.current?.focus(); } }}>Hapus bagian</button></div>
        </div>)}
        <button type="button" className="secondary" disabled={draft.length >= 100} onClick={() => setDraft([...draft, { id: crypto.randomUUID(), name: 'Bagian baru', agents: [] }])}>Tambah bagian</button>
        {agents.map(agent => <label key={agent.id}>{agent.name}<select value={displayed.find(section => section.agents.includes(agent.id))?.id ?? ''} onChange={event => setDraft(draft.map(section => ({ ...section, agents: [...section.agents.filter(id => id !== agent.id), ...(section.id === event.target.value ? [agent.id] : [])] })))}><option value="">Tanpa bagian</option>{displayed.map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label>)}
      </fieldset><div className="form-actions"><button disabled={busy || invalid || !saved}>{busy ? 'Menyimpan...' : pending ? 'Coba simpan lagi' : 'Simpan bagian'}</button><button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>Muat ulang pengaturan</button></div></form>
    </section>}
    {saved?.sections.map(section => <details key={section.id} open><summary>{section.name}</summary>{section.agents.filter(id => shown.has(id)).map(id => renderAgent(id))}{!section.agents.some(id => shown.has(id)) && <p className="muted">Belum ada agent.</p>}</details>)}
    {!!saved?.sections.length && <h3>Tanpa bagian</h3>}{agents.filter(agent => !agent.hidden && !assigned.has(agent.id)).map(agent => renderAgent(agent.id))}
    {agents.some(agent => agent.hidden) && <details><summary>Agents disembunyikan</summary>{agents.filter(agent => agent.hidden).map(agent => renderAgent(agent.id))}</details>}
  </nav>;
}
