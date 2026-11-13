import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Database, Ellipsis, RefreshCw } from 'lucide-react';
import { ActionMenu, Alert, Button, Card, CodeBlock, EmptyState, Field, IconButton, PageHeader, Row, Section, SkeletonRows, Textarea, useConfirm } from './ui/kit';
type Table = { name: string; owner: string; columns: { name: string; type: string }[] };
type Listing = { tables: Table[]; next_after: string | null; revision: number };
type QueryResult = { columns: string[]; rows: unknown[][]; truncated: boolean; changes: number; revision: number };
type Pending = { id: string; revision: number; table: string };
const key = 'briefsip:shared-data-drop';
export function SharedDataPanel({ request, agents }: { agents: { id: string; name: string }[]; request: <T>(path: string, data?: unknown) => Promise<T>; onClose: () => void }) {
  const [listing, setListing] = useState<Listing | null>(null), [after, setAfter] = useState(''), [reload, setReload] = useState(0);
  const [sql, setSQL] = useState(''), [result, setResult] = useState<QueryResult | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(() => { try { const p = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return p && typeof p.id === 'string' && /^[0-9a-f-]{36}$/i.test(p.id) && typeof p.table === 'string' && p.table.length > 0 && p.table.length <= 128 && Number.isSafeInteger(p.revision) && p.revision >= 0 ? p : null; } catch { return null; } });
  const confirm = useConfirm();
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
      if (!await confirm({ title: `Delete table ${table} and all its data?`, description: 'This action cannot be undone.', confirm: 'Delete table', danger: true })) return;
      command = { id: crypto.randomUUID(), revision: listing.revision, table };
      try { sessionStorage.setItem(key, JSON.stringify(command)); } catch { setError('The browser could not save the recovery ID. Deletion has not been sent.'); return; }
      setPending(command);
    }
    const active = ++version.current; setBusy(true); setError('');
    try {
      const value = await request<QueryResult>('/api/data/' + (command ? 'drop' : 'query'), command ?? { id: crypto.randomUUID(), revision: listing.revision, sql });
      if (command && JSON.parse(sessionStorage.getItem(key) ?? 'null')?.id === command.id) sessionStorage.removeItem(key);
      if (active !== version.current) return;
      setPending(null); setResult(value); setReload(n => n + 1);
    } catch (error) { if (active === version.current) setError((error as Error).message); }
    finally { if (active === version.current) setBusy(false); }
  }
  return <div className="k-page bs-root">
    <PageHeader headingRef={heading} title="Shared data" description="Read and manage data shared by agents." actions={<IconButton label="Reload" disabled={busy} onClick={() => setReload(n => n + 1)}><RefreshCw size={15} aria-hidden /></IconButton>} />
    <Alert>All agents can read and change rows. Only the table creator can change its structure. Do not store secrets or data that must not be shared.</Alert>
    {error && <Alert tone="error">{error}</Alert>}
    {pending && <Alert tone="warn" title={`Deletion of ${pending.table} is not confirmed yet`} actions={<>
      <Button size="sm" disabled={busy || !listing} onClick={() => void execute()}>Retry deletion</Button>
      <Button size="sm" disabled={busy} onClick={() => { sessionStorage.removeItem(key); setPending(null); setReload(n => n + 1); }}>Close recovery and reload</Button>
    </>}>Retrying does not repeat a deletion already saved.</Alert>}
    <Section id="shared-data-tables" title="Tables">
      {!listing ? error ? <EmptyState title="Data is unavailable." /> : <><span className="sr-only" role="status">Loading tables...</span><SkeletonRows /></> : <>
        {!listing.tables.length ? <EmptyState icon={<Database size={18} />} title="No tables on this page">Ask an agent to create a table through a conversation.</EmptyState> : <Card>{listing.tables.map(table => <div key={table.name}>
          <Row title={table.name} leading={<Database size={16} aria-hidden />} meta={`Creator: ${agents.find(agent => agent.id === table.owner)?.name ?? table.owner}`} trailing={<ActionMenu label={`Menu ${table.name}`} trigger={<button type="button" className="k-icon-btn" aria-label={`Menu ${table.name}`} disabled={busy || !!pending}><Ellipsis size={16} aria-hidden /></button>} items={[
            { label: `Delete table ${table.name}`, danger: true, onSelect: () => void execute(table.name) },
          ]} />} />
          <details style={{ padding: '0 10px 10px' }}><summary className="k-field__hint">Columns</summary><CodeBlock label={`Columns in ${table.name}`}>{table.columns.map(column => `${column.name}: ${column.type || 'untyped'}`).join('\n')}</CodeBlock></details>
        </div>)}</Card>}
        {(after || listing.next_after) && <div className="k-pager">
          <IconButton label="First page" disabled={busy || !after} onClick={() => { setAfter(''); heading.current?.focus(); }}><ChevronLeft size={16} aria-hidden /></IconButton>
          <IconButton label="Next tables" disabled={busy || !listing.next_after} onClick={() => { setAfter(listing.next_after!); heading.current?.focus(); }}><ChevronRight size={16} aria-hidden /></IconButton>
        </div>}
      </>}
    </Section>
    {listing && <Section id="shared-data-query" title="Query">
      <Field label="Read-only query"><Textarea rows={4} placeholder={'SELECT * FROM "table_name" LIMIT 50'} value={sql} maxLength={16000} disabled={busy || !!pending} onChange={event => setSQL(event.target.value)} /></Field>
      <div className="k-row-actions"><Button variant="primary" disabled={busy || !!pending || !sql.trim()} busy={busy} onClick={() => void execute()}>{busy ? 'Processing...' : 'Run read query'}</Button></div>
    </Section>}
    {result !== null && <details open><summary className="k-section__title">Last query results</summary>
      {result.columns.length > 0 ? <div className="k-table-wrap"><table className="k-table">
        <caption className="sr-only">Last query results</caption>
        <thead><tr>{result.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead>
        <tbody>{result.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} className={typeof cell === 'number' ? 'is-num' : undefined} style={{ whiteSpace: 'pre-wrap' }}>{typeof cell === 'string' ? cell : JSON.stringify(cell)}</td>)}</tr>)}</tbody>
      </table></div> : <EmptyState title="No result columns" />}
      <p className="k-field__hint">{result.rows.length} rows returned. {result.changes} changes. Revision {result.revision}.{result.truncated && ' Results truncated at 200 rows.'}</p>
      <details><summary className="k-field__hint">Response details</summary><CodeBlock label="Query response">{JSON.stringify(result, null, 2)}</CodeBlock></details>
    </details>}
  </div>;
}
