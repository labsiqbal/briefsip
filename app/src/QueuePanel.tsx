import { usePolling } from './hooks/usePolling';
import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { Alert, Badge, Button, Card, Collapsible, EmptyState, IconButton, Row, useConfirm, RecoveryAlert } from './ui/kit';
type Neighbor = { id: string; agent: string; revision: number; editing: boolean };
type Entry = { previous: Neighbor | null; next: Neighbor | null; id: string; agent: string; text: string; revision: number; paused: number; editing: boolean };
type Command = { id: string; target: string; other: string; revision: number; otherRevision: number };
export function QueuePanel({ path, request, onOpen }: { path: string; request: <T>(path: string, data?: unknown) => Promise<T>; onOpen: (id: string) => void }) {
  const confirm = useConfirm();
  const endpoint = path.replace(/\/turns$/, '/queue'), key = `minarbot-queue-order:${endpoint}`;
  const [open, setOpen] = useState(false), [rows, setRows] = useState<Entry[]>([]), [more, setMore] = useState(false), [error, setError] = useState(''), [loadError, setLoadError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const [pages, setPages] = useState<{ after: number; snapshot: string }[]>([]), [nextPage, setNextPage] = useState<{ after: number; snapshot: string } | null>(null), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true);
  const page = pages.at(-1);
  const [recovery] = useState(() => {
    try {
      const saved = sessionStorage.getItem(key); if (!saved) return { pending: null, invalid: false };
      const value = JSON.parse(saved), uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
      if (!value || !['id','target','other'].every(field => typeof value[field] === 'string' && uuid.test(value[field])) || !['revision','otherRevision'].every(field => Number.isSafeInteger(value[field]) && value[field] >= 1)) throw new Error();
      return { pending: value as Command, invalid: false };
    } catch { return { pending: null, invalid: true }; }
  });
  const [pending, setPending] = useState<Command | null>(recovery.pending), [invalid, setInvalid] = useState(recovery.invalid);
  const generation = useRef(0), flight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => () => { generation.current++; }, [open, endpoint, request, refresh, page]);
  usePolling(async signal => {
    const version = ++generation.current; setLoading(true);
    try { const result = await request<{ turns: Entry[]; more: boolean; next_after: number | null; snapshot: string }>(endpoint + (page ? `?after=${page.after}&snapshot=${page.snapshot}` : '')); if (!signal.aborted && version === generation.current) { setRows(result.turns); setMore(result.more); setNextPage(result.next_after === null ? null : { after: result.next_after, snapshot: result.snapshot }); setLoadError(''); } }
    catch (error) {
      if (!signal.aborted && version === generation.current) {
        if (page && error && typeof error === 'object' && 'status' in error && error.status === 409) { setRows([]); setNextPage(null); setPages([]); setNotice('Queue changed. The list returned to the first page.'); }
        else setLoadError('Queue has not loaded. Try reloading.');
      }
    }
    finally { if (!signal.aborted && version === generation.current) setLoading(false); }
  }, { interval: 1500 }, [open, endpoint, request, refresh, page]);
  async function move(row?: Entry, other?: Neighbor | null) {
    if (flight.current || invalid || (!pending && (!row || !other))) return;
    const command = pending ?? { id: crypto.randomUUID(), target: row!.id, other: other!.id, revision: row!.revision, otherRevision: other!.revision };
    try { sessionStorage.setItem(key, JSON.stringify(command)); setPending(command); } catch { setError('Order has not been saved in the browser. Check site storage.'); return; }
    flight.current = true; setBusy(true); generation.current++;
    try { await request(endpoint, command); if (!mounted.current) return; sessionStorage.removeItem(key); setPending(null); setError(''); setPages([]); setRefresh(value => value + 1); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Order is not confirmed yet. Try again.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  if (!rows.length && !pages.length && !pending && !invalid && !error && !loadError) return null;
  return <div className="activity-section bs-root"><Collapsible variant="section" open={open} onOpenChange={setOpen} title={<>Queue <Badge>{rows.length}{more || pages.length ? '+' : ''}</Badge>{(pending || invalid) && <Badge tone="warn">Recovery needed</Badge>}</>}><div className="k-stack" style={{ display: open ? undefined : 'none' }}>
    <div className="k-row-actions"><Button size="sm" onClick={() => { generation.current++; setPages([]); setRefresh(value => value + 1); }}>Reload queue</Button></div>
    {notice && <Alert>{notice}</Alert>}
    {loadError && <Alert tone="error">{loadError}</Alert>}
    {error && <Alert tone="error">{error}</Alert>}
    {invalid && <Alert tone="error">Saved order request is invalid.</Alert>}
    {(pending || invalid) && <RecoveryAlert inFlight={busy} tone="warn" title="Order awaits confirmation" actions={<>{pending && <Button size="sm" disabled={busy} onClick={() => void move()}>Retry order</Button>}<Button size="sm" disabled={busy} onClick={async () => { if (!await confirm({ title: 'Discard the saved order request?', description: 'Changes already accepted by the server still apply.', confirm: 'Discard request', danger: true })) return; try { sessionStorage.removeItem(key); setPending(null); setInvalid(false); setError(''); setRefresh(value => value + 1); } catch { setError('Browser storage is unavailable.'); } }}>Discard saved request</Button></>} />}
    {loading && <p className="k-field__hint" role="status">Loading queue...</p>}
    {!loading && !rows.length && !error && !loadError && <EmptyState title="No queued messages yet." />}
    {!!rows.length && <Card>{rows.map(row => <Row key={row.id}
      title={<span style={{ display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{row.text}</span>}
      meta={row.editing ? 'Being edited' : row.paused ? 'Paused' : 'Waiting in queue'}>
      <div className="k-row-actions" style={{ marginTop: 6 }}>
        <Button size="sm" onClick={() => onOpen(row.id)}>Open message</Button>
        {[-1,1].map(direction => { const other = direction < 0 ? row.previous : row.next; return other && other.agent === row.agent && !row.editing && !other.editing ? <IconButton key={direction} label={direction < 0 ? 'Move up' : 'Move down'} disabled={busy || loading || !!pending || invalid} onClick={() => void move(row, other)}>{direction < 0 ? <ArrowUp size={14} aria-hidden /> : <ArrowDown size={14} aria-hidden />}</IconButton> : null; })}
      </div>
    </Row>)}</Card>}
    {(pages.length > 0 || more && nextPage) && <div className="k-pager">
      <IconButton label="Previous queue page" aria-disabled={busy || loading || !pages.length} onClick={() => { if (!busy && !loading && pages.length) { generation.current++; setRows([]); setLoading(true); setPages(values => values.slice(0,-1)); } }}><ChevronLeft size={16} aria-hidden /></IconButton>
      <IconButton label="Next queue page" aria-disabled={busy || loading || !more || !nextPage} onClick={() => { if (!busy && !loading && more && nextPage) { generation.current++; setRows([]); setLoading(true); setPages(values => [...values, nextPage]); } }}><ChevronRight size={16} aria-hidden /></IconButton>
    </div>}
  </div></Collapsible></div>;
}
