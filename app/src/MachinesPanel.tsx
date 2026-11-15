import { useEffect, useRef, useState } from 'react';
import { Ellipsis, Monitor, Plus, RefreshCw } from 'lucide-react';
import type { Environment, PairedMachine, PeerAgentSummary } from '../machines';
import { ActionMenu, Alert, Badge, Button, Card, Checkbox, Dialog, EmptyState, Field, IconButton, Input, PageHeader, Row, Section, SkeletonRows, Textarea, useConfirm } from './ui/kit';
import { Markdown } from './Markdown';
import { restoreRemoteMessage } from '../remote-message-command';
import { TurnActivity } from './ui/TurnActivity';
import { ChatComposer, ChatEmptyState, ChatHeader, ChatTranscript, HumanMessage, AgentMessage, TurnStatus } from './ui/ChatPrimitives';
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
  const [installOpen, setInstallOpen] = useState(false), [install, setInstall] = useState<{ source: string; token: string; expiresAt: number } | null>(null), [installError, setInstallError] = useState(''), [installBusy, setInstallBusy] = useState(false), [copied, setCopied] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), pendingAdd = useRef<{ id: string; origin: string; code: string } | null>(null);
  const confirm = useConfirm();
  async function reload() { try { const [local, result] = await Promise.all([request<Environment>('/api/environment'), request<{ machines: PairedMachine[] }>('/api/machines')]); setEnvironment(local); setName(local.name); setMachines(result.machines); setError(''); } catch (error) { setError(message(error)); } }
  useEffect(() => { heading.current?.focus(); void reload(); }, []);
  useEffect(() => { if (!pairingCode) return; const timer = setInterval(() => { const time = Date.now(); setNow(time); if (time >= pairingCode.expiresAt) setPairingCode(null); }, 1000); return () => clearInterval(timer); }, [pairingCode]);
  useEffect(() => { if (!install) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [install]);
  const installFlight = useRef(0);
  function closeInstall(open: boolean) { setInstallOpen(open); if (!open) { installFlight.current++; setInstall(null); setInstallError(''); setInstallBusy(false); setCopied(false); } }
  async function createInstall() {
    const flight = ++installFlight.current; setInstallBusy(true); setInstallError(''); setCopied(false);
    try { const value = await request<{ source: string; token: string; expiresAt: number }>('/api/install/tokens', { id: crypto.randomUUID() }); if (flight === installFlight.current) { setInstall(value); setNow(Date.now()); } }
    catch (error) { if (flight === installFlight.current) setInstallError(message(error)); }
    finally { if (flight === installFlight.current) setInstallBusy(false); }
  }
  async function act(action: string, run: () => Promise<void>) { setBusy(action); setError(''); setNotice(''); try { await run(); onChanged(); } catch (error) { setError(message(error)); } finally { setBusy(''); } }
  async function unpair(machine: PairedMachine) {
    if (!await confirm({ title: `Unpair ${machine.name}?`, description: 'Removes this machine from your list and revokes its access here. Briefsip also asks the other machine to revoke access. If it is offline, remove this pairing there too.', confirm: 'Unpair machine', danger: true })) return;
    await act('unpair', async () => { await request('/api/machines/remove', { id: crypto.randomUUID(), environmentId: machine.id }); await reload(); setNotice(`${machine.name} was unpaired.`); });
  }
  const remaining = pairingCode ? Math.max(0, Math.ceil((pairingCode.expiresAt - now) / 1000)) : 0;
  const installRemaining = install ? Math.max(0, Math.ceil((install.expiresAt - now) / 1000)) : 0;
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const installCommand = install && installRemaining ? `curl -fsSL ${shellQuote(install.source + '/api/install/script')} | sh -s -- --source ${shellQuote(install.source)} --token ${shellQuote(install.token)} --serve` : '';
  return <div className="k-page bs-root machines-page">
    <PageHeader headingRef={heading} title="Machines" description="Pair your Briefsip installations and see their agents in one workspace." actions={<><Button icon={<Plus size={14} aria-hidden />} onClick={() => closeInstall(true)}>Add a machine</Button><IconButton label="Reload machines" disabled={!!busy} onClick={() => void reload()}><RefreshCw size={15} aria-hidden /></IconButton></>} />
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
    <Section title="Pair an existing installation">
      <form className="k-stack" onSubmit={event => { event.preventDefault(); const command = pendingAdd.current ?? { id: crypto.randomUUID(), origin, code: code.trim().toUpperCase() }; pendingAdd.current = command; void act('add', async () => { await request('/api/machines', command); pendingAdd.current = null; setCode(''); setOrigin(''); await reload(); setNotice('Machines are paired in both directions.'); }); }}>
        <Field label="Machine origin" hint="Use the exact private HTTPS origin, including its port."><Input type="url" required placeholder="https://workstation.example.ts.net:4317" value={origin} maxLength={2048} disabled={!!busy} onChange={event => { setOrigin(event.target.value); pendingAdd.current = null; }} /></Field>
        <Field label="Pairing code"><Input required value={code} minLength={12} maxLength={12} autoComplete="off" spellCheck={false} disabled={!!busy} onChange={event => { setCode(event.target.value.toUpperCase()); pendingAdd.current = null; }} /></Field>
        <div className="machines-form-actions"><Button type="submit" variant="primary" icon={<Plus size={14} aria-hidden />} busy={busy === 'add'} disabled={!!busy}>Pair machine</Button></div>
      </form>
    </Section>
    <Section title="Paired machines">
      {machines === null ? <SkeletonRows /> : !machines.length ? <EmptyState icon={<Monitor size={18} />} title="No paired machines">Add another installation using its origin and pairing code.</EmptyState> : <Card>{machines.map(machine => <Row key={machine.id} leading={<Monitor size={16} aria-hidden />} title={machine.name} meta={<><span className="machines-origin">{machine.origin}</span><Badge tone={machine.status === 'online' ? 'success' : 'warn'}>{statusLabel[machine.status]}</Badge><span>Version {machine.version}</span><span>{machine.agentCount} {machine.agentCount === 1 ? 'agent' : 'agents'}</span>{machine.pairingState === 'pending' && <Badge tone="warn">Return pairing pending</Badge>}<span>{machine.lastSeen ? `Last seen ${new Date(machine.lastSeen).toLocaleString()}` : 'Not seen yet'}</span></>} trailing={<div className="k-stack"><Checkbox label="Allow agents on this machine to message my agents" checked={machine.allowAgentMessaging} disabled={!!busy} onChange={allowed=>void act('policy',async()=>{await request('/api/machines/agent-messaging',{id:crypto.randomUUID(),environmentId:machine.id,allowed});await reload();})}/><Checkbox label={`Allow updates from ${machine.name}`} description="Enable on both machines. Updates interrupt running turns and use a database backup with automatic rollback." checked={machine.allowUpdates} disabled={!!busy} onChange={allowed=>void act('updates',async()=>{await request('/api/machines/updates',{id:crypto.randomUUID(),environmentId:machine.id,allowed});await reload();})}/><ActionMenu label={`Machine actions: ${machine.name}`} trigger={<IconButton label={`Machine actions: ${machine.name}`} disabled={!!busy}><Ellipsis size={16} aria-hidden /></IconButton>} items={[{ label: `Unpair ${machine.name}`, danger: true, onSelect: () => { void unpair(machine); } }]} /></div>} />)}</Card>}
    </Section>
    <Dialog open={installOpen} onOpenChange={closeInstall} title="Add a machine" description="Install Briefsip on another Linux machine you own, then pair it with this one." footer={<><Button onClick={() => closeInstall(false)}>Close</Button>{!installCommand && <Button variant="primary" busy={installBusy} onClick={() => void createInstall()}>{install ? 'Create new command' : 'Create install command'}</Button>}</>}>
      <div className="k-stack machine-install">
        <p className="k-field__hint">Requires Node.js 22.23.4 or later, a systemd user session, and Tailscale on the same tailnet with MagicDNS and HTTPS enabled. Git and Bubblewrap are optional.</p>
        <p className="k-field__hint">The command installs a private release, starts a user service, enables linger if permitted, and uses Tailscale Serve on port 4317. Provider credentials stay on each machine.</p>
        {installError && <Alert tone="error">{installError}</Alert>}
        {installCommand ? <>
          <Field label="Run on your new machine" hint="Keep this command private. It grants a release download and one pairing code."><Textarea readOnly className="machine-install__command" value={installCommand} spellCheck={false} autoComplete="off" /></Field>
          <div className="machines-form-actions"><span className="k-field__hint">Expires in <span className="machines-countdown">{Math.floor(installRemaining / 60)}:{String(installRemaining % 60).padStart(2, '0')}</span>. Token works once.</span><Button onClick={async () => { try { await navigator.clipboard.writeText(installCommand); setCopied(true); } catch { setInstallError('Copy failed. Select the command and copy it manually.'); } }}>{copied ? 'Copied' : 'Copy command'}</Button></div>
          <p className="k-field__hint" role="status">{copied ? 'Command copied. Paste it into a terminal on your new machine.' : 'Shown only here. Closing this dialog hides the command; it expires after 30 minutes.'}</p>
        </> : install && <Alert tone="warn">This install command expired. Create a new one to continue.</Alert>}
      </div>
    </Dialog>
  </div>;
}
type RemoteMessage = {id:string;text:string;status:string;state:string;reply:string|null;error:string|null;created:number};
function remoteStatus(item: RemoteMessage) { return item.state === 'uncertain' || item.status === 'interrupted' ? 'Uncertain' : item.status === 'done' ? 'Done' : item.status === 'running' ? 'Replying' : item.status === 'failed' ? 'Failed' : item.status === 'cancelled' ? 'Cancelled' : item.status === 'waiting' ? 'Waiting' : 'Queued'; }
function remoteTone(item: RemoteMessage) { return item.state === 'uncertain' || ['failed', 'interrupted'].includes(item.status) ? 'error' : item.status === 'waiting' ? 'attention' : ['queued', 'running'].includes(item.status) ? 'working' : 'done'; }
export function RemoteAgentDetail({ machine, agent, request }: { machine?: PairedMachine; agent?: PeerAgentSummary; request: Request }) {
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
    if(!machine||!agent||flight.current||invalid||disabledReason||!text.trim())return;
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
  const heading = useRef<HTMLDivElement>(null); useEffect(() => { heading.current?.focus(); }, [machine?.id, agent?.id]);
  const disabledReason = invalid ? 'Saved message could not be read. Discard it after checking conversation history.' : machine?.status !== 'online' ? `${machine ? statusLabel[machine.status] : 'Remote machine unavailable'}. Reconnect the machine before sending.` : machine?.remoteAgentMessaging === false ? `Messaging is turned off on ${machine.name}. Enable it in Settings > Machines on that machine.` : undefined;
  return <main className="chat bs-root remote-conversation" aria-label={machine && agent ? `Conversation ${agent.name} on ${machine.name}` : 'Remote agent unavailable'}>
    <ChatHeader agent={agent ?? { id: '', name: 'Remote agent' }} title={agent?.name ?? 'Remote agent unavailable'} pillRef={heading} tooltip={machine?.origin} right={<><span className="chat__remote-context">on {machine?.name ?? 'unknown machine'}</span><span className={`activity-chip${machine?.status === 'online' ? ' is-working' : ''}`} role="status">{machine ? statusLabel[machine.status] : 'Unavailable'}</span></>} />
    <ChatTranscript aria-busy={messages === null}>
      {loadError && <p className="chat-notice is-error" role="alert">{loadError} History will be retried.</p>}
      {machine && machine.status !== 'online' && <p className="chat-notice is-warn" role="status">{machine.status === 'unauthorized' ? 'Peer access was revoked. Pair this machine again in Settings > Machines.' : 'This agent is unavailable. Existing messages remain saved; reconnect the machine before sending.'}</p>}
      {!machine || !agent ? <ChatEmptyState agent={{ id: '', name: 'Remote agent' }} title="Remote agent unavailable">{!machine ? 'This machine has been unpaired.' : 'This agent is no longer in the remote directory.'}</ChatEmptyState> : messages === null ? <p className="empty-chat__sub" role="status">Loading conversation...</p> : !messages.length ? <ChatEmptyState agent={agent ?? { id: '', name: 'remote agent' }} title={`Message ${agent?.name ?? 'remote agent'}`}>Only your message is shared. The agent runs on {machine?.name ?? 'its own machine'} and keeps its local approval rules.</ChatEmptyState> : messages.map(item => <article className="turn-block" id={`turn-${item.id}`} tabIndex={-1} key={item.id}>
        <HumanMessage text={item.text} label="Your message"><time className="message-time" dateTime={new Date(item.created).toISOString()}>{new Date(item.created).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</time></HumanMessage>
        <AgentMessage><TurnActivity remote turn={{ status: item.state === 'uncertain' ? 'interrupted' : item.status, paused: item.status === 'waiting' ? 1 : 0, created: new Date(item.created).toISOString() }} agentName={agent?.name ?? 'remote agent'} onOpenTask={id => document.getElementById(`turn-${id}`)?.focus()} /><div className="message-body">{item.error && <p className="message-error" role="alert">{item.error}</p>}{item.reply ? <div className="legacy"><Markdown text={item.reply} scope="" origin={window.location.origin} /></div> : !['failed', 'interrupted', 'cancelled'].includes(item.status) && <p className="message-muted" role="status">Waiting for {agent?.name}...</p>}</div><TurnStatus tone={remoteTone(item)} label={remoteStatus(item)} /></AgentMessage>
      </article>)}<div ref={end} />
    </ChatTranscript>
    <footer className="composer-area">
      {disabledReason && <p id="remote-send-reason" className="composer__note" role="status">{disabledReason}</p>}
      {error && <div className="composer__error" role="alert">{error}</div>}
      {(invalid || pending && !busy) && <div className="composer__error" role="status"><span><strong>{invalid ? 'Saved message could not be read' : 'Message submission is not confirmed'}</strong>. Check conversation history. Retry keeps the same request ID and text.</span><Button size="sm" variant="ghost" disabled={busy} onClick={() => void discard()}>Discard saved message</Button></div>}
      {machine && agent && <ChatComposer label={`Message ${agent.name} on ${machine.name}`} input={{ id: 'remote-message', value: text, required: true, disabled: busy || !!pending || !!disabledReason, 'aria-describedby': disabledReason ? 'remote-send-reason' : undefined, onChange: event => { setText(event.target.value); try { sessionStorage.setItem(storage + ':draft', event.target.value); } catch { setError('Draft could not be saved in browser storage.'); } } }}
        onSubmit={event => { event.preventDefault(); void send(); }} onSendKey={() => void send()} attachmentDisabledReason="Remote conversations support text only."
        busy={busy} retry={!!pending} sendDisabled={busy || !!disabledReason || !text.trim()} sendLabel={busy ? 'Sending...' : pending ? 'Retry send' : 'Send message'} sendTitle={disabledReason ?? (pending ? 'Retry send' : 'Send (Enter)')} />}
      <p className="composer__foot">Enter to send, Shift+Enter for a new line</p>
    </footer>
  </main>;
}
