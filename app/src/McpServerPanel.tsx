import { useEffect, useRef, useState } from 'react';
import { Copy, Ellipsis, KeyRound, Plus, RefreshCw } from 'lucide-react';
import { ActionMenu, Alert, Badge, Button, Card, Checkbox, Dialog, EmptyState, Field, IconButton, Input, PageHeader, Row, Section, SkeletonRows, useConfirm } from './ui/kit';
import { mcpScopeCatalog as scopes, type McpScope as Scope } from '../mcp-scopes';
type PeerToken = { id: string; name: string; scopes: Scope[]; created: number; lastUsed: number | null; revoked: number | null };
type Command = { path: string; body: { id: string; name?: string; scopes?: Scope[] } };
const path = '/api/mcp-server/peer-tokens', storage = 'briefsip:mcp-server-command';
function restore(raw: string | null): Command | null {
  if (!raw) return null;
  const value = JSON.parse(raw), uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
  if (raw.length > 2000 || !value || !new RegExp(`^${path}(?:/${uuid}/revoke)?$`, 'i').test(value.path) || !value.body || !new RegExp(`^${uuid}$`, 'i').test(value.body.id) || Object.keys(value.body).some(key => !['id','name','scopes'].includes(key)) || (value.path === path && (typeof value.body.name !== 'string' || value.body.name.length > 80 || !Array.isArray(value.body.scopes) || !value.body.scopes.length || value.body.scopes.some((scope: unknown) => !scopes.some(item => item.id === scope))))) throw new Error('Invalid MCP server recovery data.');
  return value;
}
export function McpServerPanel({ request }: { request: <T>(path: string, body?: unknown) => Promise<T> }) {
  const [recovery] = useState(() => { try { return { pending: restore(sessionStorage.getItem(storage)), invalid: false }; } catch { return { pending: null, invalid: true }; } });
  const [pending, setPending] = useState(recovery.pending), [invalid, setInvalid] = useState(recovery.invalid);
  const [page, setPage] = useState<{ items: PeerToken[]; endpoint: string } | null>(null), [refresh, setRefresh] = useState(0);
  const [showForm, setShowForm] = useState(false), [name, setName] = useState(''), [selected, setSelected] = useState<Scope[]>(['agents:read']);
  const [secret, setSecret] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), mounted = useRef(true), flight = useRef(false), reads = useRef(0);
  const confirm = useConfirm(), locked = busy || !!pending || invalid;
  useEffect(() => { mounted.current = true; heading.current?.focus(); return () => { mounted.current = false; reads.current++; }; }, []);
  useEffect(() => {
    const version = ++reads.current; setError('');
    void request<NonNullable<typeof page>>(path).then(result => { if (mounted.current && version === reads.current) setPage(result); }).catch(error => { if (mounted.current && version === reads.current) setError(error.message); });
    return () => { reads.current++; };
  }, [refresh]);
  async function copy(value: string) { try { await navigator.clipboard.writeText(value); if (mounted.current) setNotice('Copied.'); } catch { if (mounted.current) setError('Could not copy. Select the text and copy it manually.'); } }
  async function execute(command: Command) {
    if (flight.current || busy || invalid) return;
    flight.current = true; setBusy(true); setError(''); setNotice(''); setSecret('');
    try {
      restore(JSON.stringify(command)); sessionStorage.setItem(storage, JSON.stringify(command)); setPending(command);
      const result = await request<PeerToken & { token?: string; alreadyCreated?: boolean }>(command.path, command.body);
      if (!mounted.current) return;
      sessionStorage.removeItem(storage); setPending(null); setShowForm(false); setName(''); setSelected(['agents:read']);
      setSecret(result.token ?? '');
      if (result.alreadyCreated) setNotice('Token was already created. Its secret cannot be recovered. Revoke it and create a replacement if you did not save it.');
      setRefresh(value => value + 1); heading.current?.focus();
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Change is not confirmed. Retry the saved request.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  async function discard() {
    if (!await confirm({ title: 'Discard the saved request?', description: 'The change may already have succeeded. Check the token list before creating a replacement.', confirm: 'Discard request', danger: true })) return;
    try { sessionStorage.removeItem(storage); setPending(null); setInvalid(false); setRefresh(value => value + 1); } catch { setError('Browser storage could not be updated.'); }
  }
  const recoveryNotice = <>
    {invalid && <Alert tone="error" title="Saved request could not be read" actions={<Button size="sm" onClick={() => void discard()}>Discard request</Button>} />}
    {pending && <Alert tone="warn" title="Change is not confirmed" actions={<><Button size="sm" disabled={busy} onClick={() => void execute(pending)}>Retry saved request</Button><Button size="sm" disabled={busy} onClick={() => void discard()}>Discard request</Button></>}>Retry uses the same ID and payload. A created token is never revealed twice.</Alert>}
  </>;
  return <div className="k-page bs-root">
    <PageHeader headingRef={heading} title="MCP server" description="Let another Briefsip instance or a coding agent use tools on this computer."
      actions={<><IconButton label="Reload MCP server" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden /></IconButton><Button variant="primary" icon={<Plus size={14} aria-hidden />} disabled={locked} onClick={() => setShowForm(true)}>Create token</Button></>} />
    {error && <Alert tone="error">{error}</Alert>}
    {notice && <Alert>{notice}</Alert>}
    {recoveryNotice}
    <Section title="Endpoint">
      <Field label="Streamable HTTP URL" hint="Use this URL with a bearer token. Remote devices need a reachable address allowed by this installation.">
        <div className="k-inline"><Input readOnly value={page ? new URL('/mcp', window.location.href).href : ''} onFocus={event => event.target.select()} /><IconButton label="Copy endpoint URL" disabled={!page} onClick={() => void copy(new URL('/mcp', window.location.href).href)}><Copy size={15} aria-hidden /></IconButton></div>
      </Field>
    </Section>
    {secret && <Section title="Save your token">
      <Alert tone="warn" title="You will not see this token again">Copy it to the other device's secret storage before leaving this section. Anyone with this token can use its selected scopes.</Alert>
      <Field label="New bearer token"><div className="k-inline"><Input readOnly value={secret} autoComplete="off" spellCheck={false} onFocus={event => event.target.select()} /><IconButton label="Copy bearer token" onClick={() => void copy(secret)}><Copy size={15} aria-hidden /></IconButton></div></Field>
      <Button size="sm" onClick={() => { setSecret(''); setNotice(''); }}>I saved the token</Button>
    </Section>}
    <Section title="Peer tokens">
      {!page ? !error && <><span role="status" className="sr-only">Loading peer tokens...</span><SkeletonRows /></> : !page.items.length ? <EmptyState icon={<KeyRound size={18} />} title="No peer tokens yet">Create a token for each device and choose its access.</EmptyState> : <Card>{page.items.map(token => <Row key={token.id} title={token.name} leading={<KeyRound size={16} aria-hidden />}
        meta={<><Badge tone={token.revoked === null ? 'success' : 'neutral'}>{token.revoked === null ? 'Active' : 'Revoked'}</Badge><span>{token.scopes.join(', ')}</span><span>Created {new Date(token.created).toLocaleDateString('en-US')}</span><span>{token.lastUsed === null ? 'Never used' : `Last used ${new Date(token.lastUsed).toLocaleString('en-US')}`}</span></>}
        trailing={token.revoked === null && <ActionMenu label={`Token actions for ${token.name}`} trigger={<button type="button" className="k-icon-btn" aria-label={`Token actions for ${token.name}`} disabled={locked}><Ellipsis size={16} aria-hidden /></button>} items={[{ label: 'Revoke token', danger: true, onSelect: async () => { if (await confirm({ title: `Revoke ${token.name}?`, description: 'This token will stop working immediately. Work already queued or running will continue.', confirm: 'Revoke token', danger: true })) void execute({ path: `${path}/${token.id}/revoke`, body: { id: crypto.randomUUID() } }); } }]} />} />)}</Card>}
    </Section>
    <Dialog open={showForm} onOpenChange={setShowForm} title="Create peer token" footer={<Button variant="primary" type="submit" form="create-peer-token" busy={busy} disabled={locked || !name.trim() || !selected.length}>Create token</Button>}>
      {error && <Alert tone="error">{error}</Alert>}{recoveryNotice}
      <form id="create-peer-token" onSubmit={event => { event.preventDefault(); if (!locked) void execute({ path, body: { id: crypto.randomUUID(), name, scopes: selected } }); }}>
        <fieldset disabled={locked} className="k-fieldset">
          <Field label="Device name" hint="Shown as the sender of messages from this token."><Input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="Work laptop" /></Field>
          <div role="group" aria-label="Token scopes">{(['Read', 'Write', 'Run'] as const).map(group => <fieldset className="mcp-scope-group" key={group}><legend>{group}</legend><div className="k-stack">{scopes.filter(scope => scope.group === group).map(scope => <Checkbox key={scope.id} label={scope.label} description={scope.hint} checked={selected.includes(scope.id)} onChange={checked => setSelected(value => checked ? [...value, scope.id] : value.filter(item => item !== scope.id))} />)}</div></fieldset>)}</div>
        </fieldset>
      </form>
    </Dialog>
  </div>;
}
