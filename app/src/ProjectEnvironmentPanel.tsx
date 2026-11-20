import { readProductStorage, removeProductStorage } from './rename-storage.ts';
import { getNonce } from 'get-nonce';
import { useEffect, useRef, useState } from 'react';
import { Ellipsis, KeyRound, Plus, RefreshCw } from 'lucide-react';
import { ActionMenu, Alert, Badge, Button, Card, Dialog, EmptyState, Field, IconButton, Input, PageHeader, Row, Section, SkeletonRows, Switch, useConfirm, RecoveryAlert } from './ui/kit';
type Request = <T>(path: string, body?: unknown) => Promise<T>;
type Variable = { name: string; updated: number; set: true };
type State = { items: Variable[]; exposeComputer: boolean; revision: number };
type Command = { path: string; body: { id: string; name?: string; updated?: number | null; confirmed?: boolean; exposeComputer?: boolean; revision?: number } };
export function ProjectEnvironmentPanel({project,request}: {project:string;request:Request}) {
  const storage=`minarbot:project-environment:${project}`,base=`/api/projects/${project}/environment`;
  const [data,setData]=useState<State|null>(null),[name,setName]=useState(''),[value,setValue]=useState(''),[editing,setEditing]=useState<Variable|null>(null),[pending,setPending]=useState<Command|null>(null),[invalid,setInvalid]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const [showForm,setShowForm]=useState(false);
  const confirm=useConfirm(),flight=useRef(false),alive=useRef(true),nameInput=useRef<HTMLInputElement>(null),valueInput=useRef<HTMLInputElement>(null);
  async function reload(){const state=await request<State>(base);if(alive.current)setData(state);}
  useEffect(()=>{alive.current=true;try{const raw=readProductStorage(sessionStorage, storage);if(raw){const command=JSON.parse(raw);if(!command || ![base,base+'/remove',base+'/settings'].includes(command.path) || !command.body || !/^[a-f0-9-]{36}$/.test(command.body.id) || Object.keys(command.body).some(key=>!['id','name','updated','confirmed','exposeComputer','revision'].includes(key)))throw new Error();setPending(command);if(command.body.name)setName(command.body.name);}}catch{setInvalid(true);}void reload().catch(error=>setError(error.message));return()=>{alive.current=false;};},[project,request]);
  const locked=busy || !!pending || invalid;
  async function execute(command:Command){
    if(flight.current || invalid)return;
    const saving=command.path===base;
    if(saving && !value){setError('Paste the secret value again to retry this save.');valueInput.current?.focus();return;}
    flight.current=true;setBusy(true);setError('');setNotice('');
    try{sessionStorage.setItem(storage,JSON.stringify(command));setPending(command);await request(command.path,{...command.body,...(saving?{value}:{})});removeProductStorage(sessionStorage, storage);if(alive.current){setPending(null);setValue('');setName('');setEditing(null);setShowForm(false);setNotice(saving?'Environment value saved.':command.path.endsWith('/remove')?'Environment value deleted.':'Computer environment setting saved.');await reload();}}
    catch(error){if(alive.current)setError(error instanceof Error?error.message:'Change is not confirmed. Retry the saved request.');}
    finally{flight.current=false;if(alive.current)setBusy(false);}
  }
  const recoveryNotice = (pending || invalid)&&<RecoveryAlert inFlight={busy} tone="warn" title={invalid?'Recovery unavailable':'Not confirmed'} actions={<>{pending?.path===base&&<Button size="sm" onClick={()=>setShowForm(true)}>Enter value</Button>}{pending&&<Button size="sm" disabled={busy || pending.path===base&&!value} onClick={()=>void execute(pending)}>Try again</Button>}<Button size="sm" disabled={busy} onClick={async()=>{if(await confirm({title:'Discard saved request?',description:'Check the latest values first. The change may already have succeeded. Clearing this request does not undo saved changes.',confirm:'Discard request'})){try{removeProductStorage(sessionStorage, storage);setPending(null);setInvalid(false);setValue('');await reload();}catch(error){setError(error instanceof Error?error.message:'Recovery could not clear.');}}}}>Discard request</Button></>}>{pending?.path===base?'Enter the same value to retry. The value was not saved in browser storage.':undefined}</RecoveryAlert>;
  return <div className="k-page bs-root project-environment bs-set3-environment">
    <style nonce={getNonce()}>{`.bs-root.bs-set3-environment > .k-page-head { padding-right: 40px; } .bs-root.bs-set3-environment .k-row__title { white-space: normal; overflow-wrap: anywhere; } .bs-root.bs-set3-environment .k-row__meta { overflow-wrap: anywhere; }`}</style>
    <PageHeader title="Environment" actions={<><IconButton label="Reload environment" disabled={busy} onClick={()=>void reload().catch(error=>setError(error.message))}><RefreshCw size={15} aria-hidden/></IconButton><Button variant="primary" icon={<Plus size={14} aria-hidden/>} disabled={locked} onClick={()=>{setEditing(null);setName('');setValue('');setShowForm(true);}}>Add variable</Button></>}/>
    {error&&<Alert tone="error">{error}</Alert>}{notice&&<p role="status" className="sr-only">{notice}</p>}
    {recoveryNotice}
    <div className="k-stack">{!data?!error&&<><span role="status" className="sr-only">Loading environment...</span><SkeletonRows/></>:data.items.length?<Card>{data.items.map(row=><Row key={row.name} leading={<KeyRound size={16} aria-hidden/>} title={row.name} meta={`Updated ${new Date(row.updated).toLocaleString()}`} trailing={<><Badge tone="success">Set</Badge><ActionMenu label={`Variable actions for ${row.name}`} trigger={<button type="button" className="k-icon-btn" aria-label={`Variable actions for ${row.name}`} disabled={locked}><Ellipsis size={16} aria-hidden/></button>} items={[
      {label:'Replace',onSelect:()=>{setEditing(row);setName(row.name);setValue('');setShowForm(true);valueInput.current?.focus();}},
      'separator',
      {label:'Delete',danger:true,onSelect:async()=>{if(await confirm({title:`Delete ${row.name}?`,description:'Future project runs will no longer receive this value. Saved files and completed actions remain.',confirm:'Delete variable',danger:true}))void execute({path:base+'/remove',body:{id:crypto.randomUUID(),name:row.name,updated:row.updated,confirmed:true}});}},
    ]}/></>}/>)}</Card>:<EmptyState icon={<KeyRound size={18} aria-hidden/>} title="No environment variables" />}</div>
    <Dialog open={showForm} onOpenChange={setShowForm} title={editing?`Replace ${editing.name}`:'Add variable'} footer={<Button type="submit" form="project-environment-form" variant="primary" busy={busy} disabled={busy||invalid||!name||!value||!!pending&&pending.path!==base}>{pending?'Try again':editing?'Replace value':'Add variable'}</Button>}>
      {error&&<Alert tone="error">{error}</Alert>}{recoveryNotice}
      <form id="project-environment-form" className="k-stack" onSubmit={event=>{event.preventDefault();void (async()=>{if(editing&&!pending&&!await confirm({title:`Replace ${editing.name}?`,description:'Future project runs will use the new value. The old value cannot be shown again.',confirm:'Replace value',danger:true}))return;await execute(pending??{path:base,body:{id:crypto.randomUUID(),name,updated:editing?.updated??null}});})();}}>
        <Field label="Variable name"><Input ref={nameInput} required pattern="[A-Z_][A-Z0-9_]{0,63}" maxLength={64} placeholder="SERVICE_API_TOKEN" value={name} disabled={locked||!!editing} autoComplete="off" spellCheck={false} onChange={event=>setName(event.target.value)}/></Field>
        <Field label="Secret value"><Input ref={valueInput} required type="password" autoComplete="new-password" spellCheck={false} value={value} disabled={busy||invalid||!!pending&&pending.path!==base} onChange={event=>setValue(event.target.value)}/></Field>
      </form>
    </Dialog>

    <Section title="Agent computer">{!data ? !error && <SkeletonRows count={1} /> : <Card><Row title="Expose environment to the agent computer" trailing={<Switch label="Expose environment to the agent computer" checked={data?.exposeComputer??false} disabled={locked||!data} onChange={async enabled=>{if(enabled&&!await confirm({title:'Expose project secrets to the agent computer?',description:'Desktop applications and websites may access or display these values. Screenshots can reveal them, and text redaction cannot remove secrets from images. The desktop restarts before and after each exposed action.',confirm:'Expose environment',danger:true}))return;void execute({path:base+'/settings',body:{id:crypto.randomUUID(),revision:data!.revision,exposeComputer:enabled,confirmed:enabled}});}}/>}/></Card>}</Section>
  </div>;
}
