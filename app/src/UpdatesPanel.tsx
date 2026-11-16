import { usePolling } from './hooks/usePolling';
// Machine summary and restart confirmation adapted from T3 UpdateEverythingDialog (MIT).
import { useEffect, useRef, useState } from 'react';
import { Download, Monitor } from 'lucide-react';
import type { PairedMachine } from '../machines';
import type { UpdateState } from '../updates';
import { Alert, Badge, Button, Card, Dialog, EmptyState, PageHeader, Row, Section, SkeletonRows, Switch, useConfirm } from './ui/kit';
import './ui/updates.css';
import './machines-data.css';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
type PeerState = { machine: string; available: boolean; launcherAvailable?: boolean; runningTurns?: number; current?: { version: string }; lastAttempt?: UpdateState['lastAttempt']; reason?: string };
const phases: Record<string,string> = { accepted: 'Preparing update', 'backing-up': 'Backing up workspace', starting: 'Starting new version', verifying: 'Verifying server health', restoring: 'Restoring workspace snapshot', done: 'Update complete', 'rolled-back': 'Rolled back', failed: 'Update failed' };
const terminal = (status?: string) => !!status && ['done','rolled-back','failed'].includes(status);
const message = (error: unknown) => error instanceof Error ? error.message : 'Update status is unavailable.';
export function useUpdateBadge(request: Request) {
  const [available, setAvailable] = useState(false);
  usePolling(async signal => { try { const state = await request<UpdateState>('/api/updates'); if (!signal.aborted) setAvailable(state.launcherAvailable && !!state.available); } catch {}  }, { interval: 15000 }, [request]);
  return available;
}
export function UpdatesPanel({ request }: { request: Request }) {
  const [state,setState] = useState<UpdateState|null>(null), [error,setError] = useState(''), [busy,setBusy] = useState(false), [reconnecting,setReconnecting] = useState(false);
  const [machines,setMachines] = useState<PairedMachine[]>([]), [peers,setPeers] = useState<PeerState[]>([]), [selected,setSelected] = useState<string[]>([]), [dialog,setDialog] = useState(false);
  const [results,setResults] = useState<{machine:string;status:string;reason?:string;id?:string}[]>([]), [fanBusy,setFanBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), confirm = useConfirm(), pending = useRef<{id:string;version:string}|null>(null), fanPending = useRef<{id:string;version:string;machines:string[]}|null>(null);
  useEffect(() => { heading.current?.focus(); try { const saved = sessionStorage.getItem('briefsip:update'); if (saved) { const value = JSON.parse(saved); if (typeof value.id === 'string' && typeof value.version === 'string') pending.current = value; } } catch { setError('Saved update request could not be read. Check update history before retrying.'); } }, []);
  usePolling(async signal => { try { const result = await request<UpdateState>('/api/updates'); if (!signal.aborted) { setState(result); setReconnecting(false); if (result.lastAttempt?.id === pending.current?.id && terminal(result.lastAttempt?.status)) { pending.current = null; sessionStorage.removeItem('briefsip:update'); } } } catch (error) { if (!signal.aborted) { if (pending.current) setReconnecting(true); else setError(message(error)); } }  }, { interval: 1000 }, [request]);
  usePolling(async signal => { try { const [list, statuses] = await Promise.all([request<{machines:PairedMachine[]}>('/api/machines'),request<{machines:PeerState[]}>('/api/updates/machines')]); if (!signal.aborted) { setMachines(list.machines); setPeers(statuses.machines); } } catch (error) { if (!signal.aborted) setError(message(error)); }  }, { interval: 5000 }, [request]);
  async function apply() {
    if (!state?.launcherAvailable || !state.available || busy) return;
    if (!pending.current && !await confirm({ title: `Update to ${state.available.version}?`, description: `Briefsip backs up your workspace database before restarting. If health checks fail, the previous version and database return automatically. ${state.runningTurns} running ${state.runningTurns === 1 ? 'turn will' : 'turns will'} be interrupted and can resume after restart. Files and external actions are outside database rollback.`, confirm: 'Update now' })) return;
    const command = pending.current ?? { id: crypto.randomUUID(), version: state.available.version }; pending.current = command; setBusy(true); setError('');
    try { sessionStorage.setItem('briefsip:update',JSON.stringify(command)); await request('/api/updates/apply',command); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  const feed = state?.feed ?? state?.available;
  const eligible = (machine: PairedMachine) => { const peer = peers.find(row=>row.machine===machine.id); return !!feed && machine.allowUpdates && ['online','version-mismatch'].includes(machine.status) && peer?.available && peer.launcherAvailable && peer.current?.version !== feed?.version; };
  function peerStatus(machine: PairedMachine) {
    const peer = peers.find(row => row.machine === machine.id);
    if (!['online', 'version-mismatch'].includes(machine.status)) return machine.status === 'unauthorized' ? 'Access revoked' : 'Machine offline';
    if (eligible(machine)) return 'Ready to update';
    if ((peer?.current?.version ?? machine.version) === state?.current?.version) return 'Up to date';
    if (!machine.allowUpdates) return 'Remote updates off';
    return peer?.reason ?? (peer?.current?.version === feed?.version ? 'Up to date' : !peer?.launcherAvailable ? 'Launcher unavailable' : 'Updates unavailable');
  }
  const chosen = machines.filter(machine=>selected.includes(machine.id) && (dialog || eligible(machine)));
  async function fanOut() {
    if (!feed || fanBusy) return;
    const command = fanPending.current ?? { id: crypto.randomUUID(), version: feed.version, machines: chosen.map(machine=>machine.id) }; fanPending.current = command; setFanBusy(true); setError('');
    try { const result = await request<{machines:typeof results}>('/api/updates/fan-out',command); setResults(result.machines); } catch (error) { setError(message(error)); } finally { setFanBusy(false); }
  }
  const attempt = state?.lastAttempt, inFlight = busy || !!attempt && !terminal(attempt.status);
  return <div className="k-page bs-root updates-page set4-page">
    <PageHeader headingRef={heading} title="Updates" />
    {error&&<Alert tone="error">{error}</Alert>}
    {reconnecting&&<Alert title="Waiting for server restart">Reconnecting to check whether the update succeeded or rolled back. Keep this window open.</Alert>}
    {!state?<SkeletonRows/>:<>
      <Section title="This device"><Card>
        <Row leading={<Monitor size={17} aria-hidden/>} title="Current version" meta={state.current.id==='development'?'Development':state.current.commit.slice(0,8)} trailing={<Badge>{state.current.version}</Badge>}/>
        {state.launcherAvailable && state.previous&&<Row title="Previous version" trailing={<Badge>{state.previous.version}</Badge>}/>}
        {state.launcherAvailable && (state.available?<><Row leading={<Download size={17} aria-hidden/>} title={`Briefsip ${state.available.version}`} meta={`Published ${new Date(state.available.created).toLocaleDateString()}`} trailing={<Badge tone="brand">Update available</Badge>}/><div className="updates-release"><p className="updates-notes">{state.available.notes}</p><div className="updates-actions"><span className="k-field__hint">{state.runningTurns} running {state.runningTurns===1?'turn':'turns'}</span><Button variant="primary" disabled={inFlight} busy={busy} onClick={()=>void apply()}>{pending.current?'Retry update':'Update now'}</Button></div></div></>:<Row title="Up to date" />)}
      </Card></Section>
      {attempt&&<Section title="Last update"><Alert tone={['rolled-back','failed'].includes(attempt.status)?'warn':'info'} title={phases[attempt.status]??attempt.status}><span role="status">Version {attempt.version}{attempt.reason?` - ${attempt.reason}`:''}</span></Alert><ol className="updates-steps" aria-label="Update progress">{['backing-up','starting','verifying','done'].map((step,index)=><li key={step} aria-current={attempt.status===step?'step':undefined}><span>{index+1}</span>{phases[step]}</li>)}</ol></Section>}
      <Section title="Paired machines" actions={chosen.length > 0 ? <Button onClick={()=>{setSelected(chosen.map(machine=>machine.id));setResults([]);fanPending.current=null;setDialog(true);}}>Update selected ({chosen.length})</Button> : undefined}>
        {!machines.length?<EmptyState title="No paired machines" />:<Card>{machines.map(machine=>{const peer=peers.find(row=>row.machine===machine.id);return <Row key={machine.id} title={machine.name} meta={<>{peerStatus(machine)}<span>{peer?.runningTurns??machine.agents.filter(agent=>agent.status==='running').length} running turns</span></>} trailing={<><Badge>{peer?.current?.version??machine.version}</Badge>{eligible(machine) && <label className="k-inline"><span>Also update {machine.name}</span><Switch label={`Also update ${machine.name}`} checked={selected.includes(machine.id)} onChange={checked=>setSelected(ids=>checked?[...ids,machine.id]:ids.filter(id=>id!==machine.id))}/></label>}</>}/>;})}</Card>}
      </Section>
    </>}
    <Dialog open={dialog} onOpenChange={open=>{if(!fanBusy)setDialog(open);}} title={`Update ${chosen.length} ${chosen.length===1?'machine':'machines'}?`} description={`Briefsip ${feed?.version??''}. Each machine backs up its database and rolls back automatically if health checks fail.`} size="lg" footer={<><Button disabled={fanBusy} onClick={()=>setDialog(false)}>{results.length?'Close':'Cancel'}</Button><Button variant="primary" busy={fanBusy} disabled={fanBusy||!!results.length||!chosen.length} onClick={()=>void fanOut()}>Update {chosen.length} {chosen.length===1?'machine':'machines'}</Button></>}>
      <div className="updates-table-scroll set4-detail"><table className="updates-table"><thead><tr><th>Machine</th><th>Current version</th><th>Running turns</th><th>Status</th></tr></thead><tbody>{chosen.map(machine=>{const peer=peers.find(row=>row.machine===machine.id),result=results.find(row=>row.machine===machine.id),attempt=peer?.lastAttempt;return <tr key={machine.id}><th scope="row">{machine.name}</th><td>{peer?.current?.version??machine.version}</td><td>{peer?.runningTurns??0}</td><td>{result?.status==='failed'?result.reason:result&&attempt?.id===result.id?phases[attempt!.status]:result?'Accepted':fanBusy?'Preparing release':'Ready'}</td></tr>;})}</tbody></table></div>
      <p className="k-field__hint">{chosen.reduce((n,m)=>n+(peers.find(p=>p.machine===m.id)?.runningTurns??0),0)} running turns will be interrupted and can resume after restart. Files and external actions are outside database rollback.</p>
      {error&&<Alert tone="error">{error}</Alert>}
    </Dialog>
  </div>;
}
