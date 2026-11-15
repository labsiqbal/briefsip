// Machine summary and restart confirmation adapted from T3 UpdateEverythingDialog (MIT).
import { useEffect, useRef, useState } from 'react';
import { Download, Monitor, RefreshCw } from 'lucide-react';
import type { PairedMachine } from '../machines';
import type { UpdateState } from '../updates';
import { Alert, Badge, Button, Card, Checkbox, Dialog, EmptyState, IconButton, PageHeader, Row, Section, SkeletonRows, Tooltip, useConfirm } from './ui/kit';
import './ui/updates.css';
import './machines-data.css';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
type PeerState = { machine: string; available: boolean; launcherAvailable?: boolean; runningTurns?: number; current?: { version: string }; lastAttempt?: UpdateState['lastAttempt']; reason?: string };
const phases: Record<string,string> = { accepted: 'Preparing update', 'backing-up': 'Backing up workspace', starting: 'Starting new version', verifying: 'Verifying server health', restoring: 'Restoring workspace snapshot', done: 'Update complete', 'rolled-back': 'Rolled back', failed: 'Update failed' };
const terminal = (status?: string) => !!status && ['done','rolled-back','failed'].includes(status);
const message = (error: unknown) => error instanceof Error ? error.message : 'Update status is unavailable.';
export function useUpdateBadge(request: Request) {
  const [available, setAvailable] = useState(false);
  useEffect(() => { let alive = true, timer: ReturnType<typeof setTimeout>; async function read() { try { const state = await request<UpdateState>('/api/updates'); if (alive) setAvailable(!!state.available); } catch {} if (alive) timer = setTimeout(() => void read(), 15000); } void read(); return () => { alive = false; clearTimeout(timer); }; }, [request]);
  return available;
}
export function UpdatesPanel({ request }: { request: Request }) {
  const [state,setState] = useState<UpdateState|null>(null), [error,setError] = useState(''), [busy,setBusy] = useState(false), [reconnecting,setReconnecting] = useState(false);
  const [machines,setMachines] = useState<PairedMachine[]>([]), [peers,setPeers] = useState<PeerState[]>([]), [selected,setSelected] = useState<string[]>([]), [dialog,setDialog] = useState(false);
  const [results,setResults] = useState<{machine:string;status:string;reason?:string;id?:string}[]>([]), [fanBusy,setFanBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), confirm = useConfirm(), pending = useRef<{id:string;version:string}|null>(null), fanPending = useRef<{id:string;version:string;machines:string[]}|null>(null);
  useEffect(() => { heading.current?.focus(); try { const saved = sessionStorage.getItem('briefsip:update'); if (saved) { const value = JSON.parse(saved); if (typeof value.id === 'string' && typeof value.version === 'string') pending.current = value; } } catch { setError('Saved update request could not be read. Check update history before retrying.'); } }, []);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    async function poll() { try { const result = await request<UpdateState>('/api/updates'); if (alive) { setState(result); setReconnecting(false); if (result.lastAttempt?.id === pending.current?.id && terminal(result.lastAttempt?.status)) { pending.current = null; sessionStorage.removeItem('briefsip:update'); } } } catch (error) { if (alive) { if (pending.current) setReconnecting(true); else setError(message(error)); } } if (alive) timer = setTimeout(() => void poll(), 1000); }
    void poll(); return () => { alive = false; clearTimeout(timer); };
  }, [request]);
  useEffect(() => { let alive = true, timer: ReturnType<typeof setTimeout>; async function poll() { try { const [list, statuses] = await Promise.all([request<{machines:PairedMachine[]}>('/api/machines'),request<{machines:PeerState[]}>('/api/updates/machines')]); if (alive) { setMachines(list.machines); setPeers(statuses.machines); } } catch (error) { if (alive) setError(message(error)); } if (alive) timer = setTimeout(() => void poll(),5000); } void poll(); return () => { alive = false; clearTimeout(timer); }; }, [request]);
  async function apply() {
    if (!state?.available || busy) return;
    if (!pending.current && !await confirm({ title: `Update to ${state.available.version}?`, description: `Briefsip backs up your workspace database before restarting. If health checks fail, the previous version and database return automatically. ${state.runningTurns} running ${state.runningTurns === 1 ? 'turn will' : 'turns will'} be interrupted and can resume after restart. Files and external actions are outside database rollback.`, confirm: 'Update now' })) return;
    const command = pending.current ?? { id: crypto.randomUUID(), version: state.available.version }; pending.current = command; setBusy(true); setError('');
    try { sessionStorage.setItem('briefsip:update',JSON.stringify(command)); await request('/api/updates/apply',command); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  const feed = state?.feed ?? state?.available;
  const eligible = (machine: PairedMachine) => { const peer = peers.find(row=>row.machine===machine.id); return machine.allowUpdates && ['online','version-mismatch'].includes(machine.status) && peer?.available && peer.launcherAvailable && peer.current?.version !== feed?.version; };
  const chosen = machines.filter(machine=>selected.includes(machine.id));
  async function fanOut() {
    if (!feed || fanBusy) return;
    const command = fanPending.current ?? { id: crypto.randomUUID(), version: feed.version, machines: chosen.map(machine=>machine.id) }; fanPending.current = command; setFanBusy(true); setError('');
    try { const result = await request<{machines:typeof results}>('/api/updates/fan-out',command); setResults(result.machines); } catch (error) { setError(message(error)); } finally { setFanBusy(false); }
  }
  const attempt = state?.lastAttempt, inFlight = busy || !!attempt && !terminal(attempt.status);
  return <div className="k-page bs-root updates-page set4-page">
    <PageHeader headingRef={heading} title="Updates" actions={<IconButton label="Reload update status" onClick={()=>void request<UpdateState>('/api/updates').then(setState).catch(error=>setError(message(error)))}><RefreshCw size={15} aria-hidden /></IconButton>} />
    {error&&<Alert tone="error">{error}</Alert>}
    {reconnecting&&<Alert title="Waiting for server restart">Reconnecting to check whether the update succeeded or rolled back. Keep this window open.</Alert>}
    {!state?<SkeletonRows/>:<>
      <Section title="This computer"><Card>
        <Row leading={<Monitor size={17} aria-hidden/>} title="Current version" meta={state.current.id==='development'?'Development':state.current.commit.slice(0,8)} trailing={<Badge>{state.current.version}</Badge>}/>
        {state.previous&&<Row title="Previous version" trailing={<Badge>{state.previous.version}</Badge>}/>}
        {!state.launcherAvailable && <Row title={<Tooltip content={<span className="bs-root set4-tooltip">{"Start Briefsip through its launcher to enable database backups, in-app updates and automatic rollback."}</span>}><span tabIndex={0}>Updates unavailable</span></Tooltip>} />}
        {state.available?<><Row leading={<Download size={17} aria-hidden/>} title={`Briefsip ${state.available.version}`} meta={`Published ${new Date(state.available.created).toLocaleDateString()}`} trailing={<Badge tone="brand">Update available</Badge>}/><div className="updates-release"><p className="updates-notes">{state.available.notes}</p><div className="updates-actions"><span className="k-field__hint">{state.runningTurns} running {state.runningTurns===1?'turn':'turns'}</span><Button variant="primary" disabled={!state.launcherAvailable||inFlight} busy={busy} onClick={()=>void apply()}>{pending.current?'Retry update':'Update now'}</Button></div></div></>:<Row title="No newer release available" />}
      </Card></Section>
      {attempt&&<Section title="Last update"><Alert tone={['rolled-back','failed'].includes(attempt.status)?'warn':'info'} title={phases[attempt.status]??attempt.status}><span role="status">Version {attempt.version}{attempt.reason?` - ${attempt.reason}`:''}</span></Alert><ol className="updates-steps" aria-label="Update progress">{['backing-up','starting','verifying','done'].map((step,index)=><li key={step} aria-current={attempt.status===step?'step':undefined}><span>{index+1}</span>{phases[step]}</li>)}</ol></Section>}
      <Section title="Paired machines" actions={selected.length > 0 ? <Button disabled={!feed} onClick={()=>{setResults([]);fanPending.current=null;setDialog(true);}}>Update selected ({selected.length})</Button> : undefined}>
        {!machines.length?<EmptyState title="No paired machines" />:<Card>{machines.map(machine=>{const peer=peers.find(row=>row.machine===machine.id);return <Row key={machine.id} leading={<Checkbox label={<span className="sr-only">Select {machine.name}</span>} checked={selected.includes(machine.id)} disabled={!feed||!eligible(machine)} onChange={checked=>setSelected(ids=>checked?[...ids,machine.id]:ids.filter(id=>id!==machine.id))}/>} title={machine.name} meta={<>{peer?.reason??(!machine.allowUpdates?'Remote updates off':!['online','version-mismatch'].includes(machine.status)?machine.status==='unauthorized'?'Access revoked':'Machine offline':eligible(machine)?'Ready to update':peer?.current?.version===feed?.version?'Up to date':!peer?.launcherAvailable?'Launcher unavailable':'Updates unavailable')}<span>{peer?.runningTurns??machine.agents.filter(agent=>agent.status==='running').length} running turns</span></>} trailing={<Badge>{peer?.current?.version??machine.version}</Badge>}/>;})}</Card>}
      </Section>
    </>}
    <Dialog open={dialog} onOpenChange={open=>{if(!fanBusy)setDialog(open);}} title={`Update ${chosen.length} ${chosen.length===1?'machine':'machines'}?`} description={`Briefsip ${feed?.version??''}. Each machine backs up its database and rolls back automatically if health checks fail.`} size="lg" footer={<><Button disabled={fanBusy} onClick={()=>setDialog(false)}>{results.length?'Close':'Cancel'}</Button><Button variant="primary" busy={fanBusy} disabled={fanBusy||!!results.length||!chosen.length} onClick={()=>void fanOut()}>Update {chosen.length} {chosen.length===1?'machine':'machines'}</Button></>}>
      <div className="updates-table-scroll set4-detail"><table className="updates-table"><thead><tr><th>Machine</th><th>Current version</th><th>Running turns</th><th>Status</th></tr></thead><tbody>{chosen.map(machine=>{const peer=peers.find(row=>row.machine===machine.id),result=results.find(row=>row.machine===machine.id),attempt=peer?.lastAttempt;return <tr key={machine.id}><th scope="row">{machine.name}</th><td>{peer?.current?.version??machine.version}</td><td>{peer?.runningTurns??0}</td><td>{result?.status==='failed'?result.reason:result&&attempt?.id===result.id?phases[attempt!.status]:result?'Accepted':fanBusy?'Preparing release':'Ready'}</td></tr>;})}</tbody></table></div>
      <p className="k-field__hint">{chosen.reduce((n,m)=>n+(peers.find(p=>p.machine===m.id)?.runningTurns??0),0)} running turns will be interrupted and can resume after restart. Files and external actions are outside database rollback.</p>
      {error&&<Alert tone="error">{error}</Alert>}
    </Dialog>
  </div>;
}
