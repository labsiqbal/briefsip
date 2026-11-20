import { usePolling } from './hooks/usePolling';
import { diffLines } from './diff-lines';
export { diffLines } from './diff-lines';
// Branch and diff-status patterns adapted from T3 (MIT); see ../t3/provenance.json.
import { useEffect, useRef, useState } from 'react';
import { ChevronRight, GitBranch, RefreshCw, RotateCcw } from 'lucide-react';
import { Alert, Badge, Button, Card, Dialog, EmptyState, IconButton, Row, Section, useConfirm, RecoveryAlert } from './ui/kit';
import './ui/source-control.css';

type Request = <T>(path: string, body?: unknown) => Promise<T>;
type Status = { isRepo: boolean; branch?: string | null; dirtyCount?: number; changedFiles?: { code: string; path: string }[]; localBranches?: string[]; worktrees?: { path: string; branch: string | null }[] };
type Diff = { text: string; truncated: boolean; binaryFiles: string[] };
const message = (error: unknown) => error instanceof Error ? error.message : 'Source control could not load. Try again.';

export function SourceControl({ agent, request, showEmpty = false, onOpenDiff }: { agent: string; request: Request; showEmpty?: boolean; onOpenDiff?: () => void }) {
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0), [loading, setLoading] = useState(false);
  const [file, setFile] = useState<string | null>(null), [diff, setDiff] = useState<Diff | null>(null), [diffError, setDiffError] = useState('');
  const generation = useRef(0);
  useEffect(() => { setStatus(null); setFile(null); }, [agent]);
  usePolling(async signal => {
    setLoading(true);
    try { const next = await request<Status>(`/api/agents/${agent}/git`); if (!signal.aborted) { setStatus(next); setError(''); } }
    catch (error) { if (!signal.aborted) setError(message(error)); }
    finally { if (!signal.aborted) setLoading(false); }
  }, { interval: 5000 }, [agent, request, reload]);
  useEffect(() => {
    const version = ++generation.current; setDiff(null); setDiffError('');
    if (file === null) return;
    void request<Diff>(`/api/agents/${agent}/git/diff?${new URLSearchParams({ path: file })}`).then(value => { if (version === generation.current) setDiff(value); }).catch(error => { if (version === generation.current) setDiffError(message(error)); });
    return () => { generation.current++; };
  }, [agent, file, request, reload]);
  if (!status?.isRepo && !error) return showEmpty ? <Section title="Source control"><EmptyState title={status ? "No Git repository in this folder" : "Loading source control..."} /></Section> : null;
  if (onOpenDiff) return <section aria-label="Source control"><div className="section-label">Source control</div>
    {error && <Alert tone="error">{error}</Alert>}
    {status?.isRepo && <button type="button" className="panel-row panel-row--link" onClick={onOpenDiff} aria-label={`Open Diff: ${status.branch ?? 'Detached HEAD'}, ${status.dirtyCount ? `${status.dirtyCount} changed` : 'Clean'}`}><GitBranch size={16} aria-hidden /><span className="panel-row__title">{status.branch ?? 'Detached HEAD'}</span><Badge>{status.dirtyCount ? `${status.dirtyCount} changed` : 'Clean'}</Badge><ChevronRight size={14} aria-hidden /></button>}
  </section>;
  return <div className="bs-root source-control"><Section id={`source-control-${agent}`} title="Source control" actions={<IconButton label="Refresh source control" disabled={loading} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} aria-hidden /></IconButton>}>
    {error && <Alert tone="error">{error}</Alert>}
    {status?.isRepo && <>
      <Card><Row title={status.branch ?? 'Detached HEAD'} leading={<GitBranch size={16} aria-hidden />} trailing={<Badge>{status.dirtyCount ? `${status.dirtyCount} changed` : 'Clean'}</Badge>} />
        <div className="source-control__files" aria-label="Changed files">
          {status.changedFiles?.length ? status.changedFiles.map(item => <Row key={item.path} title={<span title={item.path}>{item.path}</span>} leading={<span className="source-control__status" aria-label={item.code === '??' ? 'Untracked' : `Git status ${item.code}`}>{item.code}</span>} onClick={() => setFile(item.path)} />) : <EmptyState title="Working tree clean" />}
        </div>
      </Card>
      <p className="source-control__hint">Local branches: {status.localBranches?.length ?? 0} · Worktrees: {status.worktrees?.length ?? 0}</p>
    </>}
  </Section>
  <Dialog open={file !== null} onOpenChange={open => { if (!open) setFile(null); }} title="File diff" description={file ?? ''} size="lg">
    {diffError && <Alert tone="error" actions={<Button size="sm" onClick={() => setReload(value => value + 1)}>Retry diff</Button>}>{diffError}</Alert>}
    {!diff && !diffError && <p role="status">Loading diff...</p>}
    {diff && <>
      {diff.truncated && <Alert tone="warn">Partial diff preview. Output is limited to 256 KiB.</Alert>}
      {diff.binaryFiles.length > 0 ? <EmptyState title="Binary file">Only text diffs can be displayed.</EmptyState> : diff.text ? <UnifiedDiff text={diff.text} /> : <EmptyState title="No changes">This file matches the current commit.</EmptyState>}
    </>}
  </Dialog></div>;
}

export function UnifiedDiff({ text }: { text: string }) {
  return <div className="git-diff" role="region" aria-label="Unified diff" tabIndex={0}><div className="git-diff__lines">{diffLines(text).map((line, index) => <div key={index} className={`git-diff__line is-${line.kind}`}><span className="git-diff__number" aria-label={line.old ? `Old line ${line.old}` : undefined}>{line.old}</span><span className="git-diff__number" aria-label={line.next ? `New line ${line.next}` : undefined}>{line.next}</span><code>{line.text || ' '}</code></div>)}</div></div>;
}

type Preview = { turn: string; digest: string; files: { path: string; action: string }[] };
type RestoreCommand = { id: string; checkpointId: string; digest: string };
export function RestoreCheckpoint({ agent, turn, request }: { agent: string; turn: string; request: Request }) {
  const confirm = useConfirm(), storage = `minarbot:git-restore:${agent}:${turn}`;
  const [open, setOpen] = useState(false), [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pending, setPending] = useState<RestoreCommand | null>(null), [invalid, setInvalid] = useState(false);
  const flight = useRef(false);
  useEffect(() => { try {
    const raw = sessionStorage.getItem(storage); if (!raw) return;
    const value = JSON.parse(raw);
    if (!value || Object.keys(value).some(key => !['id', 'checkpointId', 'digest'].includes(key)) || !/^[a-f0-9-]{36}$/.test(value.id) || value.checkpointId !== turn || !/^[a-f0-9]{64}$/.test(value.digest)) throw new Error('Invalid saved restoration.');
    setPending(value);
  } catch { setInvalid(true); } }, [storage, turn]);
  async function show() {
    setOpen(true); if (flight.current || pending || invalid) return;
    flight.current = true; setBusy(true); setError(''); setPreview(null);
    try { setPreview(await request<Preview>(`/api/agents/${agent}/git/checkpoints/${turn}`)); }
    catch (error) { setError(message(error)); }
    finally { flight.current = false; setBusy(false); }
  }
  async function restore() {
    if (flight.current || invalid || !pending && !preview) return;
    flight.current = true; setBusy(true); setError('');
    try {
      const command = pending ?? { id: crypto.randomUUID(), checkpointId: turn, digest: preview!.digest };
      sessionStorage.setItem(storage, JSON.stringify(command)); setPending(command);
      const result = await request<{ restored?: boolean; error?: string }>(`/api/agents/${agent}/git/checkpoints/${turn}/restore`, command);
      if (!result.restored) throw new Error(result.error ?? 'Restoration is uncertain. Inspect source control before another write.');
      sessionStorage.removeItem(storage); setPending(null); setOpen(false); setNotice('Workspace files restored. A safety checkpoint was saved.');
    } catch (error) { setError(message(error)); }
    finally { flight.current = false; setBusy(false); }
  }
  async function discard() {
    if (!await confirm({ title: 'Clear restoration request?', description: 'Inspect the workspace first. Files already restored stay changed; clearing this request does not undo them.', confirm: 'Clear request', danger: true })) return;
    try { sessionStorage.removeItem(storage); setPending(null); setInvalid(false); setOpen(false); setError(''); } catch (error) { setError(message(error)); }
  }
  return <div className="bs-root checkpoint-action"><IconButton label="Restore to before this turn" onClick={() => void show()}><RotateCcw size={14} aria-hidden /></IconButton>{notice && <p role="status" className="source-control__hint">{notice}</p>}
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }} title="Restore to before this turn?" description="Restore the listed workspace files. Current files are checkpointed first. HEAD and the Git index stay unchanged." footer={<>
      {(pending || invalid) && <Button disabled={busy} onClick={() => void discard()}>Clear request</Button>}
      <Button disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
      <Button variant="danger" busy={busy} disabled={busy || invalid || !pending && !preview?.files.length} onClick={() => void restore()}>{pending ? 'Check restoration result' : 'Restore files'}</Button>
    </>}>
      {error && <Alert tone="error">{error}</Alert>}
      {invalid && <Alert tone="error">Saved restoration request could not be read. Inspect workspace files before clearing it.</Alert>}
      {pending && <RecoveryAlert inFlight={busy} tone="warn">Restoration was requested. Check its saved result before another write.</RecoveryAlert>}
      {busy && !preview && <p role="status">Loading checkpoint...</p>}
      {preview && <ul className="checkpoint-files" aria-label="Files to restore">{preview.files.map(file => <li key={file.path}><span>{file.path}</span><Badge>{file.action}</Badge></li>)}</ul>}
      {preview && !preview.files.length && <EmptyState title="No files to restore">Workspace already matches this checkpoint.</EmptyState>}
    </Dialog>
  </div>;
}
