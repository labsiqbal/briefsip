import { useEffect, useRef, useState } from 'react';
import { restoreSkillCommand, type SkillCommand } from '../skill-command';
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
  const replace = () => !editor || JSON.stringify(editor) === baseline || window.confirm('Discard unsaved pack changes?');
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
    if (locked || !replace()) return;
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
  function mutate(enabled: boolean, remove = false) {
    if (!editor?.id || !owner || binding === undefined || locked) return;
    const selectedVersion = remove || !enabled ? binding?.version : editor.revision;
    if (!selectedVersion || !window.confirm(remove ? 'Remove the pack and all skills it manages? The library remains available.' : `Apply pack version ${selectedVersion} to this agent? All members change together; unsaved drafts are excluded.`)) return;
    void execute({ path: `/api/agents/${owner}/skill-packs/${editor.id}`, body: { id: crypto.randomUUID(), revision: binding?.revision ?? 0, version: selectedVersion, enabled, ...(remove ? { remove: true } : {}) } });
  }
  return <section className="setup workflow-panel"><h1 ref={heading} tabIndex={-1}>Skill packs</h1><p>A pack installs revisions of multiple skills at once. Manual installations and other packs will not be overwritten.</p>
    <div className="form-actions"><button className="secondary" onClick={() => { if (replace()) onClose(); }}>Back to library</button><button className="secondary" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Reload packs</button></div>
    {error && <p className="error" role="alert">{error}</p>}{invalid && <p role="alert">Pack recovery is invalid.</p>}{pending && <button disabled={busy} onClick={() => void execute(pending)}>Retry pack change</button>}{(pending || invalid) && <button className="secondary" disabled={busy} onClick={() => { if (window.confirm('Ignore recovery? Changes may already have succeeded. Check the list before trying again.')) try { sessionStorage.removeItem(storage); setPending(null); setInvalid(false); setRefresh(value => value + 1); } catch { setError('Browser storage could not be updated.'); } }}>Ignore pack recovery</button>}
    <label>Agent<select disabled={locked} value={owner} onChange={event => setOwner(event.target.value)}>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name.length > 24 ? agent.name.slice(0, 21) + '...' : agent.name}</option>)}</select><span className="flow-selected-name muted">{agents.find(agent => agent.id === owner)?.name}</span></label>
    <button className="secondary" disabled={locked} onClick={() => { if (replace()) { const row = { id: '', name: '', revision: 0, latest: 0, members: [] }; setEditor(row); setBaseline(JSON.stringify(row)); } }}>Create pack</button>
    {editor && <form onSubmit={event => { event.preventDefault(); void execute({ path: editor.id ? `/api/skill-packs/${editor.id}` : '/api/skill-packs', body: { id: crypto.randomUUID(), revision: editor.latest, name: editor.name, members: editor.members.map(({ skill, version }) => ({ skill, version })) } }); }}><fieldset disabled={locked}><legend>{editor.id ? `Version ${editor.revision}; latest ${editor.latest}` : 'New pack'}</legend><label>Pack name<input required maxLength={80} value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
      <ul className="routine-list">{editor.members.map(member => <li key={member.skill}><strong>{member.name} · Version {member.version}</strong><details><summary>Review instructions for {member.name}</summary><p>{member.description}</p><pre className="message-text">{member.content}</pre></details><button type="button" className="secondary" onClick={() => setEditor({ ...editor, members: editor.members.filter(row => row.skill !== member.skill) })}>Remove {member.name} from draft</button></li>)}</ul>
      <label>Skill from library<select value={skill} onChange={event => { setSkill(event.target.value); setSkillVersion(library?.skills.find(row => row.id === event.target.value)?.revision ?? 1); }}><option value="">Choose skill</option>{library?.skills.map(row => <option key={row.id} value={row.id}>{row.name.length > 24 ? row.name.slice(0, 21) + '...' : row.name}</option>)}</select><span className="flow-selected-name muted">{library?.skills.find(row => row.id === skill)?.name}</span></label><label>Skill version<input type="number" min={1} step={1} value={skillVersion} onChange={event => setSkillVersion(Number(event.target.value))} /></label><button type="button" className="secondary" disabled={!skill || editor.members.length >= 64} onClick={() => void addMember()}>Add version to draft</button>
      <div className="form-actions"><button type="button" className="secondary" disabled={skillCursors.length < 2} onClick={() => { setSkill(''); setSkillCursors(value => value.slice(0, -1)); }}>Previous library page</button><button type="button" className="secondary" disabled={!library?.next_after} onClick={() => { setSkill(''); setSkillCursors(value => [...value, library!.next_after!]); }}>Next library page</button></div>
      <button disabled={!editor.members.length}>Save pack revision</button>
      {editor.id && <><label>Pack version to review<input type="number" min={1} max={editor.latest} value={version} onChange={event => setVersion(Number(event.target.value))} /></label><button type="button" className="secondary" disabled={!Number.isSafeInteger(version) || version < 1 || version > editor.latest} onClick={() => void open(editor.id, version)}>Load pack version</button><p>{binding === undefined ? 'Loading installation...' : !binding || binding.removed ? 'Pack is not installed yet.' : `Installed version ${binding.version}, ${binding.enabled ? 'active' : 'inactive'}.`}</p>
        <button type="button" disabled={!owner || binding === undefined} onClick={() => mutate(true)}>Install saved version {editor.revision}</button>{binding && !binding.removed && <><button type="button" className="secondary" disabled={!binding.enabled} onClick={() => mutate(false)}>Disable entire pack</button><button type="button" className="secondary" onClick={() => mutate(false, true)}>Remove entire pack</button></>}</>}
    </fieldset></form>}
    {!page ? !error && <p role="status">Loading packs...</p> : <ul className="routine-list">{page.packs.map(pack => <li key={pack.id}><strong>{pack.name}</strong><p>Revision {pack.revision}</p><button className="secondary" disabled={locked} onClick={() => void open(pack.id)}>Open pack {pack.name}</button></li>)}</ul>}
    <div className="form-actions"><button className="secondary" disabled={locked || cursors.length < 2} onClick={() => setCursors(value => value.slice(0, -1))}>Previous packs</button><button className="secondary" disabled={locked || !page?.next_after} onClick={() => setCursors(value => [...value, page!.next_after!])}>Next packs</button></div>
  </section>;
}
