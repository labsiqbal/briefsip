import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, IconButton, PageHeader, Row, Section, SkeletonRows } from './ui/kit';
import { ChevronLeft, ChevronRight, Inbox, RefreshCw } from 'lucide-react';

type Notice = { seq: number; run: string; name: string; created: string; read: number };
type Page = { notifications: Notice[]; next_before: number | null; unread: number };
export function WorkflowInbox({ request, onBack }: {
  request: <T>(path: string, data?: unknown) => Promise<T>; onBack: () => void;
}) {
  const [page, setPage] = useState<Page | null>(null), [cursors, setCursors] = useState<number[]>([]);
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ name: string; last: string } | null>(null);
  const [busy, setBusy] = useState(false), [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState('Notification' in window ? Notification.permission : 'unsupported');
  const heading = useRef<HTMLHeadingElement>(null), version = useRef(0), seen = useRef<number | null>(null);
  const before = cursors.at(-1);
  useEffect(() => { heading.current?.focus(); }, [result, before]);
  useEffect(() => () => { version.current++; }, []);
  // ponytail: inbox-only delivery; use push infrastructure for notifications after closing the app.
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    setPage(null); setError('');
    async function load() {
      try {
        const [data, latest] = await Promise.all([
          request<Page>(`/api/workflow-notifications${before ? `?before=${before}` : ''}`),
          before && enabled ? request<Page>('/api/workflow-notifications') : Promise.resolve(null),
        ]);
        if (stopped) return;
        setPage(data); setError('');
        if (!before || latest) {
          const current = latest ?? data, newest = current.notifications[0]?.seq ?? 0;
          if (enabled && seen.current !== null && newest > seen.current && Notification.permission === 'granted') {
            const count = current.notifications.filter(item => item.seq > seen.current! && !item.read).length;
            if (count) {
              try { new Notification('Workflow results available', { body: 'Open the Briefsip inbox to read results.', tag: 'briefsip-workflow-results' }); }
              catch { setEnabled(false); setError('Browser notifications are unavailable. Results remain saved in the inbox.'); }
            }
          }
          seen.current = newest;
        }
      } catch (error) { if (!stopped) setError(error instanceof Error ? error.message : 'Inbox could not load. Try again.'); }
      finally { if (!stopped) timer = setTimeout(load, 5000); }
    }
    void load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [before, refresh, enabled]);
  async function open(item: Notice) {
    if (busy) return;
    const current = ++version.current; setBusy(true); setError('');
    try {
      const run = await request<{ last: string }>(`/api/workflow-runs/${item.run}`);
      if (current !== version.current) return;
      await request(`/api/workflow-notifications/${item.run}/read`, { id: crypto.randomUUID() });
      if (current !== version.current) return;
      setResult({ name: item.name, last: run.last }); setRefresh(value => value + 1);
    } catch (error) { if (current === version.current) setError(error instanceof Error ? error.message : 'Result could not open. Try again.'); }
    finally { if (current === version.current) setBusy(false); }
  }
  return <div className="k-page bs-root">
    <PageHeader headingRef={heading} title={result ? result.name : 'Workflow inbox'} actions={<><Button variant="ghost" onClick={onBack}>Back to workflows</Button>{result ? <Button variant="ghost" onClick={() => setResult(null)}>Back to inbox</Button> : <IconButton label="Reload inbox" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden /></IconButton>}</>} />
    {error && <Alert tone="error">{error}</Alert>}
    {result ? <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result.last || 'Workflow completed without result text.'}</p> : <>
      <Alert actions={<Button disabled={permission === 'unsupported' || permission === 'denied'} onClick={async () => {
        if (enabled) { setEnabled(false); return; }
        try { const value = await Notification.requestPermission(); setPermission(value); setEnabled(value === 'granted'); }
        catch { setError('Notification permission could not be requested. Check browser settings.'); }
      }}>{enabled ? 'Turn off browser notifications' : 'Enable browser notifications'}</Button>}>Results are saved on the server. Browser notifications cover only new results while this inbox is open; result contents are not shown in notifications.</Alert>
      {permission === 'unsupported' && <Alert>This browser does not support notifications.</Alert>}{permission === 'denied' && <Alert>Notifications are blocked. Change site permissions in browser settings.</Alert>}
      <Section title={page ? `${page.unread} unread results` : 'Results'}>
        {page ? page.notifications.length ? <Card>{page.notifications.map(item => <Row key={item.run} title={item.name} meta={<><span>{new Date(item.created).toLocaleString()}</span><Badge tone={item.read ? 'neutral' : 'brand'}>{item.read ? 'Read' : 'Unread'}</Badge></>} onClick={() => void open(item)} disabled={busy} />)}</Card> : <EmptyState icon={<Inbox size={18} />} title="No results on this page yet" /> : !error && <><span className="sr-only" role="status">Loading inbox...</span><SkeletonRows /></>}
        {(cursors.length > 0 || page?.next_before) && <div className="k-pager"><IconButton label="Newer results" disabled={!cursors.length || busy} onClick={() => setCursors(value => value.slice(0, -1))}><ChevronLeft size={16} aria-hidden /></IconButton><IconButton label="Older results" disabled={!page?.next_before || busy} onClick={() => { if (page?.next_before) setCursors(value => [...value, page.next_before!]); }}><ChevronRight size={16} aria-hidden /></IconButton></div>}
      </Section>
    </>}
  </div>;
}
