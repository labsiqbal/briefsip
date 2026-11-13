import { useEffect, useRef, useState } from 'react';
type Summary = { version: string; through: number; summary: string; source_count: number; sources: { id: string; seq: number; status: string }[]; next_after: number | null };
export function CompactionPanel({ path, request }: { path: string; request: <T>(path: string) => Promise<T> }) {
  const [open, setOpen] = useState(false), [data, setData] = useState<Summary | null>(null), [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  const [pages, setPages] = useState<number[]>([]), [refresh, setRefresh] = useState(0), after = pages.at(-1) ?? 0;
  const heading = useRef<HTMLHeadingElement>(null), focusPage = useRef(false);
  useEffect(() => { if (loaded && focusPage.current) { heading.current?.focus(); focusPage.current = false; } }, [loaded]);
  useEffect(() => {
    if (!open) return;
    let stopped = false; setLoaded(false); setError('');
    void request<Summary | null>(`${path}?after=${after}`).then(value => { if (!stopped) { setData(value); setLoaded(true); } }).catch(error => { if (!stopped) setError(error instanceof TypeError ? 'Summary could not load. Try reloading.' : error.message); });
    return () => { stopped = true; };
  }, [open, after, refresh, path]);
  return <details className="conversation-files" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>History summary</summary>
    {open && <><p>Older messages are summarized incrementally by the provider; additional calls are recorded in Usage. Original history stays intact. Summaries may miss details; check source messages for important decisions.</p>
      <button className="secondary" onClick={() => setRefresh(n => n + 1)}>Reload summary</button>
      {error ? <p role="alert">{error}</p> : !loaded ? <p role="status">Loading summary...</p> : !data ? <p>No valid summary yet. Replies still use recent history.</p> : <><p>{data.source_count} source messages, through execution position {data.through}. Message receipt order remains visible in the source list.</p><pre>{data.summary}</pre><details open><summary>Source messages</summary><h2 ref={heading} tabIndex={-1}>Source list</h2><ul>{data.sources.map(source => <li key={source.id}><span>Order {source.seq} · {source.status}</span><code>{source.id}</code></li>)}</ul><div className="form-actions routine-actions"><button className="secondary" disabled={!pages.length} onClick={() => { focusPage.current = true; setPages(v => v.slice(0, -1)); }}>Previous sources</button><button className="secondary" disabled={!data.next_after} onClick={() => { focusPage.current = true; setPages(v => [...v, data.next_after!]); }}>Next sources</button></div></details></>}
    </>}
  </details>;
}
