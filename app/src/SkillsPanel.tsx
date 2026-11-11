import { SkillPacksPanel } from './SkillPacksPanel';
import { useEffect, useRef, useState } from 'react';
import { restoreSkillCommand, type SkillCommand } from '../skill-command';
import { parseSkillFiles, type SkillFile } from '../skill-files';
import { SkillFolderImport, downloadSkillFolder } from './SkillFolderImport';
type Skill = { id: string; name: string; description: string; content: string; revision: number; latest: number; files?: SkillFile[] };
type Installed = { pack?: string | null; removed: number; skill: string; name: string; version: number; enabled: number; revision: number; latest: number };
const storage = 'briefsip:skill-command';
export function SkillsPanel({ agents, request, onClose }: { agents: { id: string; name: string }[]; request: <T>(path: string, body?: unknown) => Promise<T>; onClose: () => void }) {
  const [showPacks, setShowPacks] = useState(false);
  const [owner, setOwner] = useState(agents[0]?.id ?? '');
  const [recovery] = useState(() => { try { return { command: restoreSkillCommand(sessionStorage.getItem(storage)), invalid: false }; } catch { return { command: null, invalid: true }; } });
  const [pending, setPending] = useState(recovery.command), [invalid, setInvalid] = useState(recovery.invalid);
  const [page, setPage] = useState<{ skills: Skill[]; next_after: string | null } | null>(null), [installed, setInstalled] = useState<Installed[] | null>(null);
  const [installCursors, setInstallCursors] = useState(['']), installAfter = installCursors.at(-1)!;
  const [installNext, setInstallNext] = useState<string | null>(null), [binding, setBinding] = useState<Installed | null | undefined>(undefined);
  const [baseline, setBaseline] = useState('');
  const [cursors, setCursors] = useState(['']), [refresh, setRefresh] = useState(0), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Skill | null>(null), [version, setVersion] = useState(1);
  const [importBusy, setImportBusy] = useState(false);
  const navigation = useRef(0), inFlight = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const dirty = !!editor && JSON.stringify(editor) !== baseline;
  const canReplace = () => !dirty || window.confirm('Buang perubahan skill yang belum disimpan?');
  const locked = busy || importBusy || !!pending || invalid, after = cursors.at(-1)!;
  useEffect(() => { heading.current?.focus(); return () => { navigation.current++; }; }, []);
  useEffect(() => { heading.current?.focus(); }, [editor?.id, after, showPacks]);
  useEffect(() => {
    let stopped = false; setPage(null); setInstalled(null); setError('');
    void Promise.all([request<NonNullable<typeof page>>(`/api/skills${after ? `?after=${after}` : ''}`), owner ? request<{ items: Installed[]; next_after: string | null }>(`/api/agents/${owner}/skills${installAfter ? `?after=${installAfter}` : ''}`) : Promise.resolve({ items: [], next_after: null })]).then(([library, rows]) => { if (!stopped) { setPage(library); setInstalled(rows.items); setInstallNext(rows.next_after); } }).catch(error => { if (!stopped) setError(error.message); });
    return () => { stopped = true; };
  }, [owner, after, installAfter, refresh]);
  useEffect(() => {
    let stopped = false; setBinding(undefined);
    if (owner && editor?.id) void request<Installed | null>(`/api/agents/${owner}/skills/${editor.id}`).then(row => { if (!stopped) setBinding(row); }).catch(error => { if (!stopped) setError(error.message); });
    return () => { stopped = true; };
  }, [owner, editor?.id, refresh]);
  async function open(id: string, revision?: number) {
    if (locked || !canReplace()) return;
    const current = ++navigation.current; setBusy(true); setError('');
    try { const skill = await request<Skill>(`/api/skills/${id}${revision ? `?version=${revision}` : ''}`); if (current === navigation.current) { setEditor(skill); setBaseline(JSON.stringify(skill)); setVersion(skill.revision); heading.current?.focus(); } }
    catch (error) { if (current === navigation.current) setError(error instanceof Error ? error.message : 'Skill gagal dimuat.'); }
    finally { if (current === navigation.current) setBusy(false); }
  }
  async function execute(command: SkillCommand) {
    if (inFlight.current || busy || invalid) return;
    const current = navigation.current; setError('');
    try {
      restoreSkillCommand(JSON.stringify(command)); sessionStorage.setItem(storage, JSON.stringify(command)); setPending(command); inFlight.current = true; setBusy(true);
      await request(command.path, command.body);
      if (current !== navigation.current) return;
      if (sessionStorage.getItem(storage) === JSON.stringify(command)) sessionStorage.removeItem(storage);
      setPending(null); if (!command.path.startsWith('/api/agents/')) setEditor(null); setRefresh(value => value + 1); heading.current?.focus();
    } catch (error) { if (current === navigation.current) setError(error instanceof Error ? error.message : 'Perubahan belum terkonfirmasi. Coba lagi.'); }
    finally { inFlight.current = false; if (current === navigation.current) setBusy(false); }
  }
  function discard() {
    if (busy || !window.confirm('Abaikan permintaan tersimpan? Perubahan mungkin sudah berhasil. Daftar akan dimuat ulang sebelum perubahan berikutnya.')) return;
    try { sessionStorage.removeItem(storage); setPending(null); setInvalid(false); setRefresh(value => value + 1); }
    catch { setError('Penyimpanan browser belum dapat diubah.'); }
  }
  if (showPacks) return <SkillPacksPanel agents={agents} initialOwner={owner} request={request} onClose={() => { setShowPacks(false); setRefresh(value => value + 1); }} />;
  return <section className="setup workflow-panel"><h1 ref={heading} tabIndex={-1}>Library skill</h1><p>Skill teks menjadi instruksi tambahan untuk agent. Tidak menambahkan izin tool atau menjalankan script. Perubahan berlaku pada eksekusi berikutnya.</p>
    <div className="form-actions"><button className="secondary" onClick={onClose}>Kembali ke percakapan</button><button className="secondary" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Muat ulang library</button></div>
    {error && <p className="error" role="alert">{error}</p>}{invalid && <p role="alert">Data pemulihan skill tidak dapat dibaca.</p>}{pending && <p className="notice">Permintaan belum terkonfirmasi. <button className="secondary" disabled={busy} onClick={() => void execute(pending)}>Coba perubahan lagi</button></p>}{(pending || invalid) && <button className="secondary" disabled={busy} onClick={discard}>Abaikan pemulihan</button>}
    <button className="secondary" disabled={locked} onClick={() => setShowPacks(true)}>Paket skill</button>
    <label>Agent<select disabled={locked} value={owner} onChange={event => { navigation.current++; setOwner(event.target.value); setInstallCursors(['']); }}>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name.length > 24 ? agent.name.slice(0, 21) + '...' : agent.name}</option>)}</select><span className="flow-selected-name muted">{agents.find(agent => agent.id === owner)?.name}</span></label>
    <h2>Skill agent</h2>{installed ? <ul className="routine-list">{installed.map(row => <li key={row.skill}><strong>{row.name}</strong><p>Versi terpasang {row.version} · Terbaru {row.latest} · {row.enabled ? 'Aktif' : 'Nonaktif'}</p><button className="secondary" disabled={locked} onClick={() => void open(row.skill, row.version)}>Periksa {row.name}</button><button className="secondary" disabled={locked || !!row.pack} onClick={() => void execute({ path: `/api/agents/${owner}/skills/${row.skill}`, body: { id: crypto.randomUUID(), revision: row.revision, version: row.version, enabled: !row.enabled } })}>{row.enabled ? 'Nonaktifkan' : 'Aktifkan'} {row.name}</button><button className="secondary" disabled={locked || !!row.pack} onClick={() => { if (window.confirm(`Lepas ${row.name} dari agent ini? Revisi library tetap tersedia. Eksekusi yang sudah berjalan tidak berubah.`)) void execute({ path: `/api/agents/${owner}/skills/${row.skill}`, body: { id: crypto.randomUUID(), revision: row.revision, version: row.version, enabled: false, remove: true } }); }}>Lepas {row.name}</button>{row.pack && <p className="muted">Dikelola paket. Gunakan Paket skill untuk mengubah seluruh anggota bersama.</p>}</li>)}</ul> : <p role="status">Memuat pemasangan...</p>}
    <div className="form-actions"><button className="secondary" disabled={locked || installCursors.length < 2} onClick={() => setInstallCursors(value => value.slice(0, -1))}>Pemasangan sebelumnya</button><button className="secondary" disabled={locked || !installNext} onClick={() => setInstallCursors(value => [...value, installNext!])}>Pemasangan berikutnya</button></div>
    {installed?.length === 0 && <p>Tidak ada skill terpasang pada halaman ini.</p>}
    <button className="secondary" disabled={locked} onClick={() => { if (!canReplace()) return; setBaseline(''); setEditor({ id: '', name: '', description: '', content: '', revision: 0, latest: 0 }); setVersion(1); }}>Buat skill</button>
    <p>{editor?.id ? `Impor berikut menjadi draf revisi baru untuk ${editor.name}. Pilih Buat skill jika ingin membuat skill terpisah.` : 'Impor berikut menjadi draf skill baru. Simpan setelah memeriksa seluruh file.'}</p>
    <SkillFolderImport disabled={locked} onBusy={setImportBusy} onImport={files => { if (!canReplace()) return; const parsed = parseSkillFiles(files); setEditor({ id: editor?.id ?? '', revision: editor?.revision ?? 0, latest: editor?.latest ?? 0, ...parsed }); setVersion(editor?.revision || 1); heading.current?.focus(); }} />
    {editor && <form onSubmit={event => { event.preventDefault(); if (locked) return; void execute({ path: editor.id ? `/api/skills/${editor.id}` : '/api/skills', body: { id: crypto.randomUUID(), revision: editor.latest, ...(editor.files ? { files: editor.files } : { name: editor.name, description: editor.description, content: editor.content }) } }); }}><fieldset disabled={locked}><legend>{editor.id ? `Versi ${editor.revision}; terbaru ${editor.latest}` : 'Skill baru'}</legend>
      <label>Nama<input required readOnly={!!editor.files} maxLength={80} value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} /></label><label>Deskripsi<textarea required readOnly={!!editor.files} maxLength={1024} value={editor.description} onChange={event => setEditor({ ...editor, description: event.target.value })} /></label><label>Instruksi skill<textarea required readOnly={!!editor.files} maxLength={16000} rows={10} value={editor.content} onChange={event => setEditor({ ...editor, content: event.target.value })} /></label>
      {editor.files && <><p>Revisi folder mempertahankan metadata asli. Untuk memperbarui, impor folder lengkap saat skill ini terbuka.</p><button type="button" className="secondary" onClick={() => downloadSkillFolder(editor.files!)}>Ekspor JSON</button><button type="button" className="secondary" onClick={() => { try { downloadSkillFolder(editor.files!, true); } catch (error) { setError(error instanceof Error ? error.message : "Ekspor ZIP gagal. Periksa file skill."); } }}>Ekspor ZIP</button><ul className="routine-list">{editor.files.map(file => <li key={file.path}><details><summary>{file.path}</summary><pre className="skill-file-content" tabIndex={0} role="region" aria-label={`Isi ${file.path}`}>{file.content}</pre></details></li>)}</ul></>}
      <p className="muted">Simpan membuat revisi baru. Agent tetap memakai revisi terpasang sampai kamu menggantinya.</p><button>Simpan revisi skill</button>
      {editor.id && <><label>Versi untuk diperiksa<input type="number" min={1} max={editor.latest} step={1} value={version} onChange={event => setVersion(Number(event.target.value))} /></label><button type="button" className="secondary" disabled={!Number.isSafeInteger(version) || version < 1 || version > editor.latest} onClick={() => void open(editor.id, version)}>Muat versi tersimpan</button>
      {binding?.removed === 1 && <p className="muted">Skill pernah dilepas dari agent ini. Pilih versi tersimpan untuk memasang kembali.</p>}<button type="button" disabled={!owner || binding === undefined || (!!binding?.pack && !binding.removed)} onClick={() => { if (window.confirm(`Pasang versi tersimpan ${editor.revision} untuk agent ini? Perubahan teks yang belum disimpan tidak ikut dipasang.`)) void execute({ path: `/api/agents/${owner}/skills/${editor.id}`, body: { id: crypto.randomUUID(), revision: binding?.revision ?? 0, version: editor.revision, enabled: true } }); }}>Pasang versi tersimpan {editor.revision}</button></>}
    </fieldset></form>}
    {!page ? !error && <p role="status">Memuat library...</p> : <ul className="routine-list">{page.skills.map(skill => <li key={skill.id}><strong>{skill.name}</strong><p>Revisi {skill.revision}</p><button className="secondary" disabled={locked} onClick={() => void open(skill.id)}>Buka {skill.name}</button></li>)}</ul>}
    <div className="form-actions"><button className="secondary" disabled={locked || cursors.length < 2} onClick={() => setCursors(value => value.slice(0, -1))}>Skill sebelumnya</button><button className="secondary" disabled={locked || !page?.next_after} onClick={() => setCursors(value => [...value, page!.next_after!])}>Skill berikutnya</button></div>
  </section>;
}
