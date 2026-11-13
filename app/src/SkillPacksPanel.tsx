import { useEffect, useRef, useState } from 'react';
import { restoreSkillCommand, type SkillCommand } from '../skill-command';
import { ArrowLeft, ChevronLeft, ChevronRight, Ellipsis, FileText, Package, Plus, RefreshCw } from 'lucide-react';
import { ActionMenu, Alert, Badge, Button, Card, CodeBlock, Collapsible, Dialog, EmptyState, Field, IconButton, Input, PageHeader, Row, Section, Select, SkeletonRows, Switch, useConfirm } from './ui/kit';
type Member = { skill: string; version: number; name: string; description: string; content: string };
type Pack = { id: string; name: string; revision: number; latest: number; members: Member[] };
type Binding = { revision: number; version: number; enabled: number; removed: number };
type Page = { packs: Pack[]; next_after: string | null };
type Library = { skills: { id: string; name: string; revision: number }[]; next_after: string | null };
const storage = 'briefsip:pack-command';
export function SkillPacksPanel({ agents, initialOwner, request, onClose }: { agents: { id: string; name: string }[]; initialOwner: string; request: <T>(path: string, body?: unknown) => Promise<T>; onClose: () => void }) {
  const [owner, setOwner] = useState(initialOwner), [page, setPage] = useState<Page | null>(null), [library, setLibrary] = useState<Library | null>(null);
  const [cursors, setCursors] = useState(['']), [skillCursors, setSkillCursors] = useState(['']), [refresh, setRefresh] = useState(0);
  const [editor, setEditor] = useState<Pack | null>(null), [baseline, setBaseline] = useState(''), [binding, setBinding] = useState<Binding | null | undefined>(undefined);
  const [version, setVersion] = useState(1), [skill, setSkill] = useState(''), [skillVersion, setSkillVersion] = useState(1);
  const [recovery] = useState(() => { try { const command = restoreSkillCommand(sessionStorage.getItem(storage)); if (command && !command.path.includes('/skill-packs')) throw Error(); return { command, invalid: false }; } catch { return { command: null, invalid: true }; } });
  const [pending, setPending] = useState(recovery.command), [invalid, setInvalid] = useState(recovery.invalid), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null), generation = useRef(0), inFlight = useRef(false);
  const after = cursors.at(-1)!, skillAfter = skillCursors.at(-1)!, locked = busy || !!pending || invalid;
  const confirm = useConfirm();
  const replace = async () => !editor || JSON.stringify(editor) === baseline || confirm({ title: 'Discard unsaved pack changes?', confirm: 'Discard changes', danger: true });
  useEffect(() => { heading.current?.focus(); return () => { generation.current++; }; }, []);
  useEffect(() => {
    let stopped = false; setPage(null); setLibrary(null); setError('');
    void Promise.all([request<Page>(`/api/skill-packs${after ? `?after=${after}` : ''}`), request<Library>(`/api/skills${skillAfter ? `?after=${skillAfter}` : ''}`)]).then(([packs, skills]) => { if (!stopped) { setPage(packs); setLibrary(skills); } }).catch(error => { if (!stopped) setError(error.message); });
    return () => { stopped = true; };
  }, [after, skillAfter, refresh]);
  useEffect(() => {
    let stopped = false; setBinding(undefined);
    if (editor?.id && owner) void request<Binding | null>(`/api/agents/${owner}/skill-packs/${editor.id}`).then(row => { if (!stopped) setBinding(row); }).catch(error => { if (!stopped) setError(error.message); });
    return () => { stopped = true; };
  }, [owner, editor?.id, refresh]);
  async function open(id: string, revision?: number) {
    if (locked || !await replace()) return;
    const current = ++generation.current; setBusy(true); setError('');
    try { const row = await request<Pack>(`/api/skill-packs/${id}${revision ? `?version=${revision}` : ''}`); if (current === generation.current) { setEditor(row); setBaseline(JSON.stringify(row)); setVersion(row.revision); heading.current?.focus(); } }
    catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Pack could not load.'); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function addMember() {
    if (locked || !editor || !skill || !Number.isSafeInteger(skillVersion) || skillVersion < 1) return;
    const current = ++generation.current; setBusy(true); setError('');
    try { const row = await request<Member & { id: string; revision: number }>(`/api/skills/${skill}?version=${skillVersion}`); if (current === generation.current) setEditor({ ...editor, members: [...editor.members.filter(member => member.skill !== skill), { skill: row.id, version: row.revision, name: row.name, description: row.description, content: row.content }] }); }
    catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Skill could not load.'); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function execute(command: SkillCommand) {
    if (busy || inFlight.current || invalid) return;
    const current = generation.current; setError('');
    try {
      restoreSkillCommand(JSON.stringify(command)); sessionStorage.setItem(storage, JSON.stringify(command)); setPending(command); setBusy(true); inFlight.current = true;
      await request(command.path, command.body);
      if (current !== generation.current) return;
      if (sessionStorage.getItem(storage) === JSON.stringify(command)) sessionStorage.removeItem(storage);
      setPending(null); if (!command.path.startsWith('/api/agents/')) setEditor(null); setRefresh(value => value + 1); heading.current?.focus();
    } catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Changes are not confirmed yet.'); }
    finally { inFlight.current = false; if (current === generation.current) setBusy(false); }
  }
  async function mutate(enabled: boolean, remove = false) {
    if (!editor?.id || !owner || binding === undefined || locked) return;
    const selectedVersion = remove || !enabled ? binding?.version : editor.revision;
    if (!selectedVersion || !await confirm(remove ? { title: 'Remove the pack and all skills it manages?', description: 'The library remains available.', confirm: 'Remove pack', danger: true } : { title: `Apply pack version ${selectedVersion} to this agent?`, description: 'All members change together; unsaved drafts are excluded.', confirm: 'Apply pack' })) return;
    void execute({ path: `/api/agents/${owner}/skill-packs/${editor.id}`, body: { id: crypto.randomUUID(), revision: binding?.revision ?? 0, version: selectedVersion, enabled, ...(remove ? { remove: true } : {}) } });
  }
  const startNew = async () => { if (await replace()) { const row = { id: '', name: '', revision: 0, latest: 0, members: [] }; setEditor(row); setBaseline(JSON.stringify(row)); } };
  const discard = async () => {
    if (await confirm({ title: 'Ignore recovery?', description: 'Changes may already have succeeded. Check the list before trying again.', confirm: 'Ignore recovery', danger: true })) try { sessionStorage.removeItem(storage); setPending(null); setInvalid(false); setRefresh(value => value + 1); } catch { setError('Browser storage could not be updated.'); }
  };
  const pager = (back: boolean, next: boolean, disabled: boolean, onBack: () => void, onNext: () => void, label: string) => (back || next) && <div className="k-pager">
    <IconButton label={`Previous ${label}`} disabled={disabled || !back} onClick={onBack}><ChevronLeft size={16} aria-hidden /></IconButton>
    <IconButton label={`Next ${label}`} disabled={disabled || !next} onClick={onNext}><ChevronRight size={16} aria-hidden /></IconButton>
  </div>;
  const recoveryActions = <>
    {pending && <Button size="sm" variant="primary" busy={busy} onClick={() => void execute(pending)}>Try again</Button>}
    <Button size="sm" disabled={busy} onClick={() => void discard()}>Ignore pack recovery</Button>
  </>;
  const recoveryNotice = <>
    {invalid && <Alert tone="error" title="Pack recovery is invalid" actions={recoveryActions} />}
    {pending && <Alert tone="warn" title="Changes are not confirmed yet" actions={!invalid && recoveryActions}>Retry sends the same request to avoid saving it twice.</Alert>}
  </>;
  return <div className="k-page bs-root">
    <PageHeader headingRef={heading} title="Skill packs" description="Install revisions of multiple skills together; manual installations and other packs will not be overwritten."
      actions={<>
        <Button variant="ghost" icon={<ArrowLeft size={14} aria-hidden />} onClick={async () => { if (await replace()) onClose(); }}>Back to skills</Button>
        <IconButton label="Reload packs" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden /></IconButton>
        <Button variant="primary" icon={<Plus size={14} aria-hidden />} disabled={locked} onClick={() => void startNew()}>Create pack</Button>
      </>} />
    {error && <Alert tone="error">{error}</Alert>}
    {recoveryNotice}
    <Section title="Installed on agent" actions={<Select size="sm" label="Agent" disabled={locked} value={owner} onChange={setOwner} options={agents.map(agent => ({ value: agent.id, label: agent.name.length > 24 ? agent.name.slice(0, 21) + '...' : agent.name }))} />}>
      <p className="k-field__hint">{agents.find(agent => agent.id === owner)?.name || 'No agents yet.'} Open a pack to review its installation.</p>
    </Section>
    <Section title="Library">
      {!page ? !error && <><span className="sr-only" role="status">Loading packs...</span><SkeletonRows /></>
        : !page.packs.length ? <EmptyState icon={<Package size={18} />} title="No packs on this page">Create a pack from saved skill versions.</EmptyState>
        : <Card>{page.packs.map(pack => <Row key={pack.id} title={pack.name} leading={<Package size={16} aria-hidden />} meta={<Badge>Revision {pack.revision}</Badge>} disabled={locked} onClick={() => void open(pack.id)} />)}</Card>}
      {pager(cursors.length > 1, !!page?.next_after, locked, () => setCursors(value => value.slice(0, -1)), () => setCursors(value => [...value, page!.next_after!]), 'packs')}
    </Section>
    <Dialog open={!!editor} size="lg" title={editor?.id ? editor.name : 'New pack'}
      description={editor?.id ? `Version ${editor.revision}; latest ${editor.latest}. Saving creates a new revision.` : undefined}
      onOpenChange={async next => { if (!next && await replace()) setEditor(null); }}
      footer={<>
        <Button disabled={busy} onClick={async () => { if (await replace()) setEditor(null); }}>Close</Button>
        <Button type="submit" form="pack-editor" variant="primary" busy={busy} disabled={locked || !editor?.members.length}>Save pack revision</Button>
      </>}>
      {editor && <>
        {error && <Alert tone="error">{error}</Alert>}
        {recoveryNotice}
        <form id="pack-editor" className="k-stack" onSubmit={event => { event.preventDefault(); void execute({ path: editor.id ? `/api/skill-packs/${editor.id}` : '/api/skill-packs', body: { id: crypto.randomUUID(), revision: editor.latest, name: editor.name, members: editor.members.map(({ skill, version }) => ({ skill, version })) } }); }}>
          <fieldset disabled={locked} className="k-fieldset">
            <Field label="Pack name"><Input required maxLength={80} value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} /></Field>
            <Section title="Skills in draft">
              {!editor.members.length ? <EmptyState icon={<FileText size={18} />} title="No skills in draft">Choose a skill version from the library.</EmptyState>
                : <Card>{editor.members.map(member => <Row key={member.skill} title={member.name} meta={<Badge>Version {member.version}</Badge>}
                    trailing={<ActionMenu label={`Menu ${member.name}`} trigger={<button type="button" className="k-icon-btn" aria-label={`Menu ${member.name}`} disabled={locked}><Ellipsis size={16} aria-hidden /></button>} items={[
                      { label: 'Remove from draft', danger: true, onSelect: () => setEditor({ ...editor, members: editor.members.filter(row => row.skill !== member.skill) }) },
                    ]} />}>
                    <Collapsible title={<>Review instructions for {member.name}</>}><p className="k-field__hint">{member.description}</p><CodeBlock label={`Instructions for ${member.name}`}>{member.content}</CodeBlock></Collapsible>
                  </Row>)}</Card>}
            </Section>
            <div className="k-grid-2">
              <Field label="Skill from library" hint={library?.skills.find(row => row.id === skill)?.name}>
                <Select value={skill} disabled={locked} onChange={value => { setSkill(value); setSkillVersion(library?.skills.find(row => row.id === value)?.revision ?? 1); }} options={[{ value: '', label: 'Choose skill' }, ...(library?.skills.map(row => ({ value: row.id, label: row.name.length > 24 ? row.name.slice(0, 21) + '...' : row.name })) ?? [])]} />
              </Field>
              <Field label="Skill version"><Input type="number" min={1} step={1} value={skillVersion} onChange={event => setSkillVersion(Number(event.target.value))} /></Field>
            </div>
            <div className="k-inline"><Button size="sm" disabled={!skill || editor.members.length >= 64} onClick={() => void addMember()}>Add version to draft</Button>
              {pager(skillCursors.length > 1, !!library?.next_after, locked, () => { setSkill(''); setSkillCursors(value => value.slice(0, -1)); }, () => { setSkill(''); setSkillCursors(value => [...value, library!.next_after!]); }, 'library page')}
            </div>
            {editor.id && <Section title="Version">
              <Field label="Pack version to review"><div className="k-inline"><Input type="number" min={1} max={editor.latest} value={version} onChange={event => setVersion(Number(event.target.value))} style={{ width: 96 }} /><Button size="sm" disabled={!Number.isSafeInteger(version) || version < 1 || version > editor.latest} onClick={() => void open(editor.id, version)}>Load pack version</Button></div></Field>
            </Section>}
          </fieldset>
        </form>
        <Section title="Installed on agent" actions={<Select size="sm" label="Agent" disabled={locked} value={owner} onChange={setOwner} options={agents.map(agent => ({ value: agent.id, label: agent.name.length > 24 ? agent.name.slice(0, 21) + '...' : agent.name }))} />}>
          <p className="k-field__hint">{agents.find(agent => agent.id === owner)?.name}</p>
          {!editor.id ? <Alert>Save a pack revision before installing it.</Alert>
            : <Card><Row title={editor.name} meta={binding === undefined ? <span role="status">Loading installation...</span> : !binding || binding.removed ? 'Pack is not installed yet.' : <><Badge>Installed version {binding.version}</Badge><Badge>{binding.enabled ? 'Active' : 'Inactive'}</Badge></>}
                trailing={<>
                  {binding && !binding.removed && <Switch checked={!!binding.enabled} disabled={locked || !owner || binding === undefined || !binding.enabled} label="Disable entire pack" onChange={() => void mutate(false)} />}
                  <ActionMenu label="Pack installation actions" trigger={<button type="button" className="k-icon-btn" aria-label="Pack installation actions" disabled={locked}><Ellipsis size={16} aria-hidden /></button>} items={[
                    { label: `Install saved version ${editor.revision}`, disabled: !owner || binding === undefined, onSelect: () => void mutate(true) },
                    ...(binding && !binding.removed ? [{ label: 'Remove entire pack', danger: true, onSelect: () => void mutate(false, true) }] : []),
                  ]} />
                </>} /></Card>}
        </Section>
      </>}
    </Dialog>
  </div>;
}
