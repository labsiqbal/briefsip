import { useEffect, useRef, useState } from 'react';
type Connection = { id: string; name: string; url: string; hasToken: boolean; enabled: number; revision: number };
type Tool = { name: string; title?: string; description?: string; inputSchema: unknown; _meta?: Record<string, unknown> };
const label = (tool: Tool) => `${tool._meta?.['briefsip.kind'] === 'resource-template' ? 'Resource template: ' : tool._meta?.['briefsip.kind'] === 'resource' ? 'Resource: ' : tool._meta?.['briefsip.kind'] === 'prompt' ? 'Prompt: ' : 'Tool: '}${tool.title && tool.title !== tool.name && !tool._meta?.['briefsip.kind'] ? `${tool.title} (${tool.name})` : tool.title ?? tool.name}`;
type Detail = Connection & { tools: Tool[]; grant: { revision: number; tools: string[] } };
type Command = { path: string; body: Record<string, unknown> & { id: string } };
const storage = 'briefsip:mcp-command';
function restore(raw: string | null): Command | null {
  if (raw === null) return null;
  if (raw.length > 16000) throw new Error('MCP recovery data is too large.');
  const value = JSON.parse(raw), uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
  if (!value || typeof value.path !== 'string' || !new RegExp(`^/api/(mcp(?:/${uuid})?|agents/${uuid}/mcp/${uuid})$`, 'i').test(value.path) || !value.body || typeof value.body !== 'object' || !new RegExp(`^${uuid}$`, 'i').test(value.body.id) || Object.keys(value.body).some(key => !['id', 'test', 'revision', 'enabled', 'connectionRevision', 'tools'].includes(key))) throw new Error('MCP recovery data is invalid.');
  return value;
}
export function McpPanel({ agents, request, onClose }: { agents: { id: string; name: string }[]; request: <T>(path: string, body?: unknown) => Promise<T>; onClose: () => void }) {
  const [recovery] = useState(() => { try { return { command: restore(sessionStorage.getItem(storage)), invalid: false }; } catch { return { command: null, invalid: true }; } });
  const [pending, setPending] = useState(recovery.command), [invalid, setInvalid] = useState(recovery.invalid);
  const [page, setPage] = useState<{ items: Connection[]; next_after: string | null } | null>(null), [cursors, setCursors] = useState(['']);
  const [agent, setAgent] = useState(agents[0]?.id ?? ''), [selected, setSelected] = useState(''), [detail, setDetail] = useState<Detail | null>(null), [tools, setTools] = useState<string[]>([]);
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [token, setToken] = useState('');
  const [editing, setEditing] = useState<Connection | null>(null), [rotate, setRotate] = useState(false);
  const [tested, setTested] = useState<{ id: string; tools: Tool[]; expires: number } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const generation = useRef(0), reads = useRef(0), flight = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const locked = busy || !!pending || invalid, after = cursors.at(-1)!;
  useEffect(() => { heading.current?.focus(); return () => { generation.current++; }; }, []);
  useEffect(() => { heading.current?.focus(); }, [after, selected]);
  useEffect(() => {
    let stopped = false; const current = ++reads.current; setPage(null); setDetail(null); setError('');
    void Promise.all([request<NonNullable<typeof page>>(`/api/mcp${after ? `?after=${after}` : ''}`), selected && agent ? request<Detail>(`/api/mcp/${selected}?agent=${agent}`) : Promise.resolve(null)]).then(([page, detail]) => { if (!stopped && current === reads.current) { setPage(page); setDetail(detail); setTools(detail?.grant.tools ?? []); } }).catch(error => { if (!stopped && current === reads.current) setError(error.message); });
    return () => { stopped = true; };
  }, [after, selected, agent, refresh]);
  async function reload() {
    if (busy || flight.current) return;
    if (!editing || pending || invalid) { setRefresh(value => value + 1); return; }
    if (!window.confirm('Load the latest connection revision for this draft? The entered name and token stay saved, but old test results are discarded. Test again before saving.')) return;
    const current = generation.current; flight.current = true; setBusy(true); setError(''); setTested(null);
    try { const latest = await request<Detail>(`/api/mcp/${editing.id}`); if (current === generation.current) { setEditing(latest); setRefresh(value => value + 1); } }
    catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Connection could not reload.'); }
    finally { flight.current = false; if (current === generation.current) setBusy(false); }
  }
  async function test() {
    if (flight.current || locked) return;
    const current = generation.current; flight.current = true; setBusy(true); setError(''); setTested(null);
    try { const result = await request<NonNullable<typeof tested>>('/api/mcp/test', { id: crypto.randomUUID(), name, ...(editing ? { connection: editing.id, revision: editing.revision, ...(rotate ? { token } : {}) } : { url, token }) }); if (current === generation.current) setTested(result); }
    catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Connection test failed.'); }
    finally { flight.current = false; if (current === generation.current) setBusy(false); }
  }
  async function execute(command: Command) {
    if (flight.current || busy || invalid) return;
    const current = generation.current;
    try {
      restore(JSON.stringify(command)); sessionStorage.setItem(storage, JSON.stringify(command)); setPending(command); setBusy(true); flight.current = true; reads.current++; setError('');
      await request(command.path, command.body);
      if (current !== generation.current) return;
      if (sessionStorage.getItem(storage) === JSON.stringify(command)) sessionStorage.removeItem(storage);
      setPending(null);
      if (command.body.test && (editing ? command.path === `/api/mcp/${editing.id}` : command.path === '/api/mcp')) { setTested(null); setEditing(null); setRotate(false); setToken(''); setName(''); setUrl(''); }
      else if (editing && command.path === `/api/mcp/${editing.id}`) setTested(null);
      setRefresh(value => value + 1); heading.current?.focus();
    } catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Changes are not confirmed yet. Try again.'); }
    finally { flight.current = false; if (current === generation.current) setBusy(false); }
  }
  return <section className="setup workflow-panel"><h1 ref={heading} tabIndex={-1}>MCP connections</h1>
    <p>Connect external services, then choose which tools, resources, and prompts each agent may use in private conversations. Tools can change data in the target service. Resources and prompts are read as reference data; binary content is not forwarded yet.</p>
    <div className="form-actions"><button className="secondary" onClick={onClose}>Back to conversation</button><button className="secondary" disabled={busy} onClick={() => void reload()}>Reload connections</button></div>
    {error && <p role="alert" className="error">{error}</p>}{invalid && <p role="alert">MCP recovery data could not be read.</p>}{pending && <p className="notice">Changes are not confirmed yet. <button disabled={busy} onClick={() => void execute(pending)}>Retry change</button></p>}
    {(pending || invalid) && <button className="secondary" disabled={busy} onClick={() => { if (!window.confirm('Ignore the saved request? Changes may already have succeeded. Check the list after it reloads.')) return; try { sessionStorage.removeItem(storage); setPending(null); setInvalid(false); setRefresh(value => value + 1); } catch { setError('Browser storage could not be updated.'); } }}>Ignore recovery</button>}
    <form onSubmit={event => { event.preventDefault(); void test(); }}><fieldset disabled={locked}><legend>{editing ? `Update ${editing.name}` : 'New connection'}</legend>
      <label>Name<input required maxLength={80} value={name} onChange={event => { setName(event.target.value); setTested(null); }} /></label>
      <label>Streamable HTTP URL<input required readOnly={!!editing} type="url" maxLength={2000} value={url} onChange={event => { setUrl(event.target.value); setTested(null); }} /></label>
      {editing && <label className="member-option"><input type="checkbox" checked={rotate} onChange={event => { setRotate(event.target.checked); setToken(''); setTested(null); }} />Replace saved token</label>}
      {(!editing || rotate) && <label>Bearer token, if required<input type="password" autoComplete="off" maxLength={4096} value={token} onChange={event => { setToken(event.target.value); setTested(null); }} /></label>}
      <p className="muted">Tokens are stored encrypted on this host. Saved URLs cannot be changed. OAuth is not available yet.</p>
      {editing && <p>Updating refreshes the catalog and revokes all access permissions for this connection. Select permissions again after saving. The old token is used unless Replace saved token is selected; an empty token removes authentication.</p>}<button>Test connection</button>
      {editing && <button type="button" className="secondary" onClick={() => { setEditing(null); setRotate(false); setName(''); setUrl(''); setToken(''); setTested(null); }}>Cancel update</button>}
      {tested && <><p role="status">Test passed. {tested.tools.length} items found. Test results are valid for 10 minutes.</p><ul className="routine-list">{tested.tools.map(tool => <li key={tool.name}><strong>{label(tool)}</strong><p>{tool.description}</p></li>)}</ul><button type="button" onClick={() => { if (editing && !window.confirm('Save the tested catalog and token, revoke all access permissions, and stop active MCP calls for this connection? External effects that have already occurred cannot be undone.')) return; void execute({ path: editing ? `/api/mcp/${editing.id}` : '/api/mcp', body: { id: crypto.randomUUID(), test: tested.id, ...(editing ? { revision: editing.revision } : {}) } }); }}>{editing ? 'Save tested update' : 'Save tested connection'}</button></>}
    </fieldset></form>
    <h2>Saved connections</h2>{!page ? !error && <p role="status">Loading connection...</p> : page.items.length ? <ul className="routine-list">{page.items.map(row => <li key={row.id}><strong>{row.name}</strong><p>{row.url}</p><p>{row.enabled ? 'Active' : 'Inactive'} · {row.hasToken ? 'Token saved' : 'No token'}</p><button className="secondary" disabled={locked} onClick={() => { if ((name || url || token) && !window.confirm('Discard the current connection draft and open this connection?')) return; generation.current++; setEditing(row); setName(row.name); setUrl(row.url); setToken(''); setRotate(false); setTested(null); heading.current?.focus(); }}>Update {row.name}</button><button className="secondary" disabled={locked || !agent} onClick={() => { generation.current++; reads.current++; setDetail(null); setSelected(row.id); setRefresh(value => value + 1); }}>Manage permissions for {row.name}</button><button className="secondary" disabled={locked} onClick={() => void execute({ path: `/api/mcp/${row.id}`, body: { id: crypto.randomUUID(), revision: row.revision, enabled: !row.enabled } })}>{row.enabled ? 'Disable' : 'Enable'} {row.name}</button></li>)}</ul> : <p>No connections on this page yet.</p>}
    <div className="form-actions"><button className="secondary" disabled={locked || cursors.length < 2} onClick={() => { generation.current++; setCursors(value => value.slice(0, -1)); }}>Previous</button><button className="secondary" disabled={locked || !page?.next_after} onClick={() => { generation.current++; setCursors(value => [...value, page!.next_after!]); }}>Next</button></div>
    <label>Agent<select value={agent} disabled={locked} onChange={event => { generation.current++; reads.current++; setDetail(null); setAgent(event.target.value); }}>{agents.map(item => <option key={item.id} value={item.id}>{item.name.length > 24 ? item.name.slice(0, 21) + '...' : item.name}</option>)}</select><span className="flow-selected-name muted">{agents.find(item => item.id === agent)?.name}</span></label>
    {detail && <form onSubmit={event => { event.preventDefault(); if (!locked && window.confirm('Allow selected access for this agent? Effects in external services may still occur after the task is canceled.')) void execute({ path: `/api/agents/${agent}/mcp/${detail.id}`, body: { id: crypto.randomUUID(), revision: detail.grant.revision, connectionRevision: detail.revision, tools } }); }}><fieldset disabled={locked}><legend>Permissions for {detail.name}</legend><p>Catalog updates revoke all access permissions; select permissions again afterward. Inactive connections cannot be called.</p>{detail.tools.map(tool => <div key={tool.name}><label className="member-option"><input type="checkbox" aria-describedby={tool._meta?.['briefsip.kind'] === 'resource-template' ? `template-scope-${tool.name}` : undefined} checked={tools.includes(tool.name)} onChange={event => setTools(value => event.target.checked ? [...value, tool.name] : value.filter(name => name !== tool.name))} />{label(tool)}</label><p>{tool.description}</p>{tool._meta?.['briefsip.kind'] === 'resource-template' && <p id={`template-scope-${tool.name}`} className="notice">Permissions cover all URIs this template can form, including parameter values chosen by the agent. The target server still controls access to its data.</p>}{typeof tool._meta?.['briefsip.target'] === 'string' && <p className="flow-selected-name">{tool._meta['briefsip.target']}</p>}<details><summary>Parameter {label(tool)}</summary><pre className="skill-file-content" tabIndex={0} role="region" aria-label={`Parameter ${label(tool)}`}>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details></div>)}<button>Save access permissions</button></fieldset></form>}
  </section>;
}
