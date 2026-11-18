import { useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Alert, Badge, Button, Card, CodeBlock, Collapsible, Row, useConfirm, RecoveryAlert } from './ui/kit';
import { restoreConnectedAppCommand, type ConnectedAppCommand } from './connected-app-command';
export type AppApproval = { id: string; toolkit: string; tool: string; slug: string; account: string; arguments: Record<string, unknown>; state: string; decision: string; revision: number };
export function ApprovalCard({ approval, path, status, archived, request }: { approval: AppApproval; path: string; status: string; archived: boolean; request: <T>(path: string, data?: unknown) => Promise<T> }) {
  const key = `briefsip:app-approval:${path}:${approval.id}`, confirm = useConfirm();
  const [recovery] = useState(()=>{try{return {pending:restoreConnectedAppCommand(sessionStorage.getItem(key)),invalid:false};}catch{return {pending:null,invalid:true};}});
  const [pending,setPending] = useState(recovery.pending), [invalid,setInvalid] = useState(recovery.invalid), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const mounted=useRef(false), sending=useRef(false), heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(approval.state!=='approval'){try{sessionStorage.removeItem(key);}catch{/* Server receipt remains authoritative. */}setPending(null);}},[approval.state,key]);
  async function send(decision:'allow'|'always'|'deny') {
    if(sending.current || invalid || archived || status!=='queued' || approval.state!=='approval')return;
    const command:ConnectedAppCommand=pending ?? {path:`${path}/app-approvals/${encodeURIComponent(approval.id)}`,body:{id:crypto.randomUUID(),revision:approval.revision,decision}};
    if(command.path!==`${path}/app-approvals/${encodeURIComponent(approval.id)}`){setInvalid(true);return;}
    try{
      restoreConnectedAppCommand(JSON.stringify(command));sessionStorage.setItem(key,JSON.stringify(command));setPending(command);sending.current=true;setBusy(true);setError('');
      await request(command.path,command.body);
      if(mounted.current){sessionStorage.removeItem(key);setPending(null);heading.current?.focus();}
    }catch(error){if(mounted.current)setError(error instanceof Error?error.message:'Approval is not confirmed. Retry the same decision.');}
    finally{sending.current=false;if(mounted.current)setBusy(false);}
  }
  const open=approval.state==='approval', disabled=busy || archived || status!=='queued' || invalid;
  const outcome=approval.decision==='revoked'?'App access removed':approval.state==='uncertain'?'Result uncertain':approval.state==='running'?'Running approved action':approval.decision==='deny'?'Not allowed':approval.decision==='always'?'Always allowed for this agent':approval.state==='done'?'Allowed once':'Approved, waiting to run';
  const summary=Object.entries(approval.arguments).slice(0,6).map(([name,value])=>`${name}: ${typeof value==='string'?value.slice(0,160):JSON.stringify(value).slice(0,160)}`).join('\n') || 'No arguments';
  return <section className="bs-root k-stack" aria-label={`Approval for ${approval.tool}`}>
    <Card><div className="k-stack" style={{padding:14}}>
      <Row leading={<ShieldCheck size={18} aria-hidden />} title={<h3 ref={heading} tabIndex={-1} className="k-section__title">{approval.tool}</h3>} meta={`${({gmail:'Gmail',slack:'Slack',github:'GitHub',googlecalendar:'Google Calendar'}[approval.toolkit] ?? approval.toolkit)} · ${approval.account}`} trailing={<Badge tone={open?'warn':'neutral'}>{open?'Approval needed':outcome}</Badge>} />
      <p className="k-field__hint" style={{margin:0}}>{open?'This action may change data in your app. Review its arguments before allowing it.':outcome}</p>
      <p className="message-plain" style={{overflowWrap:'anywhere',margin:0}}>{summary}</p>
      <Collapsible title="All arguments"><CodeBlock label={`Arguments for ${approval.tool}`}>{JSON.stringify(approval.arguments,null,2)}</CodeBlock></Collapsible>
      {open && <>
        <p className="k-field__hint" style={{margin:0}}>Always allow applies to this action, app account, agent, and conversation scope. Change it in this project’s Connected apps tab, or Settings &gt; Connected apps for direct chats.</p>
        {error && <Alert tone="error">{error}</Alert>}
        {(pending || invalid) && <RecoveryAlert inFlight={busy} tone="warn" title={invalid?'Approval recovery data is invalid':'Decision is not confirmed'} actions={<>{pending && <Button size="sm" disabled={disabled} onClick={()=>void send(pending.body.decision!)}>Retry saved decision</Button>}<Button size="sm" disabled={busy} onClick={async()=>{if(!await confirm({title:'Discard saved decision?',description:'The decision may already be saved. Check the transcript before making another decision.',confirm:'Discard recovery',danger:true}))return;try{sessionStorage.removeItem(key);setPending(null);setInvalid(false);}catch{setError('Recovery data could not be removed.');}}}>Discard recovery</Button></>} />}
        <div className="k-row-actions"><Button size="sm" disabled={disabled || !!pending} onClick={()=>void send('deny')}>Don't allow</Button><Button size="sm" disabled={disabled || !!pending} onClick={()=>void send('always')}>Always allow for this agent</Button><Button size="sm" variant="primary" disabled={disabled || !!pending} onClick={()=>void send('allow')}>Allow once</Button></div>
        {(archived || status!=='queued') && <Alert>Approval is unavailable while this task is stopped or its conversation is archived.</Alert>}
      </>}
    </div></Card>
  </section>;
}
