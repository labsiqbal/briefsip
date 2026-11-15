import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileText, RefreshCw } from 'lucide-react';
import { Alert, Button, Card, CodeBlock, EmptyState, IconButton, Input, Row, Section, Select, SkeletonRows } from './ui/kit';
import { WorkspacePanel } from './WorkspacePanel';
import { HtmlPreview } from './HtmlPreview';
import { Markdown } from './Markdown';
import type { PanelRequest } from './RightPanel';
export type PanelFile = { seq: number; id: string; name: string; size: number };
export type PanelSite = { id: string; name: string; revision: number };
type OpenFile = { name: string; path: string };
export const previewURL = (path: string, preview: string) => `${path}${path.includes('?') ? '&' : '?'}preview=${preview}`;

function InlineFile({ file, request, onClose }: { file: OpenFile; request: PanelRequest; onClose: () => void }) {
  const heading = useRef<HTMLSpanElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const html = /\.html?$/i.test(file.name), image = /\.(png|jpe?g|webp)$/i.test(file.name);
  const [text, setText] = useState<string | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [page, setPage] = useState<{ next_offset?: number | null; digest?: string }>({}), [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    let stopped = false; setText(null); setPage({}); setError('');
    if (!html && !image) void request<{ text: string; next_offset?: number | null; digest?: string }>(previewURL(file.path, 'text')).then(result => { if (!stopped) { setText(result.text); setPage(result); } }).catch(reason => { if (!stopped) setError(reason instanceof Error ? reason.message : 'File could not load.'); });
    return () => { stopped = true; };
  }, [file.path, html, image, request, reload]);
  async function loadMore() {
    if (loadingMore || page.next_offset == null) return;
    setLoadingMore(true); setError('');
    try {
      const params = new URLSearchParams({ offset: String(page.next_offset), digest: page.digest! });
      const result = await request<{ text: string; next_offset?: number | null; digest?: string }>(`${previewURL(file.path, 'text')}&${params}`);
      setText(current => current + result.text); setPage(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'File could not load.'); }
    finally { setLoadingMore(false); }
  }
  return <Section title={<span ref={heading} tabIndex={-1} className="right-panel__path">{file.name}</span>} actions={<IconButton label="Close file" onClick={onClose}><ArrowLeft size={15} aria-hidden /></IconButton>}>
    <div className="k-inline"><a className="k-link" href={file.path.replace('/workspace/file?', '/workspace/download?')} download={file.name}>Download original</a><IconButton label="Reload file" disabled={loadingMore} onClick={() => { setError(''); setReload(value => value + 1); }}><RefreshCw size={14} aria-hidden /></IconButton></div>
    {error && <Alert tone="error">{error}</Alert>}
    {html ? <HtmlPreview key={reload} path={file.path} name={file.name} request={request} embedded /> : image ? <img key={reload} className="right-panel__image" src={previewURL(file.path, 'image')} alt={file.name} onError={() => setError('Image preview could not load. Download the original file.')} /> : !error && (text === null ? <SkeletonRows /> : /\.md(?:own)?$/i.test(file.name) ? <Markdown text={text} scope={file.path.split('/files/')[0]} origin={window.location.origin} /> : <>{/\.pdf$/i.test(file.name) && <p className="k-field__hint">Extracted PDF text. Layout, images and scanned pages are not included.</p>}<CodeBlock label={`Contents of ${file.name}`} maxHeight={600}>{text || '(Empty file)'}</CodeBlock></>)}
    {!html && !image && page.next_offset != null && <Button size="sm" busy={loadingMore} onClick={() => void loadMore()}>Load more text</Button>}
  </Section>;
}

export function PanelFiles({ base, files, workspace, loading, request }: { base: string; files: PanelFile[]; workspace?: string; loading: boolean; request: PanelRequest }) {
  const opener = useRef<HTMLElement | null>(null);
  function open(file: OpenFile) { opener.current = document.activeElement as HTMLElement; setSelected(file); }
  const [selected, setSelected] = useState<OpenFile | null>(null), [earlier, setEarlier] = useState<PanelFile[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [more, setMore] = useState(true);
  const rows = [...files, ...earlier.filter(row => !files.some(file => file.id === row.id))];
  async function loadMore() {
    if (busy || !rows.length) return; setBusy(true); setError('');
    try { const page = await request<PanelFile[]>(`${base}/files?before=${rows.at(-1)!.seq}`); setEarlier(current => [...current, ...page.filter(row => !current.some(file => file.id === row.id))]); setMore(page.length === 100); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Files could not load.'); } finally { setBusy(false); }
  }
  return <div className="right-panel__body k-stack">
    {selected && <InlineFile key={selected.path} file={selected} request={request} onClose={() => { setSelected(null); requestAnimationFrame(() => opener.current?.focus()); }} />}
    <div className="k-stack" hidden={!!selected}>
      <Section title="Conversation files">
        {loading ? <SkeletonRows /> : rows.length ? <Card>{rows.map(file => <Row key={file.id} title={file.name} leading={<FileText size={15} aria-hidden />} meta={`${file.size.toLocaleString('en-US')} bytes`} onClick={() => open({ name: file.name, path: `${base}/files/${file.id}` })} />)}</Card> : <EmptyState title="No files yet">Attachments and agent results appear here.</EmptyState>}
        {error && <Alert tone="error">{error}</Alert>}
        {files.length === 100 && more && <Button size="sm" busy={busy} onClick={() => void loadMore()}>Earlier files</Button>}
      </Section>
      {workspace && <WorkspacePanel key={base} agent={{ id: base, name: workspace }} basePath={`${base}/workspace`} compact request={request} onClose={() => {}} onOpenFile={path => open({ name: path.split('/').pop()!, path: `${base}/workspace/file?${new URLSearchParams({ path })}` })} />}
    </div>
  </div>;
}

export function PanelPreview({ base, files, sites, request }: { base: string; files: PanelFile[]; sites: PanelSite[]; request: PanelRequest }) {
  const items = [...files.filter(file => /\.html?$/i.test(file.name)).map(file => ({ value: file.id, label: file.name, path: `${base}/files/${file.id}` })), ...sites.map(site => ({ value: site.id, label: site.name, path: `${base}/sites/${site.id}` }))];
  const [selected, setSelected] = useState(items[0]?.value ?? ''), [reload, setReload] = useState(0), [error, setError] = useState('');
  const item = items.find(item => item.value === selected) ?? items[0];
  return <div className="right-panel__body k-stack">
    {items.length > 1 && <Select label="Preview artifact" value={item?.value ?? ''} options={items} onChange={value => { setSelected(value); setError(''); }} />}
    {item ? <><div className="right-panel__address"><Input aria-label="Preview address" readOnly value={item.path} /><IconButton label="Reload preview" onClick={() => { setError(''); setReload(value => value + 1); }}><RefreshCw size={15} aria-hidden /></IconButton></div>
      {error && <Alert tone="error">{error}</Alert>}
      {sites.some(site => site.id === item.value) ? <><p className="k-field__hint">Local static site. Scripts, forms, images and external connections are removed.</p><iframe key={`${item.path}:${reload}`} title={`Visual preview ${item.label}`} sandbox="" referrerPolicy="no-referrer" src={item.path} onError={() => setError('Site could not load. Reload to try again.')} className="right-panel__preview" /></> : <HtmlPreview key={`${item.path}:${reload}`} path={item.path} name={item.label} request={request} embedded />}
    </> : <EmptyState title="No HTML artifacts yet" />}
  </div>;
}
