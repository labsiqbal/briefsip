import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DropdownMenu } from 'radix-ui';
import { parseSections, type Sidebar, type SidebarSection } from '../sidebar';
import { ActionMenu, Alert, Button, Dialog, Field, IconButton, Input, PageHeader, useConfirm } from './ui/kit';
import { ChevronRight, Ellipsis, Plus } from 'lucide-react';

const storage = 'briefsip-sidebar-pending';
type Command = Sidebar & { id: string };
export function AgentSidebar({ agents, renderAgent, request, mode = 'list', showHidden = false, searching = false }: {
  agents: { id: string; name: string; hidden?: boolean }[]; renderAgent: (id: string) => ReactNode;
  request: <T>(path: string, body?: unknown) => Promise<T>; mode?: 'full' | 'list' | 'editor'; showHidden?: boolean; searching?: boolean;
}) {
  const [saved, setSaved] = useState<Sidebar | null>(null), [pending, setPending] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [invalid, setInvalid] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const flight = useRef(false), confirm = useConfirm();
  async function load() { setBusy(true); try { setSaved(await request<Sidebar>('/api/sidebar')); setError(''); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }
  useEffect(() => { try { const raw = sessionStorage.getItem(storage); if (raw) { const value = JSON.parse(raw); if (!value || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.id) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error(); setPending({ id: value.id, revision: value.revision, sections: parseSections(value.sections) }); } } catch { setInvalid(true); } void load(); }, [request]);
  async function save(sections: SidebarSection[]) {
    if (flight.current || busy || !saved || invalid) return false; flight.current = true; setBusy(true); setError('');
    try { const command = pending ?? { id: crypto.randomUUID(), revision: saved.revision, sections: parseSections(sections) }; sessionStorage.setItem(storage,JSON.stringify(command)); setPending(command); await request('/api/sidebar',command); setSaved(await request<Sidebar>('/api/sidebar')); sessionStorage.removeItem(storage); setPending(null); return true; }
    catch (error) { setError((error as Error).message); return false; } finally { flight.current = false; setBusy(false); }
  }
  async function reload() { if (!await confirm({ title: 'Reload sections?', description: 'Clear this pending request and load current sections. Changes already saved stay saved.', confirm: 'Reload sections' })) return; try { sessionStorage.removeItem(storage); setPending(null); setInvalid(false); await load(); } catch (error) { setError((error as Error).message); } }
  if (mode === 'editor') return <div className="k-page bs-root"><PageHeader title="Agent sections" description="Manage sections in the sidebar. Use + beside Agents to create a section, its menu to rename, reorder or delete it, and each agent menu to move it." /></div>;
  const shown = new Set(agents.filter(agent => showHidden || !agent.hidden).map(agent => agent.id));
  const sections = saved?.sections ?? [], assigned = new Set(sections.flatMap(section => section.agents));
  const locked = busy || !!pending || invalid || !saved;
  const moveAgent = (agent: string, target: string) => void save(sections.map(section => ({ ...section, agents: [...section.agents.filter(id => id !== agent), ...(section.id === target ? [agent] : [])] })));
  const agentRow = (id: string) => <div className="sidebar-agent" key={id}>{renderAgent(id)}<DropdownMenu.Root><DropdownMenu.Trigger asChild><IconButton label={`Menu ${agents.find(agent => agent.id === id)?.name ?? 'agent'}`} disabled={locked}><Ellipsis size={15} aria-hidden /></IconButton></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="k-pop k-menu" align="end" sideOffset={4}><DropdownMenu.Sub><DropdownMenu.SubTrigger className="k-menu__item">Move to section<ChevronRight size={14} aria-hidden /></DropdownMenu.SubTrigger><DropdownMenu.Portal><DropdownMenu.SubContent className="k-pop k-menu" sideOffset={4}><DropdownMenu.Item className="k-menu__item" onSelect={() => moveAgent(id,'')}>Unassigned</DropdownMenu.Item>{sections.map(section => <DropdownMenu.Item key={section.id} className="k-menu__item" onSelect={() => moveAgent(id,section.id)}>{section.name}</DropdownMenu.Item>)}</DropdownMenu.SubContent></DropdownMenu.Portal></DropdownMenu.Sub></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div>;
  return <nav aria-label="Choose agent" className="agent-sidebar">
    <div className="sidebar-section-heading"><span>Agents</span><IconButton label="Create section" disabled={locked || sections.length >= 100} onClick={() => setEditing({id:'',name:''})}><Plus size={14} aria-hidden /></IconButton></div>
    {error && <p role="alert">{error}</p>}
    {(pending || invalid) && <Alert tone="warn" title={invalid ? 'Saved section request could not be read' : 'Section change is not confirmed'} actions={<>{!invalid && <Button size="sm" disabled={busy} onClick={() => void save(pending?.sections ?? [])}>Retry section change</Button>}<Button size="sm" disabled={busy} onClick={() => void reload()}>Reload sections</Button></>} />}
    {!saved && !busy && <Button size="sm" onClick={() => void load()}>Reload sections</Button>}
    {sections.filter(section => !searching || section.agents.some(id => shown.has(id))).map(section => { const index = sections.indexOf(section); return <div key={section.id} className="sidebar-section"><div className="sidebar-section-heading"><span>{section.name}</span><ActionMenu label={`Menu section ${section.name}`} trigger={<IconButton label={`Menu section ${section.name}`} disabled={locked}><Ellipsis size={15} aria-hidden /></IconButton>} items={[
      {label:'Rename section',onSelect:() => setEditing({id:section.id,name:section.name})},
      {label:'Move section up',disabled:index === 0,onSelect:() => { const next = [...sections]; [next[index-1],next[index]] = [next[index],next[index-1]]; void save(next); }},
      {label:'Move section down',disabled:index === sections.length-1,onSelect:() => { const next = [...sections]; [next[index+1],next[index]] = [next[index],next[index+1]]; void save(next); }},
      {label:'Delete section',danger:true,onSelect:async () => { if (await confirm({title:`Delete section ${section.name}?`,description:'Agents return to Unassigned. Agents and history remain saved.',confirm:'Delete section',danger:true})) void save(sections.filter(item => item.id !== section.id)); }},
    ]} /></div>{section.agents.filter(id => shown.has(id)).map(agentRow)}{!section.agents.some(id => shown.has(id)) && <p>No visible agents.</p>}</div>; })}
    {!!sections.length && agents.some(agent => shown.has(agent.id) && !assigned.has(agent.id)) && <h3>Unassigned</h3>}{agents.filter(agent => shown.has(agent.id) && !assigned.has(agent.id)).map(agent => agentRow(agent.id))}
    <Dialog open={!!editing} onOpenChange={open => { if (!open && !busy) setEditing(null); }} title={editing?.id ? 'Rename section' : 'Create section'} description="Sections organize agents on this device." footer={<><Button disabled={busy} onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" form="section-form" variant="primary" disabled={locked || !editing?.name.trim()} busy={busy}>{editing?.id ? 'Save name' : 'Create section'}</Button></>}>
      <form id="section-form" onSubmit={event => {event.preventDefault(); if (editing) void save(editing.id ? sections.map(section => section.id === editing.id ? {...section,name:editing.name} : section) : [...sections,{id:crypto.randomUUID(),name:editing.name,agents:[]}]).then(ok => {if(ok)setEditing(null);});}}><Field label="Section name"><Input required maxLength={80} disabled={locked} value={editing?.name ?? ''} onChange={event => setEditing(value => value && {...value,name:event.target.value})} /></Field>{error && <Alert tone="error">{error}</Alert>}</form>
    </Dialog>
  </nav>;
}
