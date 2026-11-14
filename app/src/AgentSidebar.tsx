import { useEffect, useRef, useState, type ReactNode } from 'react';
import { parseSections, type Sidebar, type SidebarSection } from '../sidebar';
import { ActionMenu, Alert, Button, Card, Field, IconButton, Input, PageHeader, Row, Section, Select, useConfirm } from './ui/kit';
import { ChevronDown, ChevronUp, Ellipsis, Plus, Trash2 } from 'lucide-react';

const storage = 'briefsip-sidebar-pending';
type Command = Sidebar & { id: string };
function recover(): Command | null {
  const raw = sessionStorage.getItem(storage);
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (!value || Object.keys(value).some(key => !['id', 'revision', 'sections'].includes(key)) || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id)
    || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('Saved sidebar request is invalid.');
  return { id: value.id, revision: value.revision, sections: parseSections(value.sections) };
}
export function AgentSidebar({ agents, renderAgent, request, mode = 'full', showHidden = false, searching = false }: {
  agents: { id: string; name: string; hidden?: boolean }[]; renderAgent: (id: string) => ReactNode;
  request: <T>(path: string, body?: unknown) => Promise<T>;
  /** `list` renders only the agent sections; `editor` renders only the section editor. */
  mode?: 'full' | 'list' | 'editor'; showHidden?: boolean; searching?: boolean;
}) {
  const [saved, setSaved] = useState<Sidebar | null>(null), [draft, setDraft] = useState<SidebarSection[]>([]);
  const [pending, setPending] = useState<Command | null>(null), [invalid, setInvalid] = useState(false), [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const generation = useRef(0), flight = useRef(false), editButton = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const confirm = useConfirm();
  async function load() {
    const current = ++generation.current;
    setBusy(true); setError(''); setNotice('');
    try { const result = await request<Sidebar>('/api/sidebar'); if (current === generation.current) { setSaved(result); setDraft(result.sections); } }
    catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Sidebar could not load. Try again.'); }
    finally { if (current === generation.current) setBusy(false); }
  }
  useEffect(() => {
    try { const command = recover(); if (command) { setPending(command); setEditing(true); } }
    catch { setInvalid(true); setEditing(true); setError('Saved request could not be read. Reload settings to continue.'); }
    void load(); return () => { generation.current++; };
  }, [request]);
  useEffect(() => { if (mode === 'editor') setEditing(true); }, [mode]);
  useEffect(() => { if (editing) heading.current?.focus(); }, [editing]);
  async function save() {
    if (flight.current || busy || invalid || !saved) return;
    let command: Command;
    try { command = pending ?? { id: crypto.randomUUID(), revision: saved.revision, sections: parseSections(draft) }; }
    catch (error) { setError(error instanceof Error ? error.message : 'Check section names before saving.'); return; }
    const current = ++generation.current;
    flight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      sessionStorage.setItem(storage, JSON.stringify(command)); setPending(command);
      await request('/api/sidebar', command);
      // A replay receipt is historical; render only the authoritative directory.
      const latest = await request<Sidebar>('/api/sidebar');
      if (current !== generation.current) return;
      if (sessionStorage.getItem(storage) === JSON.stringify(command)) sessionStorage.removeItem(storage);
      setSaved(latest); setDraft(latest.sections); setPending(null); setNotice('Changes accepted. The list shows the latest settings.');
    } catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Changes are not confirmed yet. Try saving again.'); }
    finally { flight.current = false; if (current === generation.current) setBusy(false); }
  }
  async function reload() {
    if (busy || flight.current || !await confirm({ title: 'Reload sidebar settings?', description: 'Discard form changes and load the latest sidebar? Changes already accepted by the server remain saved.', confirm: 'Reload', danger: true })) return;
    try { sessionStorage.removeItem(storage); setPending(null); setInvalid(false); await load(); }
    catch { setError('Browser storage is unavailable. Check browser settings and try again.'); }
  }
  const shown = new Set(agents.filter(agent => showHidden || !agent.hidden).map(agent => agent.id)), assigned = new Set(saved?.sections.flatMap(section => section.agents));
  const displayed = pending?.sections ?? draft;
  const patch = (id: string, value: Partial<SidebarSection>) => setDraft(draft.map(section => section.id === id ? { ...section, ...value } : section));
  function move(index: number, offset: number) {
    const next = [...draft]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; setDraft(next);
  }
  const editorPage = mode === 'editor' ? <div className="k-page bs-root">
    <PageHeader headingRef={heading} title="Agent sections" description="Sections only organize the list. Deleting a section does not delete agents or history." />
    {error && <Alert tone="error">{error}</Alert>}
    {notice && <Alert>{notice}</Alert>}
    {!saved && <Button disabled={busy} onClick={() => void load()}>{busy ? 'Loading sections...' : 'Reload sections'}</Button>}
    {editing && <>
      {(pending || invalid) && <Alert tone={invalid ? 'error' : 'warn'} title="Changes are not confirmed yet">Try saving again or load the latest settings.</Alert>}
      <form id="agent-sections-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy || !!pending || invalid || !saved} className="k-fieldset">
          <Section title="Section order">
            <Card>{displayed.map((section, index) => <Row key={section.id}
              title={<Field label="Section name"><Input required maxLength={80} value={section.name} onChange={event => patch(section.id, { name: event.target.value })} /></Field>}
              trailing={<>
                <IconButton label={`Move up: ${section.name}`} disabled={index === 0} onClick={() => move(index, -1)}><ChevronUp size={15} aria-hidden /></IconButton>
                <IconButton label={`Move down: ${section.name}`} disabled={index === draft.length - 1} onClick={() => move(index, 1)}><ChevronDown size={15} aria-hidden /></IconButton>
                <ActionMenu label={`Menu ${section.name}`} trigger={<button type="button" className="k-icon-btn" aria-label={`Menu ${section.name}`}><Ellipsis size={16} aria-hidden /></button>} items={[
                  { label: 'Delete section', danger: true, icon: <Trash2 size={14} aria-hidden />, onSelect: async () => { if (await confirm({ title: `Delete section ${section.name}?`, description: 'Agents return to Unassigned; history remains saved.', confirm: 'Delete section', danger: true })) { setDraft(draft.filter(item => item.id !== section.id)); requestAnimationFrame(() => heading.current?.focus()); } } },
                ]} />
              </>} />)}</Card>
            <div><Button type="button" icon={<Plus size={14} aria-hidden />} disabled={draft.length >= 100} onClick={() => setDraft([...draft, { id: crypto.randomUUID(), name: 'New section', agents: [] }])}>Add section</Button></div>
          </Section>
        </fieldset>
      </form>
      {/* Outside the form so Radix native-select sync cannot clear initial assignments. */}
      <fieldset disabled={busy || !!pending || invalid || !saved} className="k-fieldset">
        <Section title="Agent assignment"><Card>{agents.map(agent => <Row key={agent.id} title={agent.name}
            trailing={<Select label={`Section for ${agent.name}`} value={displayed.find(section => section.agents.includes(agent.id))?.id ?? ''}
              disabled={busy || !!pending || invalid || !saved}
              onChange={value => setDraft(draft.map(section => ({ ...section, agents: [...section.agents.filter(id => id !== agent.id), ...(section.id === value ? [agent.id] : [])] })))}
              options={[{ value: '', label: 'Unassigned' }, ...displayed.map(section => ({ value: section.id, label: section.name }))]} />} />)}</Card></Section>
      </fieldset>
      <div className="k-row-actions"><Button type="submit" form="agent-sections-editor" variant="primary" busy={busy} disabled={busy || invalid || !saved}>{busy ? 'Saving...' : pending ? 'Retry save' : 'Save sections'}</Button><Button type="button" disabled={busy} onClick={() => void reload()}>Reload settings</Button></div>
    </>}
  </div> : null;
  return editorPage ?? <nav aria-label="Choose agent" className="agent-sidebar">
    {mode === 'full' && <button ref={editButton} className="secondary" aria-expanded={editing} onClick={() => setEditing(!editing)}>Manage agent sections</button>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!saved && <button className="secondary" disabled={busy} onClick={() => void load()}>{busy ? 'Loading sections...' : 'Reload sections'}</button>}
    {editing && mode !== 'list' && <section className="sidebar-editor" aria-labelledby="sidebar-editor-title"><h2 id="sidebar-editor-title" ref={heading} tabIndex={-1}>Agent sections</h2><p>Sections only organize the list. Deleting a section does not delete agents or history.</p>
      {(pending || invalid) && <p role="status">Changes are not confirmed yet. Try saving again or load the latest settings.</p>}
      <form onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy || !!pending || invalid || !saved}><legend>Section order</legend>
        {displayed.map((section, index) => <div key={section.id} className="sidebar-section-editor"><label>Section name<input required maxLength={80} value={section.name} onChange={event => patch(section.id, { name: event.target.value })} /></label>
          <div className="form-actions"><button type="button" className="secondary" disabled={index === 0} aria-label={`Move up: ${section.name}`} onClick={() => move(index, -1)}>Move up</button><button type="button" className="secondary" disabled={index === draft.length - 1} aria-label={`Move down: ${section.name}`} onClick={() => move(index, 1)}>Move down</button><button type="button" className="secondary" onClick={() => { if (window.confirm(`Delete section ${section.name}? Agents return to Unassigned; history remains saved.`)) { setDraft(draft.filter(item => item.id !== section.id)); heading.current?.focus(); } }}>Delete section</button></div>
        </div>)}
        <button type="button" className="secondary" disabled={draft.length >= 100} onClick={() => setDraft([...draft, { id: crypto.randomUUID(), name: 'New section', agents: [] }])}>Add section</button>
        {agents.map(agent => <label key={agent.id}>{agent.name}<select value={displayed.find(section => section.agents.includes(agent.id))?.id ?? ''} onChange={event => setDraft(draft.map(section => ({ ...section, agents: [...section.agents.filter(id => id !== agent.id), ...(section.id === event.target.value ? [agent.id] : [])] })))}><option value="">Unassigned</option>{displayed.map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label>)}
      </fieldset><div className="form-actions"><button disabled={busy || invalid || !saved}>{busy ? 'Saving...' : pending ? 'Retry save' : 'Save sections'}</button><button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>Reload settings</button></div></form>
    </section>}
    {mode !== 'editor' && <>{saved?.sections.filter(section => !searching || section.agents.some(id => shown.has(id))).map(section => <details key={`${section.id}:${searching}`} open><summary>{section.name}</summary>{section.agents.filter(id => shown.has(id)).map(id => renderAgent(id))}{!section.agents.some(id => shown.has(id)) && <p className="muted">{searching ? 'No matching agents.' : 'No visible agents.'}</p>}</details>)}
    {!!saved?.sections.length && agents.some(agent => (showHidden || !agent.hidden) && !assigned.has(agent.id)) && <h3>Unassigned</h3>}{agents.filter(agent => (showHidden || !agent.hidden) && !assigned.has(agent.id)).map(agent => renderAgent(agent.id))}
    </>}
  </nav>;
}
