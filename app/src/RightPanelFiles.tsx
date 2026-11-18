import { useVisiblePolling } from './hooks/useVisiblePolling';
import { readJson } from './http';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Download, Ellipsis, FileText } from 'lucide-react';
import { ActionMenu, Alert, Button, CodeBlock, EmptyState, IconButton, Section, Select, SkeletonRows, Tooltip, useConfirm } from './ui/kit';
import { TranscriptionPanel } from './TranscriptionPanel';
import { WorkspacePanel } from './WorkspacePanel';
import { attachmentSize, isAttachmentImage } from './attachments';
import { HtmlPreview } from './HtmlPreview';
import { Markdown } from './Markdown';
import type { PanelRequest } from './RightPanel';
export type PanelFile = { seq: number; id: string; name: string; size: number; image?: boolean };
export type PanelSite = { id: string; name: string; revision: number };
export type OpenFile = { name: string; path: string; image?: boolean; transcribe?: boolean };
export const previewURL = (path: string, preview: string) => `${path}${path.includes('?') ? '&' : '?'}preview=${preview}`;

function InlineFile({ file: selected, request, onClose }: { file: OpenFile; request: PanelRequest; onClose: () => void }) {
  const [file, setFile] = useState(selected);
  const heading = useRef<HTMLSpanElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const image = isAttachmentImage(file), html = !image && /\.html?$/i.test(file.name);
  const [text, setText] = useState<string | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [page, setPage] = useState<{ next_offset?: number | null; digest?: string }>({}), [loadingMore, setLoadingMore] = useState(false);
  const digest = useRef<string | undefined>(undefined);
  const root = useVisiblePolling(useCallback(async current => {
    if (file.transcribe) return;
    try {
      const metadata = /\/files\//.test(file.path) ? await request<{ name: string; image: boolean }>(`${file.path}?metadata=1`) : null;
      if (!current()) return;
      if (metadata && (metadata.name !== file.name || metadata.image !== file.image)) setFile({ ...file, name: metadata.name, image: metadata.image });
      if (metadata ? /\.html?$/i.test(metadata.name) || metadata.image || file.transcribe : html || image || file.transcribe) { setError(''); return; }
      const result = await request<{ text: string; next_offset?: number | null; digest?: string }>(previewURL(file.path, 'text'));
      if (current()) {
        if (!result.digest || digest.current !== result.digest) { setText(result.text); setPage(result); digest.current = result.digest; }
        setError('');
      }
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : 'File could not load.'); }
  }, [file.path, file.name, file.image, file.transcribe, html, image, request, reload]));
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
  return <div ref={root}><Section title={<span className="right-panel__preview-head"><IconButton label="Close file" tooltip="Back to files" onClick={onClose}><ArrowLeft size={15} aria-hidden /></IconButton><span ref={heading} tabIndex={-1} className="right-panel__path">{file.name}</span></span>} actions={<><Tooltip content="Download original. Preview removes scripts, forms, links and external resources."><a className="k-icon-btn" aria-label="Download original" href={file.path.replace('/workspace/file?', '/workspace/download?')} download={file.name}><Download size={15} aria-hidden /></a></Tooltip></>}>

    {error && !html && <Alert tone="error" actions={<Button size="sm" onClick={() => setReload(value => value + 1)}>Retry</Button>}>{error}</Alert>}
    {file.transcribe ? <TranscriptionPanel path={file.path.replace('/panel/files/', '/files/')} request={request} /> : html ? <HtmlPreview key={reload} path={file.path} name={file.name} request={request} /> : image ? <img key={reload} className="right-panel__image" src={previewURL(file.path, 'image')} alt={file.name} onError={() => setError('Image preview could not load. Download the original file.')} /> : !error && (text === null ? <SkeletonRows /> : /\.md(?:own)?$/i.test(file.name) ? <Markdown text={text} scope={file.path.split('/files/')[0]} origin={window.location.origin} /> : <>{/\.pdf$/i.test(file.name) && <p className="k-field__hint">Extracted PDF text. Layout, images and scanned pages are not included.</p>}<CodeBlock label={`Contents of ${file.name}`} maxHeight={600}>{text || '(Empty file)'}</CodeBlock></>)}
    {!html && !image && page.next_offset != null && <Button size="sm" busy={loadingMore} onClick={() => void loadMore()}>Load more text</Button>}
  </Section></div>;
}

export function PanelFiles({ selected, onSelect, onDeleted, navigation, base, files, workspace, loading, request, attached, attachedCount = attached.length, onAttach, attachDisabled }: { selected: OpenFile | null; onSelect: (file: OpenFile | null) => void; onDeleted: () => void; navigation?: ReactNode; attachedCount?: number; attached: string[]; onAttach?: (file: PanelFile) => void; attachDisabled: boolean; base: string; files: PanelFile[]; workspace?: string; loading: boolean; request: PanelRequest }) {
  const opener = useRef<HTMLElement | null>(null);
  function open(file: OpenFile) { opener.current = document.activeElement as HTMLElement; onSelect(file); }
  const confirm = useConfirm();
  const [removed, setRemoved] = useState<string[]>([]);
  const [earlier, setEarlier] = useState<PanelFile[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [more, setMore] = useState(true);
  const rows = [...files, ...earlier.filter(row => !files.some(file => file.id === row.id))].filter(file => !removed.includes(file.id));
  async function remove(file: PanelFile) {
    if (!await confirm({ title: `Delete ${file.name}?`, description: 'This removes the file from this conversation and storage.', confirm: 'Delete file', danger: true })) return;
    setError('');
    try {
      const response = await fetch(`${base.replace('/panel', '')}/files/${file.id}`, { method: 'DELETE' });
      if (!response.ok) await readJson(response, 'File could not be deleted. Try again.');
      setRemoved(current => [...current, file.id]); document.querySelector<HTMLElement>('.right-panel [role=tab][data-state=active]')?.focus(); onDeleted();
      if (attached.includes(file.id)) onAttach?.(file);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'File could not be deleted. Try again.'); }
  }
  async function loadMore() {
    if (busy || !rows.length) return; setBusy(true); setError('');
    try { const page = await request<PanelFile[]>(`${base}/files?before=${rows.at(-1)!.seq}`); setEarlier(current => [...current, ...page.filter(row => !current.some(file => file.id === row.id))]); setMore(page.length === 100); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Files could not load.'); } finally { setBusy(false); }
  }
  return <div className="right-panel__body k-stack">
    {selected && <InlineFile key={selected.path} file={selected} request={request} onClose={() => { onSelect(null); requestAnimationFrame(() => opener.current?.focus()); }} />}
    <div className="k-stack" hidden={!!selected}>
      {navigation}
      {(loading || !!rows.length || !workspace) && <Section title="Conversation files">
        {loading ? <SkeletonRows /> : rows.length ? <div className="attachments__list right-panel__files" role="region" aria-label="Conversation files list" tabIndex={0}>{rows.map(file => <div className="right-panel__file-row" key={file.id}>
          <button type="button" className="right-panel__file" aria-label={`Preview ${file.name}`} onClick={() => open({ name: file.name, image: file.image, path: `${base}/files/${file.id}` })}><span className="right-panel__thumbnail">{isAttachmentImage(file) ? <img src={`${base}/files/${file.id}?preview=image`} alt="" loading="lazy" /> : <FileText size={16} aria-hidden />}</span><span className="right-panel__file-name">{file.name}</span><span className="right-panel__file-size">{attachmentSize(file.size)}</span></button>
          <ActionMenu label={`File actions: ${file.name}`} trigger={<IconButton label={`File actions: ${file.name}`} tooltip="More actions"><Ellipsis size={16} aria-hidden /></IconButton>} items={[
            { label: 'Open', onSelect: () => open({ name: file.name, image: file.image, path: `${base}/files/${file.id}` }) },
            { label: 'Download', onSelect: () => { const link = document.createElement('a'); link.href = `${base}/files/${file.id}`; link.download = file.name; link.click(); } },
            { label: 'Delete', danger: true, onSelect: () => void remove(file) },
            ...(/\.(mp3|wav|ogg|m4a|webm|mp4|mov)$/i.test(file.name) ? [{ label: 'Transcribe', onSelect: () => open({ name: file.name, path: `${base}/files/${file.id}`, transcribe: true }) }] : []),
            ...(onAttach ? [{ label: attached.includes(file.id) ? 'Remove from message' : 'Attach to message', disabled: attachDisabled || !attached.includes(file.id) && attachedCount >= 4, onSelect: () => onAttach(file) }] : []),
          ]} />
        </div>)}</div> : !workspace && <EmptyState title="No files yet" />}

        {error && <Alert tone="error">{error}</Alert>}
        {files.length === 100 && more && <Button size="sm" busy={busy} onClick={() => void loadMore()}>Earlier files</Button>}
      </Section>}
      {workspace && <WorkspacePanel key={base} agent={{ id: base, name: workspace }} basePath={`${base}/workspace`} compact request={request} onClose={() => {}} onOpenFile={path => open({ name: path.split('/').pop()!, path: `${base}/workspace/file?${new URLSearchParams({ path })}` })} />}
    </div>
  </div>;
}

export function PanelPreview({ base, files, sites, request, onBack }: { onBack: () => void; base: string; files: PanelFile[]; sites: PanelSite[]; request: PanelRequest }) {
  const items = [...files.filter(file => /\.html?$/i.test(file.name)).map(file => ({ value: file.id, label: file.name, path: `${base}/files/${file.id}` })), ...sites.map(site => ({ value: site.id, label: site.name, path: `${base}/sites/${site.id}` }))];
  const [selected, setSelected] = useState(items[0]?.value ?? ''), [error, setError] = useState('');
  const item = items.find(item => item.value === selected) ?? items[0];
  return <div className="right-panel__body k-stack">
    <div className="right-panel__preview-head"><IconButton label="Back to files" onClick={onBack}><ArrowLeft size={15} aria-hidden /></IconButton><span className="right-panel__path">{item?.label ?? 'Preview'}</span>{item && <Tooltip content="Download original"><a className="k-icon-btn" aria-label="Download original" href={item.path} download={item.label}><Download size={15} aria-hidden /></a></Tooltip>}</div>
    {items.length > 1 && <Select label="Preview artifact" value={item?.value ?? ''} options={items} onChange={value => { setSelected(value); setError(''); }} />}
    {item ? <>
      {error && <Alert tone="error">{error}</Alert>}
      {sites.some(site => site.id === item.value) ? <><iframe key={`${item.path}:${sites.find(site => site.id === item.value)?.revision ?? 0}`} title={`Visual preview ${item.label}`} sandbox="" referrerPolicy="no-referrer" src={item.path} onError={() => setError('Site could not load.')} className="right-panel__preview" /></> : <HtmlPreview key={`${item.path}:${sites.find(site => site.id === item.value)?.revision ?? 0}`} path={item.path} name={item.label} request={request} />}
    </> : <EmptyState title="No HTML artifacts yet" />}
  </div>;
}
