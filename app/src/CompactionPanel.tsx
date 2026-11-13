import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Alert, Button, Card, CodeBlock, Collapsible, IconButton, Row } from './ui/kit';
type Summary = { version: string; through: number; summary: string; source_count: number; sources: { id: string; seq: number; status: string }[]; next_after: number | null };
// ponytail: kit lacks controlled open state; replace this wrapper when it supports it.
function SourceMessages({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return <div onClickCapture={event => {
    const trigger = (event.target as Element).closest('button');
    if (trigger === event.currentTarget.querySelector('.k-collapsible__trigger')) setOpen(trigger?.getAttribute('aria-expanded') !== 'true');
  }}><Collapsible title="Source messages" defaultOpen><div className="k-stack" style={{ display: open ? undefined : 'none' }}>{children}</div></Collapsible></div>;
}
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
  // Kit Collapsible is uncontrolled; track only its outer trigger to retain lazy loading.
  return <div className="k-stack bs-root" onClickCapture={event => {
    const trigger = (event.target as Element).closest('button');
    if (trigger === event.currentTarget.querySelector('.k-collapsible__trigger')) setOpen(trigger?.getAttribute('aria-expanded') !== 'true');
  }}><Collapsible title="History summary">
    {open && <><p className="k-field__hint" style={{ margin: 0 }}>Older messages are summarized incrementally by the provider; additional calls are recorded in Usage. Original history stays intact. Summaries may miss details; check source messages for important decisions.</p>
      <div className="k-row-actions"><Button size="sm" onClick={() => setRefresh(n => n + 1)}>Reload summary</Button></div>
      {error ? <Alert tone="error">{error}</Alert> : !loaded ? <p className="k-field__hint" role="status">Loading summary...</p> : !data ? <p className="k-field__hint" style={{ margin: 0 }}>No valid summary yet. Replies still use recent history.</p> : <>
        <p className="k-field__hint" style={{ margin: 0 }}>{data.source_count} source messages, through execution position {data.through}. Message receipt order remains visible in the source list.</p>
        <CodeBlock label="History summary">{data.summary}</CodeBlock>
        <SourceMessages>
          <h2 ref={heading} tabIndex={-1} className="k-section__title">Source list</h2>
          <Card>{data.sources.map(source => <Row key={source.id} title={<>Order {source.seq} · {source.status}</>} meta={<code style={{ overflowWrap: 'anywhere' }}>{source.id}</code>} />)}</Card>
          {(pages.length > 0 || data.next_after) && <div className="k-pager">
            <IconButton label="Previous sources" disabled={!pages.length} onClick={() => { focusPage.current = true; setPages(v => v.slice(0, -1)); }}><ChevronLeft size={16} aria-hidden /></IconButton>
            <IconButton label="Next sources" disabled={!data.next_after} onClick={() => { focusPage.current = true; setPages(v => [...v, data.next_after!]); }}><ChevronRight size={16} aria-hidden /></IconButton>
          </div>}
        </SourceMessages>
      </>}
    </>}
  </Collapsible></div>;
}
