import { useEffect, useRef, useState } from 'react';
import { Blocks, ChevronLeft, ChevronRight, Ellipsis, RefreshCw, Search } from 'lucide-react';
import { ActionMenu, Alert, Badge, Button, Card, EmptyState, Field, IconButton, Input, PageHeader, Row, Section, Select, SkeletonRows, Switch, useConfirm } from './ui/kit';
import type { LocalProject } from '../local-projects';
import { restoreConnectedAppCommand, type ConnectedAppCommand } from '../connected-app-command';
type Toolkit = { slug: string; name: string; description: string; managedAuth: boolean };
type Catalog = { configured: boolean; items: Toolkit[]; categories: { id: string; name: string }[]; next_after: string | null };
type KeyStatus = { source: 'settings' | 'environment' | 'none'; revision: number; last4?: string };
type Account = { id: string; toolkit: string; status: string };
type Grant = { toolkit: string; enabled: boolean; revision: number };
type Policy = { toolkit: string; tool: string; account: string; fingerprint: string };
export function ConnectedAppsPanel({ agents, request, project, onInstallationAppsChange }: { project?: LocalProject; onInstallationAppsChange?: (enabled: boolean) => Promise<void>; agents: { id: string; name: string }[]; request: <T>(path: string, data?: unknown) => Promise<T> }) {
  const storage = 'briefsip:connected-app-command'+(project?`:${project.id}`:'');
  const confirm = useConfirm(), heading = useRef<HTMLHeadingElement>(null), mounted = useRef(false), sending = useRef(false);
  const [recovery] = useState(() => { try { return { pending: restoreConnectedAppCommand(sessionStorage.getItem(storage)), invalid: false }; } catch { return { pending: null, invalid: true }; } });
  const [pending,setPending] = useState(recovery.pending), [invalid,setInvalid] = useState(recovery.invalid);
  const [catalog,setCatalog] = useState<Catalog | null>(null), [accounts,setAccounts] = useState<Account[] | null>(null), [grants,setGrants] = useState<Grant[] | null>(null), [policies,setPolicies] = useState<Policy[] | null>(null), [keyStatus,setKeyStatus] = useState<KeyStatus | null>(null), [key,setKey] = useState(''), [replacing,setReplacing] = useState(false);
  const [agent,setAgent] = useState(agents[0]?.id ?? ''), [search,setSearch] = useState(''), [query,setQuery] = useState(''), [category,setCategory] = useState(''), [cursors,setCursors] = useState(['']);
  const [refresh,setRefresh] = useState(0), [error,setError] = useState(''), [busy,setBusy] = useState(false), [link,setLink] = useState('');
  const keySave=pending?.path==='/api/connected-apps/key', locked = busy || !!pending || invalid, after=cursors.at(-1)!;
  useEffect(() => { mounted.current=true; heading.current?.focus(); return ()=>{mounted.current=false;}; },[]);
  useEffect(()=>{
    let stale=false; setCatalog(null); setAccounts(null); setKeyStatus(null); setGrants(null); setPolicies(null); setError('');
    void request<KeyStatus>('/api/connected-apps/key').then(status=>{if(!stale)setKeyStatus(status);}).catch(error=>{if(!stale)setError(error.message || 'Composio key status could not load.');});
    const params=new URLSearchParams({search:query,category,after});
    void Promise.all([request<Catalog>(`/api/connected-apps?${params}`),request<{items:Account[]}>('/api/connected-apps/accounts'), agent ? request<{items:Grant[]}>(`/api/agents/${agent}/connected-apps`) : Promise.resolve({items:[]}),agent ? request<{items:Policy[]}>(`/api/agents/${agent}/connected-app-policies`) : Promise.resolve({items:[]})]).then(([catalog,accounts,grants,policies])=>{if(!stale){setCatalog(catalog);setAccounts(accounts.items);setGrants(grants.items);setPolicies(policies.items);}}).catch(error=>{if(!stale)setError(error.message || 'Connected apps could not load.');});
    return ()=>{stale=true;};
  },[agent,query,category,after,refresh]);
  async function execute(command:ConnectedAppCommand,connect=false) {
    if(sending.current || invalid)return;
    if(command.path==='/api/connected-apps/key' && !key.trim()){setError('Paste the Composio API key again to retry this save.');return;}
    let popup:Window|null=null;
    if(connect){popup=window.open('about:blank','_blank'); if(popup)popup.opener=null;}
    try {
      restoreConnectedAppCommand(JSON.stringify(command)); sessionStorage.setItem(storage,JSON.stringify(command)); setPending(command); sending.current=true; setBusy(true); setError('');
      const result=await request<{redirect_url?:string}>(command.path,command.path==='/api/connected-apps/key'?{...command.body,key}:command.body);
      if(result.redirect_url){if(popup)popup.location.href=result.redirect_url; if(mounted.current)setLink(result.redirect_url);} else popup?.close();
      if(sessionStorage.getItem(storage)===JSON.stringify(command))sessionStorage.removeItem(storage);
      if(mounted.current){if(command.path.startsWith('/api/connected-apps/key')){setKey('');setReplacing(false);setLink('');}setPending(null);setRefresh(n=>n+1);}
    }catch(error){popup?.close();if(mounted.current)setError(error instanceof Error?error.message:'Change is not confirmed. Retry the saved request.');}
    finally{sending.current=false;if(mounted.current)setBusy(false);}
  }
  async function discard(){if(!await confirm({title:'Discard saved request?',description:'The change may already have succeeded. Connected accounts and access reload before another change.',confirm:'Discard recovery',danger:true}))return;try{sessionStorage.removeItem(storage);setPending(null);setInvalid(false);setRefresh(n=>n+1);}catch{setError('Browser recovery data could not be removed.');}}
  async function saveKey() {
    if(sending.current || invalid || !keyStatus || !key.trim() || pending && !keySave)return;
    await execute(pending ?? {path:'/api/connected-apps/key',body:{id:crypto.randomUUID(),revision:keyStatus.revision}});
  }
  async function removeKey() {
    if(sending.current || locked || keyStatus?.source!=='settings')return;
    if(!await confirm({title:'Remove Composio API key?',description:'Connected accounts, agent access, pending approvals, and saved "Always allow" choices will be reset. Existing accounts remain in the old Composio project.',confirm:'Remove key',danger:true}))return;
    await execute({path:'/api/connected-apps/key/remove',body:{id:crypto.randomUUID(),revision:keyStatus.revision}});
  }
  const title=(slug:string)=>catalog?.items.find(row=>row.slug===slug)?.name ?? ({gmail:'Gmail',slack:'Slack',github:'GitHub',googlecalendar:'Google Calendar'}[slug] ?? slug);
  const connected=[...new Set(accounts?.filter(row=>row.status==='ACTIVE').map(row=>row.toolkit) ?? [])];
  return <div className="k-page bs-root">
    <PageHeader headingRef={heading} title="Connected apps" description={project?'Connect accounts for this project, then choose which members may use them.':'Connect your apps, then choose which agents can use them.'} actions={<IconButton label="Reload connected apps" disabled={busy} onClick={()=>setRefresh(n=>n+1)}><RefreshCw size={15} aria-hidden /></IconButton>} />
    {error && <Alert tone="error">{error}</Alert>}
    {invalid && <Alert tone="error" title="Recovery data could not be read" actions={<Button size="sm" onClick={()=>void discard()}>Discard recovery</Button>} />}
    {pending && <Alert tone="warn" title="Change is not confirmed" actions={<><Button size="sm" busy={busy} disabled={keySave && !key.trim()} onClick={()=>void execute(pending,pending.path.includes('/connect/'))}>Retry saved request</Button><Button size="sm" disabled={busy} onClick={()=>void discard()}>Discard recovery</Button></>}>{keySave?'Paste the same API key again below. Only the request ID and revision were saved for recovery.':'Retry keeps the same request ID. An uncertain connection change must be checked before starting a new request.'}</Alert>}
    {!project && <Section title="Composio API key">
      {!keyStatus ? <SkeletonRows count={1} /> : keyStatus.source==='environment' && !keySave ? <Alert title="From server environment">This Composio API key comes from the server environment and cannot be removed here.</Alert> : <Card>
        {keyStatus.source==='settings' && !replacing && !keySave ? <Row title="Composio API key" meta={<Badge tone="success">Saved</Badge>} trailing={<><Button size="sm" disabled={locked} onClick={async()=>{if(sending.current || locked)return;if(await confirm({title:'Replace Composio API key?',description:'Connected accounts, agent access, pending approvals, and saved "Always allow" choices will be reset. Existing accounts remain in the old Composio project.',confirm:'Replace key',danger:true}))setReplacing(true);}}>Replace</Button><Button size="sm" disabled={locked} onClick={()=>void removeKey()}>Remove</Button></>} /> : <form className="k-stack" style={{padding:14}} onSubmit={event=>{event.preventDefault();void saveKey();}}>
          <Field label={keySave?'Paste the same API key again':'Composio API key'} hint={<>Use your own Composio project. Get an API key at <a href="https://platform.composio.dev/" target="_blank" rel="noreferrer">platform.composio.dev</a>.</>}><Input type="password" autoComplete="off" spellCheck={false} maxLength={4096} value={key} disabled={busy || invalid} onChange={event=>setKey(event.target.value)} /></Field>
          <div className="k-row-actions"><Button type="submit" variant="primary" busy={busy} disabled={busy || invalid || !key.trim() || !!pending && !keySave}>{keySave?'Retry save':'Save key'}</Button>{replacing && !pending && <Button disabled={busy} onClick={()=>{setReplacing(false);setKey('');}}>Cancel</Button>}</div>
        </form>}
      </Card>}
    </Section>}
    {project && <Section title="Installation apps"><Card><Row title="Also allow installation apps" meta="Member agents may also use apps granted to them in Settings. Project accounts take priority for the same toolkit." trailing={<Switch label="Also allow installation apps" checked={project.allowInstallationApps} disabled={locked} onChange={async enabled=>{if(enabled&&!await confirm({title:'Allow installation apps in this project?',description:'Members can use their installation accounts alongside this project’s accounts. Approval choices stay separate for this project.',confirm:'Allow installation apps'}))return;try{await onInstallationAppsChange?.(enabled);}catch(error){setError(error instanceof Error?error.message:'Project setting could not save.');}}}/>}/></Card></Section>}
    {catalog?.configured===false ? <EmptyState icon={<Blocks size={20} aria-hidden />} title="Not configured">{project?'Save a Composio API key in Settings > Connected apps to browse and connect project apps.':'Save a Composio API key above to browse and connect apps.'}</EmptyState> : <>
      {link && <Alert title="Finish connecting in Composio" actions={<Button size="sm" onClick={()=>setRefresh(n=>n+1)}>Check connection</Button>}><a href={link} target="_blank" rel="noopener noreferrer">Open secure connection page</a>. Return here and check the connection when finished.</Alert>}
      <Section title="Browse apps">
        <form className="k-inline" style={{alignItems:'flex-end'}} onSubmit={event=>{event.preventDefault();setCursors(['']);setQuery(search);}}><Field label="Search apps"><Input type="search" maxLength={100} placeholder="Gmail, Slack, GitHub..." value={search} disabled={locked} onChange={event=>setSearch(event.target.value)} /></Field><Button type="submit" icon={<Search size={14} aria-hidden />} disabled={locked}>Search</Button></form>
        {!!catalog && <div className="k-row-actions" aria-label="App categories"><Button size="sm" variant={category===''?'brand':'ghost'} aria-pressed={category===''} disabled={locked} onClick={()=>{setCategory('');setCursors(['']);}}>All apps</Button>{catalog.categories.map(row=><Button key={row.id} size="sm" variant={category===row.id?'brand':'ghost'} aria-pressed={category===row.id} disabled={locked} onClick={()=>{setCategory(row.id);setCursors(['']);}}>{row.name}</Button>)}</div>}
        {!catalog ? !error && <SkeletonRows /> : !catalog.items.length ? <EmptyState title="No apps found">Try another search or category.</EmptyState> : <Card>{catalog.items.map(app=>{
          const rows=accounts?.filter(row=>row.toolkit===app.slug) ?? [], active=rows.some(row=>row.status==='ACTIVE');
          return <Row key={app.slug} leading={<Blocks size={16} aria-hidden />} title={app.name} meta={app.description} trailing={<>{active && <Badge tone="success">Connected</Badge>}{active ? <ActionMenu label={`Manage ${app.name}`} trigger={<button type="button" className="k-icon-btn" aria-label={`Manage ${app.name}`} disabled={locked}><Ellipsis size={16} aria-hidden /></button>} items={rows.map(row=>({label:`Disconnect ${row.id}`,danger:true,onSelect:async()=>{if(await confirm({title:`Disconnect ${app.name}?`,description:'Agent access is revoked. Completed app actions cannot be undone.',confirm:'Disconnect',danger:true}))void execute({path:`/api/connected-apps/disconnect/${row.id}`,body:{id:crypto.randomUUID()}});}}))} /> : <Button size="sm" disabled={locked || !app.managedAuth} onClick={()=>void execute({path:`/api/connected-apps/connect/${app.slug}`,body:{id:crypto.randomUUID()}},true)}>{app.managedAuth?'Connect':'Custom auth needed'}</Button>}</>} />;
        })}</Card>}
        {(cursors.length>1 || catalog?.next_after) && <div className="k-pager"><IconButton label="Previous apps" disabled={locked || cursors.length<2} onClick={()=>setCursors(rows=>rows.slice(0,-1))}><ChevronLeft size={16} aria-hidden /></IconButton><IconButton label="Next apps" disabled={locked || !catalog?.next_after} onClick={()=>{setCursors(rows=>[...rows,catalog!.next_after!]);heading.current?.focus();}}><ChevronRight size={16} aria-hidden /></IconButton></div>}
      </Section>
      <Section title="Accounts">
        {accounts===null ? !error && <SkeletonRows count={2} /> : !accounts.length ? <EmptyState title="No connected accounts">Choose Connect beside an app to authorize it through Composio.</EmptyState> : <Card>{accounts.map(row=><Row key={row.id} title={title(row.toolkit)} meta={<><span>{row.id}</span><Badge tone={row.status==='ACTIVE'?'success':'neutral'}>{row.status==='ACTIVE'?'Connected':row.status}</Badge></>} trailing={<ActionMenu label={`Manage account ${row.id}`} items={[{label:'Disconnect',danger:true,onSelect:async()=>{if(await confirm({title:`Disconnect ${title(row.toolkit)}?`,description:'Agent access is revoked. Completed app actions cannot be undone.',confirm:'Disconnect',danger:true}))void execute({path:`/api/connected-apps/disconnect/${row.id}`,body:{id:crypto.randomUUID()}});}}]} trigger={<button type="button" className="k-icon-btn" aria-label={`Manage account ${row.id}`} disabled={locked}><Ellipsis size={16} aria-hidden /></button>} />} />)}</Card>}
      </Section>
      {project && connected.map(toolkit=><Button key={toolkit} size="sm" disabled={locked || !agents.length} onClick={async()=>{if(await confirm({title:`Allow all project members to use ${title(toolkit)}?`,description:`This grants ${agents.length} current members access. Actions that write or have unknown effects still ask for approval in chat.`,confirm:'Allow all members'}))void execute({path:`/api/connected-apps/grant-all/${toolkit}`,body:{id:crypto.randomUUID(),confirmed:true}});}}>Allow all members to use {title(toolkit)}</Button>)}
      <Section title="Agent access" actions={!!agents.length && <Select size="sm" label="Agent for connected apps" value={agent} disabled={locked} onChange={setAgent} options={agents.map(row=>({value:row.id,label:row.name}))} />}>
        <p className="k-field__hint">{project?'Confirm access for all current members, or edit each member below.':'Agents start with no app access.'}  Read actions run immediately; actions that write or have unknown effects ask for approval in chat.</p>
        {!agent ? <EmptyState title="No agents yet">Create an agent to grant app access.</EmptyState> : grants===null ? !error && <SkeletonRows count={2} /> : !connected.length ? <EmptyState title="Connect an app first">Connected apps appear here for each agent.</EmptyState> : <Card>{connected.map(toolkit=>{const grant=grants.find(row=>row.toolkit===toolkit);return <Row key={toolkit} title={title(toolkit)} meta={grant?.enabled?'Access allowed':'No access'} trailing={<Switch label={`Allow ${agents.find(row=>row.id===agent)?.name} to use ${title(toolkit)}`} checked={!!grant?.enabled} disabled={locked} onChange={enabled=>void execute({path:`/api/agents/${agent}/connected-apps/${toolkit}`,body:{id:crypto.randomUUID(),revision:grant?.revision ?? 0,enabled}})} />} />;})}</Card>}
        {!!policies?.length && <><h3 className="k-section__title">Always allowed actions</h3><Card>{policies.map(row=><Row key={row.fingerprint} title={row.tool} meta={`${title(row.toolkit)} · ${row.account}`} trailing={<Button size="sm" disabled={locked} onClick={()=>void execute({path:`/api/agents/${agent}/connected-app-policies`,body:{id:crypto.randomUUID(),fingerprint:row.fingerprint}})}>Ask next time</Button>} />)}</Card></>}
      </Section>
    </>}
  </div>;
}
