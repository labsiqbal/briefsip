import { SkillPacksPanel } from './SkillPacksPanel';
import { useEffect, useRef, useState } from 'react';
import { restoreSkillCommand, type SkillCommand } from '../skill-command';
import { parseSkillFiles, type SkillFile } from '../skill-files';
import { SkillFolderImport, downloadSkillFolder } from './SkillFolderImport';
import { BookOpen, ChevronLeft, ChevronRight, Ellipsis, FileText, Package, Plus, RefreshCw } from 'lucide-react';
import { ActionMenu, Alert, Badge, Button, Card, Collapsible, Dialog, EmptyState, Field, IconButton, Input, PageHeader, Row, Section, Select, SkeletonRows, Switch, Textarea, useConfirm } from './ui/kit';
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
  const confirm = useConfirm();
  const canReplace = async () => !dirty || confirm({ title: 'Buang perubahan skill?', description: 'Perubahan yang belum disimpan akan hilang.', confirm: 'Buang perubahan', danger: true });
  const locked = busy || importBusy || !!pending || invalid, after = cursors.at(-1)!;
  useEffect(() => { heading.current?.focus(); return () => { navigation.current++; }; }, []);
  useEffect(() => { heading.current?.focus(); }, [after, showPacks]);
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
    if (locked || !await canReplace()) return;
    const current = ++navigation.current; setBusy(true); setError('');
    try { const skill = await request<Skill>(`/api/skills/${id}${revision ? `?version=${revision}` : ''}`); if (current === navigation.current) { setEditor(skill); setBaseline(JSON.stringify(skill)); setVersion(skill.revision); } }
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
      setPending(null); setRefresh(value => value + 1); if (!command.path.startsWith('/api/agents/')) { setEditor(null); heading.current?.focus(); }
    } catch (error) { if (current === navigation.current) setError(error instanceof Error ? error.message : 'Perubahan belum terkonfirmasi. Coba lagi.'); }
    finally { inFlight.current = false; if (current === navigation.current) setBusy(false); }
  }
  async function discard() {
    if (busy || !await confirm({ title: 'Abaikan permintaan tersimpan?', description: 'Perubahan itu mungkin sudah berhasil. Daftar dimuat ulang sebelum perubahan berikutnya.', confirm: 'Abaikan' })) return;
    try { sessionStorage.removeItem(storage); setPending(null); setInvalid(false); setRefresh(value => value + 1); }
    catch { setError('Penyimpanan browser belum dapat diubah.'); }
  }
  if (showPacks) return <SkillPacksPanel agents={agents} initialOwner={owner} request={request} onClose={() => { setShowPacks(false); setRefresh(value => value + 1); }} />;
  const ownerName = agents.find(agent => agent.id === owner)?.name ?? '';
  const startNew = async () => { if (!await canReplace()) return; setBaseline(''); setEditor({ id: '', name: '', description: '', content: '', revision: 0, latest: 0 }); setVersion(1); };
  const importFiles = async (files: SkillFile[]) => { if (!await canReplace()) return; const parsed = parseSkillFiles(files); setEditor({ id: editor?.id ?? '', revision: editor?.revision ?? 0, latest: editor?.latest ?? 0, ...parsed }); setVersion(editor?.revision || 1); };
  const save = () => { if (!editor || locked) return; void execute({ path: editor.id ? `/api/skills/${editor.id}` : '/api/skills', body: { id: crypto.randomUUID(), revision: editor.latest, ...(editor.files ? { files: editor.files } : { name: editor.name, description: editor.description, content: editor.content }) } }); };
  const install = async () => {
    if (!editor || !await confirm({ title: `Pasang versi ${editor.revision} ke ${ownerName}?`, description: 'Perubahan teks yang belum disimpan tidak ikut dipasang. Eksekusi yang sedang berjalan tidak berubah.', confirm: 'Pasang' })) return;
    void execute({ path: `/api/agents/${owner}/skills/${editor.id}`, body: { id: crypto.randomUUID(), revision: binding?.revision ?? 0, version: editor.revision, enabled: true } });
  };
  const pager = (back: boolean, next: boolean, onBack: () => void, onNext: () => void, label: string) => (back || next) && <div className="k-pager">
    <IconButton label={`${label} sebelumnya`} disabled={locked || !back} onClick={onBack}><ChevronLeft size={16} aria-hidden /></IconButton>
    <IconButton label={`${label} berikutnya`} disabled={locked || !next} onClick={onNext}><ChevronRight size={16} aria-hidden /></IconButton>
  </div>;
  return <div className="k-page bs-root">
    <PageHeader headingRef={heading} title="Skills" description="Instruksi tambahan yang bisa dipasang ke agent. Skill tidak menambah izin tool dan tidak menjalankan script."
      actions={<>
        <IconButton label="Muat ulang" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden /></IconButton>
        <Button icon={<Package size={14} aria-hidden />} disabled={locked} onClick={() => setShowPacks(true)}>Paket skill</Button>
        <Button variant="primary" icon={<Plus size={14} aria-hidden />} disabled={locked} onClick={() => void startNew()}>Buat skill</Button>
      </>} />
    {error && <Alert tone="error">{error}</Alert>}
    {invalid && <Alert tone="error" title="Data pemulihan skill tidak dapat dibaca." actions={<Button size="sm" disabled={busy} onClick={() => void discard()}>Abaikan pemulihan</Button>} />}
    {pending && <Alert tone="warn" title="Perubahan belum terkonfirmasi" actions={<><Button size="sm" variant="primary" busy={busy} onClick={() => void execute(pending)}>Coba lagi</Button><Button size="sm" disabled={busy} onClick={() => void discard()}>Abaikan</Button></>}>Permintaan yang sama dikirim ulang supaya tidak tersimpan dua kali.</Alert>}

    <Section id="skills-installed" title="Terpasang di agent" actions={agents.length > 0 && <Select size="sm" label="Agent" value={owner} disabled={locked} onChange={value => { navigation.current++; setOwner(value); setInstallCursors(['']); }} options={agents.map(agent => ({ value: agent.id, label: agent.name }))} />}>
      {!owner ? <EmptyState icon={<BookOpen size={18} />} title="Belum ada agent">Buat agent dulu, lalu pasang skill ke agent itu.</EmptyState>
        : installed === null ? <SkeletonRows count={2} />
        : installed.length === 0 ? <EmptyState icon={<BookOpen size={18} />} title={`${ownerName} belum memakai skill`}>Buka skill di library, lalu pasang versinya ke agent ini.</EmptyState>
        : <Card>{installed.map(row => <Row key={row.skill} title={row.name} leading={<BookOpen size={16} aria-hidden />}
            meta={<><span>Versi {row.version}</span>{row.latest > row.version && <Badge tone="warn">Versi {row.latest} tersedia</Badge>}{row.pack && <Badge>Paket</Badge>}{!row.enabled && <Badge>Nonaktif</Badge>}</>}
            trailing={<>
              <Switch checked={!!row.enabled} disabled={locked || !!row.pack} label={`${row.enabled ? 'Nonaktifkan' : 'Aktifkan'} ${row.name}`} onChange={() => void execute({ path: `/api/agents/${owner}/skills/${row.skill}`, body: { id: crypto.randomUUID(), revision: row.revision, version: row.version, enabled: !row.enabled } })} />
              <ActionMenu label={`Menu ${row.name}`} trigger={<button type="button" className="k-icon-btn" aria-label={`Menu ${row.name}`} disabled={locked}><Ellipsis size={16} aria-hidden /></button>} items={[
                { label: `Periksa versi ${row.version}`, onSelect: () => void open(row.skill, row.version) },
                'separator',
                { label: row.pack ? 'Dikelola Paket skill' : 'Lepas dari agent', danger: !row.pack, disabled: !!row.pack, onSelect: async () => { if (await confirm({ title: `Lepas ${row.name} dari ${ownerName}?`, description: 'Revisi library tetap tersedia. Eksekusi yang sudah berjalan tidak berubah.', confirm: 'Lepas', danger: true })) void execute({ path: `/api/agents/${owner}/skills/${row.skill}`, body: { id: crypto.randomUUID(), revision: row.revision, version: row.version, enabled: false, remove: true } }); } },
              ]} />
            </>} />)}</Card>}
      {pager(installCursors.length > 1, !!installNext, () => setInstallCursors(value => value.slice(0, -1)), () => setInstallCursors(value => [...value, installNext!]), 'Pemasangan')}
    </Section>

    <Section id="skills-library" title="Library" actions={<SkillFolderImport compact disabled={locked} onBusy={setImportBusy} onError={setError} onImport={files => void importFiles(files)} />}>
      {!page ? !error && <SkeletonRows count={3} />
        : page.skills.length === 0 ? <EmptyState icon={<FileText size={18} />} title="Library masih kosong" action={<Button variant="primary" size="sm" icon={<Plus size={14} aria-hidden />} disabled={locked} onClick={() => void startNew()}>Buat skill</Button>}>Tulis skill baru, atau impor folder berisi SKILL.md.</EmptyState>
        : <Card>{page.skills.map(skill => <Row key={skill.id} title={skill.name} meta={`Revisi ${skill.revision}`} leading={<FileText size={16} aria-hidden />} disabled={locked} onClick={() => void open(skill.id)} />)}</Card>}
      {pager(cursors.length > 1, !!page?.next_after, () => setCursors(value => value.slice(0, -1)), () => setCursors(value => [...value, page!.next_after!]), 'Skill')}
    </Section>

    <Dialog open={!!editor} size="lg" onOpenChange={async next => { if (!next && await canReplace()) setEditor(null); }}
      title={editor?.id ? editor.name : editor?.files ? `Impor ${editor.name}` : 'Skill baru'}
      description={editor?.id ? `Versi ${editor.revision} dari ${editor.latest}. Simpan membuat revisi baru; agent tetap memakai versi terpasang sampai kamu menggantinya.` : 'Simpan membuat revisi pertama di library.'}
      footer={<>
        {editor?.id && <span className="k-dialog__foot-note"><SkillFolderImport compact disabled={locked} onBusy={setImportBusy} onError={setError} onImport={files => void importFiles(files)} /></span>}
        <Button disabled={busy} onClick={async () => { if (await canReplace()) setEditor(null); }}>Tutup</Button>
        <Button type="submit" form="skill-editor" variant="primary" busy={busy} disabled={locked && !busy}>Simpan revisi</Button>
      </>}>
      {editor && <form id="skill-editor" className="k-page" style={{ gap: 18 }} onSubmit={event => { event.preventDefault(); save(); }}>
        {error && <Alert tone="error">{error}</Alert>}
        <fieldset disabled={locked} className="k-fieldset">
          <Field label="Nama"><Input required readOnly={!!editor.files} maxLength={80} value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} placeholder="Misalnya: ringkas-rapat" /></Field>
          <Field label="Deskripsi" hint="Kapan agent sebaiknya memakai skill ini."><Textarea required readOnly={!!editor.files} maxLength={1024} rows={2} style={{ minHeight: 60 }} value={editor.description} onChange={event => setEditor({ ...editor, description: event.target.value })} /></Field>
          <Field label="Instruksi"><Textarea required readOnly={!!editor.files} maxLength={16000} rows={10} style={{ minHeight: 200 }} value={editor.content} onChange={event => setEditor({ ...editor, content: event.target.value })} /></Field>
        </fieldset>
        {editor.files && <Section title={`${editor.files.length} file dari folder`} actions={<>
          <Button size="sm" variant="ghost" onClick={() => downloadSkillFolder(editor.files!)}>Ekspor JSON</Button>
          <Button size="sm" variant="ghost" onClick={() => { try { downloadSkillFolder(editor.files!, true); } catch (error) { setError(error instanceof Error ? error.message : 'Ekspor ZIP gagal. Periksa file skill.'); } }}>Ekspor ZIP</Button>
        </>}>
          <Alert>Metadata folder dipertahankan. Untuk memperbarui, impor ulang folder lengkap saat skill ini terbuka.</Alert>
          <Card className="k-file-list">{editor.files.map(file => <div key={file.path} className="k-file"><Collapsible title={<span className="k-file__path">{file.path}</span>}>{file.encoding ? <p className="k-file__note">Aset binary. Ekspor ZIP untuk mendapatkan file asli.</p> : <pre className="k-file__content" tabIndex={0} role="region" aria-label={`Isi ${file.path}`}>{file.content}</pre>}</Collapsible></div>)}</Card>
        </Section>}
        {editor.id && <Section title="Versi">
          <div className="k-version">
            <Field label="Periksa versi lain"><div className="k-inline"><Input type="number" min={1} max={editor.latest} step={1} value={version} onChange={event => setVersion(Number(event.target.value))} style={{ width: 96 }} /><Button disabled={!Number.isSafeInteger(version) || version < 1 || version > editor.latest || locked} onClick={() => void open(editor.id, version)}>Muat</Button></div></Field>
            <div className="k-version__install">
              {binding?.removed === 1 && <p className="k-field__hint">Skill ini pernah dilepas dari {ownerName}. Pasang versi tersimpan untuk memakainya lagi.</p>}
              <Button variant="brand" disabled={!owner || binding === undefined || (!!binding?.pack && !binding.removed) || locked} onClick={() => void install()}>Pasang versi {editor.revision} ke {ownerName || 'agent'}</Button>
            </div>
          </div>
        </Section>}
      </form>}
    </Dialog>
  </div>;
}
