import { useEffect, useRef, useState } from 'react';
type Table = { name: string; owner: string; columns: { name: string; type: string }[] };
type Listing = { tables: Table[]; next_after: string | null; revision: number };
type Pending = { id: string; revision: number; table: string };
const key = 'briefsip:shared-data-drop';
export function SharedDataPanel({ request, onClose, agents }: { agents: { id: string; name: string }[]; request: <T>(path: string, data?: unknown) => Promise<T>; onClose: () => void }) {
  const [listing, setListing] = useState<Listing | null>(null), [after, setAfter] = useState(''), [reload, setReload] = useState(0);
  const [sql, setSQL] = useState(''), [result, setResult] = useState<unknown>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(() => { try { const p = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return p && typeof p.id === 'string' && /^[0-9a-f-]{36}$/i.test(p.id) && typeof p.table === 'string' && p.table.length > 0 && p.table.length <= 128 && Number.isSafeInteger(p.revision) && p.revision >= 0 ? p : null; } catch { return null; } });
  const heading = useRef<HTMLHeadingElement>(null), version = useRef(0);
  useEffect(() => { heading.current?.focus(); return () => { version.current++; }; }, []);
  useEffect(() => {
    const active = ++version.current; setListing(null); setError('');
    void request<Listing>(`/api/data?after=${encodeURIComponent(after)}`).then(value => { if (active === version.current) setListing(value); }).catch(error => { if (active === version.current) setError(error.message); });
    return () => { version.current++; };
  }, [after, reload]);
  async function execute(table?: string) {
    if (busy || !listing) return;
    let command = pending;
    if (table && !command) {
      if (!confirm(`Delete table ${table} and all its data? This action cannot be undone.`)) return;
      command = { id: crypto.randomUUID(), revision: listing.revision, table };
      try { sessionStorage.setItem(key, JSON.stringify(command)); } catch { setError('The browser could not save the recovery ID. Deletion has not been sent.'); return; }
      setPending(command);
    }
    const active = ++version.current; setBusy(true); setError('');
    try {
      const value = await request('/api/data/' + (command ? 'drop' : 'query'), command ?? { id: crypto.randomUUID(), revision: listing.revision, sql });
      if (command && JSON.parse(sessionStorage.getItem(key) ?? 'null')?.id === command.id) sessionStorage.removeItem(key);
      if (active !== version.current) return;
      setPending(null); setResult(value); setReload(n => n + 1);
    } catch (error) { if (active === version.current) setError((error as Error).message); }
    finally { if (active === version.current) setBusy(false); }
  }
  return <section className="setup workflow-panel shared-data-panel"><h1 ref={heading} tabIndex={-1}>Shared data</h1>
    <p>All agents can read and change rows. Only the table creator can change its structure. Do not store secrets or data that must not be shared.</p>
    <div className="form-actions"><button className="secondary" onClick={onClose}>Back to conversation</button><button className="secondary" disabled={busy} onClick={() => setReload(n => n + 1)}>Reload data</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    {pending && <div><p className="message-text">Deletion of {pending.table} is not confirmed yet. Retrying does not repeat a deletion already saved.</p><button disabled={busy || !listing} onClick={() => void execute()}>Retry deletion</button><button className="secondary" disabled={busy} onClick={() => { sessionStorage.removeItem(key); setPending(null); setReload(n => n + 1); }}>Close recovery and reload</button></div>}
    {!listing ? <p role="status">{error ? 'Data is unavailable.' : 'Loading tables...'}</p> : <>
      {!listing.tables.length && <p>No tables on this page. Ask an agent to create a table through a conversation.</p>}
      {listing.tables.map(table => <details key={table.name}><summary className="message-text">{table.name}</summary><p className="message-text">Creator: {agents.find(agent => agent.id === table.owner)?.name ?? table.owner}</p><p className="message-text">{table.columns.map(column => `${column.name}: ${column.type || 'untyped'}`).join('\n')}</p><button className="secondary" disabled={busy || !!pending} onClick={() => void execute(table.name)}>Delete table {table.name}</button></details>)}
      <div className="form-actions"><button className="secondary" disabled={busy || !after} onClick={() => { setAfter(''); heading.current?.focus(); }}>First page</button><button className="secondary" disabled={busy || !listing.next_after} onClick={() => { setAfter(listing.next_after!); heading.current?.focus(); }}>Next tables</button></div>
      <label>Read-only query<textarea rows={4} placeholder={'SELECT * FROM "table_name" LIMIT 50'} value={sql} maxLength={16000} disabled={busy || !!pending} onChange={event => setSQL(event.target.value)} /></label><button disabled={busy || !!pending || !sql.trim()} onClick={() => void execute()}>{busy ? 'Processing...' : 'Run read query'}</button>
    </>}
    {result !== null && <details open><summary>Last query results</summary><pre className="message-text">{JSON.stringify(result, null, 2)}</pre></details>}
  </section>;
}
