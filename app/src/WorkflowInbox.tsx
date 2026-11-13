import { useEffect, useRef, useState } from 'react';

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
  return <section className="setup workflow-panel"><h1 ref={heading} tabIndex={-1}>{result ? result.name : 'Workflow inbox'}</h1>
    <div className="form-actions routine-actions"><button className="secondary" onClick={onBack}>Back to workflows</button>{result && <button className="secondary" onClick={() => setResult(null)}>Back to inbox</button>}</div>
    {error && <p className="error" role="alert">{error}</p>}
    {result ? <p className="message-text">{result.last || 'Workflow completed without result text.'}</p> : <>
      <p>Results are saved on the server. Browser notifications cover only new results while this inbox is open; result contents are not shown in notifications.</p>
      <button className="secondary" disabled={permission === 'unsupported' || permission === 'denied'} onClick={async () => {
        if (enabled) { setEnabled(false); return; }
        try { const value = await Notification.requestPermission(); setPermission(value); setEnabled(value === 'granted'); }
        catch { setError('Notification permission could not be requested. Check browser settings.'); }
      }}>{enabled ? 'Turn off browser notifications' : 'Enable browser notifications'}</button>
      {permission === 'unsupported' && <p>This browser does not support notifications.</p>}{permission === 'denied' && <p>Notifications are blocked. Change site permissions in browser settings.</p>}
      <button className="secondary" onClick={() => setRefresh(value => value + 1)}>Reload inbox</button>
      {page ? <><p>{page.unread} unread results</p><ul className="routine-list">{page.notifications.map(item => <li key={item.run}><h2>{item.name}</h2><p>{new Date(item.created).toLocaleString()} · {item.read ? 'Read' : 'Unread'}</p><button className="secondary" disabled={busy} onClick={() => void open(item)}>Open result {item.name}</button></li>)}</ul>{!page.notifications.length && <p>No results on this page yet.</p>}</> : !error && <p role="status">Loading inbox...</p>}
      <div className="form-actions routine-actions"><button className="secondary" disabled={!cursors.length || busy} onClick={() => setCursors(value => value.slice(0, -1))}>Newer results</button><button className="secondary" disabled={!page?.next_before || busy} onClick={() => { if (page?.next_before) setCursors(value => [...value, page.next_before!]); }}>Older results</button></div>
    </>}
  </section>;
}
