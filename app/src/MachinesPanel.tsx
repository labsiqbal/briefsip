import { useEffect, useRef, useState } from 'react';
import { Collapsible as Disclosure } from 'radix-ui';
import { ChevronRight, Ellipsis, Monitor, Plus, RefreshCw } from 'lucide-react';
import type { Environment, PairedMachine, PeerAgentSummary } from '../machines';
import { ActionMenu, Alert, Badge, Button, Card, Checkbox, EmptyState, Field, IconButton, Input, PageHeader, Row, Section, SkeletonRows, Textarea, useConfirm } from './ui/kit';
import { Markdown } from './Markdown';
import { restoreRemoteMessage } from '../remote-message-command';
import './ui/machines.css';

type Request = <T>(path: string, data?: unknown) => Promise<T>;
const message = (error: unknown) => error instanceof Error ? error.message : 'Machine request failed. Try again.';
const statusLabel = { online: 'Online', offline: 'Offline', unauthorized: 'Unauthorized', 'version-mismatch': 'Version mismatch' };
export function useMachines(request: Request) {
  const [machines, setMachines] = useState<PairedMachine[]>([]), [error, setError] = useState('');
  const generation = useRef(0);
  async function reload() { const current = ++generation.current; try { const result = await request<{ machines: PairedMachine[] }>('/api/machines'); if (current === generation.current) { setMachines(result.machines); setError(''); } } catch (error) { if (current === generation.current) setError(message(error)); } }
  useEffect(() => { void reload(); const timer = setInterval(() => { void reload(); }, 5000); return () => { clearInterval(timer); generation.current++; }; }, []);
  return { machines, error, reload };
}
export function MachinesPanel({ request, onChanged }: { request: Request; onChanged: () => void }) {
  const [environment, setEnvironment] = useState<Environment | null>(null), [machines, setMachines] = useState<PairedMachine[] | null>(null);
  const [name, setName] = useState(''), [origin, setOrigin] = useState(''), [code, setCode] = useState('');
  const [pairingCode, setPairingCode] = useState<{ code: string; expiresAt: number } | null>(null), [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement>(null), pendingAdd = useRef<{ id: string; origin: string; code: string } | null>(null);
  const confirm = useConfirm();
  async function reload() { try { const [local, result] = await Promise.all([request<Environment>('/api/environment'), request<{ machines: PairedMachine[] }>('/api/machines')]); setEnvironment(local); setName(local.name); setMachines(result.machines); setError(''); } catch (error) { setError(message(error)); } }
  useEffect(() => { heading.current?.focus(); void reload(); }, []);
  useEffect(() => { if (!pairingCode) return; const timer = setInterval(() => { const time = Date.now(); setNow(time); if (time >= pairingCode.expiresAt) setPairingCode(null); }, 1000); return () => clearInterval(timer); }, [pairingCode]);
  async function act(action: string, run: () => Promise<void>) { setBusy(action); setError(''); setNotice(''); try { await run(); onChanged(); } catch (error) { setError(message(error)); } finally { setBusy(''); } }
  async function unpair(machine: PairedMachine) {
    if (!await confirm({ title: `Unpair ${machine.name}?`, description: 'Removes this machine from your list and revokes its access here. Briefsip also asks the other machine to revoke access. If it is offline, remove this pairing there too.', confirm: 'Unpair machine', danger: true })) return;
    await act('unpair', async () => { await request('/api/machines/remove', { id: crypto.randomUUID(), environmentId: machine.id }); await reload(); setNotice(`${machine.name} was unpaired.`); });
  }
  const remaining = pairingCode ? Math.max(0, Math.ceil((pairingCode.expiresAt - now) / 1000)) : 0;
  return <div className="k-page bs-root machines-page">
    <PageHeader headingRef={heading} title="Machines" description="Pair your Briefsip installations and see their agents in one workspace." actions={<IconButton label="Reload machines" disabled={!!busy} onClick={() => void reload()}><RefreshCw size={15} aria-hidden /></IconButton>} />
    {error && <Alert tone="error">{error}</Alert>}{notice && <Alert>{notice}</Alert>}
    <Section title="This machine">
      {!environment ? <SkeletonRows count={1} /> : <form className="k-stack" onSubmit={event => { event.preventDefault(); void act('name', async () => { const saved = await request<Environment>('/api/environment', { id: crypto.randomUUID(), name }); setEnvironment(saved); setName(saved.name); setNotice('Machine name saved.'); }); }}>
        <Field label="Display name" hint="Agents on other machines see this name."><Input value={name} maxLength={120} required disabled={!!busy} onChange={event => setName(event.target.value)} /></Field>
        <div className="machines-form-actions"><span className="k-field__hint machines-origin">{environment.origin}</span><Button type="submit" busy={busy === 'name'} disabled={!!busy || name.trim() === environment.name}>Save name</Button></div>
      </form>}
    </Section>
    <Section title="Pair from another machine">
      <p className="k-field__hint">Create a code here, then enter this machine's origin and code in Briefsip on your other machine. Codes expire after 10 minutes and work once.</p>
      {pairingCode ? <div className="machines-code" role="region" aria-label="One-time pairing code"><span className="machines-code__value">{pairingCode.code}</span><span className="k-field__hint">Expires in <span className="machines-countdown">{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span>. Shown only here until you leave.</span><Button size="sm" onClick={() => setPairingCode(null)}>Hide code</Button></div>
        : <Button disabled={!!busy} busy={busy === 'code'} onClick={() => void act('code', async () => { const result = await request<{ code: string; expiresAt: number }>('/api/pairing-codes', { id: crypto.randomUUID() }); setNow(Date.now()); setPairingCode(result); })}>Create pairing code</Button>}
    </Section>
    <Section title="Add a machine">
      <form className="k-stack" onSubmit={event => { event.preventDefault(); const command = pendingAdd.current ?? { id: crypto.randomUUID(), origin, code: code.trim().toUpperCase() }; pendingAdd.current = command; void act('add', async () => { await request('/api/machines', command); pendingAdd.current = null; setCode(''); setOrigin(''); await reload(); setNotice('Machines are paired in both directions.'); }); }}>
        <Field label="Machine origin" hint="Use the exact private HTTPS origin, including its port."><Input type="url" required placeholder="https://workstation.example.ts.net:4317" value={origin} maxLength={2048} disabled={!!busy} onChange={event => { setOrigin(event.target.value); pendingAdd.current = null; }} /></Field>
        <Field label="Pairing code"><Input required value={code} minLength={12} maxLength={12} autoComplete="off" spellCheck={false} disabled={!!busy} onChange={event => { setCode(event.target.value.toUpperCase()); pendingAdd.current = null; }} /></Field>
        <div className="machines-form-actions"><Button type="submit" variant="primary" icon={<Plus size={14} aria-hidden />} busy={busy === 'add'} disabled={!!busy}>Pair machine</Button></div>
      </form>
    </Section>
    <Section title="Paired machines">
      {machines === null ? <SkeletonRows /> : !machines.length ? <EmptyState icon={<Monitor size={18} />} title="No paired machines">Add another installation using its origin and pairing code.</EmptyState> : <Card>{machines.map(machine => <Row key={machine.id} leading={<Monitor size={16} aria-hidden />} title={machine.name} meta={<><span className="machines-origin">{machine.origin}</span><Badge tone={machine.status === 'online' ? 'success' : 'warn'}>{statusLabel[machine.status]}</Badge><span>{machine.agentCount} {machine.agentCount === 1 ? 'agent' : 'agents'}</span>{machine.pairingState === 'pending' && <Badge tone="warn">Return pairing pending</Badge>}<span>{machine.lastSeen ? `Last seen ${new Date(machine.lastSeen).toLocaleString()}` : 'Not seen yet'}</span></>} trailing={<div className="k-stack"><Checkbox label="Allow agents on this machine to message my agents" checked={machine.allowAgentMessaging} disabled={!!busy} onChange={allowed=>void act('policy',async()=>{await request('/api/machines/agent-messaging',{id:crypto.randomUUID(),environmentId:machine.id,allowed});await reload();})}/><ActionMenu label={`Machine actions: ${machine.name}`} trigger={<IconButton label={`Machine actions: ${machine.name}`} disabled={!!busy}><Ellipsis size={16} aria-hidden /></IconButton>} items={[{ label: `Unpair ${machine.name}`, danger: true, onSelect: () => { void unpair(machine); } }]} /></div>} />)}</Card>}
    </Section>
  </div>;
}
export function MachinesSidebar({ machines, error, onOpen, selected, onSettings }: { machines: PairedMachine[]; error: string; onOpen: (machine: PairedMachine, agent: PeerAgentSummary) => void; selected: { machine: string; agent: string } | null; onSettings: () => void }) {
  return <nav className="machines-sidebar" aria-label="Machines">
    <div className="sidebar__label">Machines</div>
    {error && <p className="machines-sidebar__note" role="status">Machines could not be refreshed.</p>}
    {!machines.length && <button type="button" className="bot-list__empty" onClick={onSettings}><span className="bot-list__empty-plus"><Monitor size={14} aria-hidden /></span><span><span className="bot-row__name">Pair a machine</span><span className="bot-row__preview">See agents on your other computers</span></span></button>}
    {machines.map(machine => <Disclosure.Root key={machine.id} className="machines-sidebar__machine">
      <Disclosure.Trigger className="machines-sidebar__trigger"><ChevronRight className="machines-sidebar__chevron" size={14} aria-hidden /><Monitor size={15} aria-hidden /><span className="machines-sidebar__identity"><span className="bot-row__name">{machine.name}</span><span className="bot-row__preview">{statusLabel[machine.status]} · {machine.agentCount} {machine.agentCount === 1 ? 'agent' : 'agents'}</span></span><span className={`machine-dot is-${machine.status}`} aria-hidden /></Disclosure.Trigger>
      <Disclosure.Content className="machines-sidebar__agents">{machine.status !== 'online' && <p className="machines-sidebar__note">Showing last known agents.</p>}{!machine.agents.length ? <p className="machines-sidebar__note">No agents cached yet.</p> : machine.agents.map(agent => <button key={agent.id} className={`machines-sidebar__agent${selected?.machine === machine.id && selected.agent === agent.id ? ' is-selected' : ''}`} type="button" aria-current={selected?.machine === machine.id && selected.agent === agent.id ? 'page' : undefined} onClick={() => onOpen(machine, agent)}>{agent.name} on {machine.name}</button>)}</Disclosure.Content>
    </Disclosure.Root>)}
  </nav>;
}
type RemoteMessage = {id:string;text:string;status:string;state:string;reply:string|null;error:string|null;created:number};
export function RemoteAgentDetail({ machine, agent, onBack, request }: { machine?: PairedMachine; agent?: PeerAgentSummary; onBack: () => void; request: Request }) {
  const storage=`briefsip:remote-message:${machine?.id}:${agent?.id}`;
  const [recovery]=useState(()=>{try{return {pending:restoreRemoteMessage(sessionStorage.getItem(storage),machine?.id ?? '',agent?.id ?? ''),draft:sessionStorage.getItem(storage+':draft') ?? '',invalid:false};}catch{return {pending:null,draft:'',invalid:true};}});
  const [pending,setPending]=useState(recovery.pending),[invalid,setInvalid]=useState(recovery.invalid);
  const [messages,setMessages]=useState<RemoteMessage[]|null>(null),[text,setText]=useState(recovery.pending?.text ?? recovery.draft),[error,setError]=useState(''),[loadError,setLoadError]=useState(''),[busy,setBusy]=useState(false);
  const end=useRef<HTMLDivElement>(null),readEpoch=useRef(0),flight=useRef(false),mounted=useRef(true),confirm=useConfirm();
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const path=`/api/remote-agents/messages?machine=${machine?.id ?? ''}&agent=${agent?.id ?? ''}`;
  useEffect(()=>{
    let alive=true,timer:ReturnType<typeof setTimeout>;
    async function poll(){if(!machine||!agent)return;const epoch=++readEpoch.current;try{const result=await request<{messages:RemoteMessage[]}>(path);if(alive&&epoch===readEpoch.current){setMessages(result.messages);setLoadError('');}}catch(e){if(alive&&epoch===readEpoch.current)setLoadError(message(e));}if(alive)timer=setTimeout(()=>void poll(),1000);}
    setMessages(null);void poll();return()=>{alive=false;readEpoch.current++;clearTimeout(timer);};
  },[path]);
  useEffect(()=>{end.current?.scrollIntoView({block:'nearest'});},[messages?.length,messages?.at(-1)?.reply]);
  async function send(){
    if(!machine||!agent||flight.current||invalid||!text.trim())return;
    const command=pending ?? {id:crypto.randomUUID(),machine:machine.id,agent:agent.id,text:text.trim()};
    flight.current=true;readEpoch.current++;setBusy(true);setError('');
    try{
      sessionStorage.setItem(storage,JSON.stringify(command));setPending(command);
      await request('/api/remote-agents/messages',command);
      sessionStorage.removeItem(storage);sessionStorage.removeItem(storage+':draft');
      if(!mounted.current)return;
      setPending(null);setText('');const epoch=++readEpoch.current,result=await request<{messages:RemoteMessage[]}>(path);if(mounted.current&&epoch===readEpoch.current)setMessages(result.messages);
    }catch(e){if(mounted.current)setError(message(e));}finally{flight.current=false;if(mounted.current)setBusy(false);}
  }
  async function discard(){if(!await confirm({title:'Discard saved message?',description:'Delivery may already have succeeded. Check this conversation and the receiving machine before sending a replacement.',confirm:'Discard message',danger:true}))return;try{sessionStorage.removeItem(storage);setPending(null);setInvalid(false);}catch{setError('Browser storage could not be updated.');}}
  const heading = useRef<HTMLHeadingElement>(null); useEffect(() => { heading.current?.focus(); }, [machine?.id, agent?.id]);
  return <div className="k-page bs-root remote-conversation"><PageHeader headingRef={heading} title={machine && agent ? `${agent.name} on ${machine.name}` : 'Remote agent unavailable'} description={machine ? `${machine.origin} · ${statusLabel[machine.status]}` : 'This machine has been unpaired.'} actions={<Button variant="ghost" onClick={onBack}>Back to workspace</Button>} />
    {(error||loadError)&&<Alert tone="error">{error||loadError}</Alert>}
    {(pending||invalid)&&<Alert tone="warn" title={invalid?'Saved message could not be read':'Message submission is not confirmed'} actions={<Button size="sm" disabled={busy} onClick={()=>void discard()}>Discard saved message</Button>}>Check conversation history. Retry keeps the same request ID and text.</Alert>}
    {machine&&machine.status!=='online'&&<Alert title={statusLabel[machine.status]}>{machine.status==='unauthorized'?'Peer access was revoked. Pair this machine again in Settings > Machines.':'This agent is unavailable. Existing messages remain saved; reconnect the machine before sending.'}</Alert>}
    <section className="remote-conversation__messages" aria-label="Remote messages" aria-busy={messages===null}>
      {messages===null?<SkeletonRows />:!messages.length?<EmptyState title={`Message ${agent?.name ?? 'remote agent'}`}>Only your message is shared. The agent runs on {machine?.name ?? 'its own machine'} and keeps its local approval rules.</EmptyState>:messages.map(item=><article className="remote-conversation__turn" key={item.id}>
        <div className="message-user"><div className="msg-meta"><strong>You</strong><time dateTime={new Date(item.created).toISOString()}>{new Date(item.created).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></div><div className="msg-bubble msg-bubble--user message-plain">{item.text}</div></div>
        <div className="message-assistant"><div className="msg-meta"><strong>{agent?.name} on {machine?.name}</strong><Badge tone={item.status==='done'?'success':['failed','interrupted','cancelled'].includes(item.status)?'warn':'brand'}>{item.state==='uncertain'||item.status==='interrupted'?'Uncertain':item.status==='done'?'Done':item.status==='running'?'Replying':item.status==='failed'?'Failed':item.status==='cancelled'?'Cancelled':item.status==='waiting'?'Waiting':'Queued'}</Badge></div>{item.error&&<Alert tone="error">{item.error}</Alert>}{item.reply?<Markdown text={item.reply} scope="" origin={window.location.origin}/>:!['failed','interrupted','cancelled'].includes(item.status)&&<p className="k-field__hint" role="status">Waiting for {agent?.name}...</p>}</div>
      </article>)}<div ref={end}/>
    </section>
    {machine&&agent&&<form className="remote-conversation__composer" onSubmit={event=>{event.preventDefault();void send();}}><Field label={`Message ${agent.name} on ${machine.name}`}><Textarea value={text} maxLength={16000} required disabled={busy||!!pending||invalid||machine.status!=='online'} onChange={event=>{setText(event.target.value);try{sessionStorage.setItem(storage+':draft',event.target.value);}catch{setError('Draft could not be saved in browser storage.');}}} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void send();}}}/></Field><div className="machines-form-actions"><span className="k-field__hint">Enter to send, Shift+Enter for a new line</span><Button type="submit" variant="primary" busy={busy} disabled={busy||invalid||!text.trim()||machine.status!=='online'}>{pending?'Retry message':'Send message'}</Button></div></form>}
  </div>;
}
