// Changed-file navigation and unified/split toolbar adapted from T3 DiffPanel (MIT).
import { useState } from 'react';
import { GitBranch, WrapText } from 'lucide-react';
import { Alert, Badge, Card, EmptyState, Row, Section, Select, SkeletonRows, IconButton } from './ui/kit';
import { usePolling } from './hooks/usePolling';
import { diffLines, splitDiffLines } from './diff-lines';
import type { PanelRequest } from './RightPanel';
export type GitStatus = { isRepo: boolean; branch?: string | null; changedFiles?: { code: string; path: string }[] };
type Diff = { text: string; truncated: boolean; binaryFiles: string[] };
export function PanelDiff({ base, status, request, refresh }: { base: string; status: GitStatus; request: PanelRequest; refresh: number }) {
  const files = status.changedFiles ?? [], [selected, setSelected] = useState(files[0]?.path ?? ''), [layout, setLayout] = useState('unified'), [wrap, setWrap] = useState(true);
  const [diff, setDiff] = useState<Diff | null>(null), [error, setError] = useState('');
  const file = files.some(file => file.path === selected) ? selected : files[0]?.path;
  usePolling(async signal => {
    if (!file) return;
    try { const result = await request<Diff>(`${base}/git/diff?${new URLSearchParams({ path: file })}`); if (!signal.aborted) { setDiff(result); setError(''); } }
    catch (reason) { if (!signal.aborted) setError(reason instanceof Error ? reason.message : 'Diff could not load.'); }
  }, { interval: 5000 }, [base, file, request, refresh]);
  const lines = diffLines(diff?.text ?? '');
  const added = lines.filter(line => line.kind === 'add').length, removed = lines.filter(line => line.kind === 'remove').length;
  return <div className={`right-panel__body k-stack${wrap ? ' is-wrapped' : ''}`}>
    <Section title={<span className="right-panel__branch"><GitBranch size={14} aria-hidden />{status.branch ?? 'Detached HEAD'}</span>} actions={<Badge>{files.length} changed</Badge>}>{null}</Section>
    {!files.length ? <EmptyState title="Working tree clean" /> : <>
      <div className="right-panel__changed-files" aria-label="Changed files"><Card>{files.map(item => <Row key={item.path} title={<span title={item.path} aria-current={item.path === file || undefined}>{item.path}</span>} leading={<span className="source-control__status" title={statusLabel(item.code)}>{item.code.trim() === '??' ? 'U' : item.code.trim().charAt(0)}</span>} onClick={() => { if (item.path !== file) { setSelected(item.path); setDiff(null); setError(''); } }} />)}</Card></div>
      <div className="right-panel__preview-head"><span className="right-panel__path" title={file}>{file}</span><div className="right-panel__diff-counts" aria-label="Line changes"><span>+{added}</span><span>-{removed}</span></div></div>
      <div className="right-panel__diff-toolbar"><Select size="sm" label="Diff layout" value={layout} onChange={setLayout} options={[{ value: 'unified', label: 'Unified' }, { value: 'split', label: 'Split' }]} /><IconButton label="Wrap lines" aria-pressed={wrap} onClick={() => setWrap(value => !value)}><WrapText size={15} aria-hidden /></IconButton></div>
      {error ? <Alert tone="error">{error}</Alert> : diff === null ? <SkeletonRows /> : <>
        {diff.truncated && <Alert tone="warn">Partial diff. Preview is limited to 256 KiB.</Alert>}
        {diff.binaryFiles.length ? <EmptyState title="Binary file">Only text diffs can be displayed.</EmptyState> : !diff.text ? <EmptyState title="No changes">File matches the current commit.</EmptyState> : layout === 'unified' ? <div className="git-diff" role="region" aria-label="Unified diff" tabIndex={0}><div className="git-diff__lines">{lines.filter(line => line.kind !== 'meta').map((line, index) => <div key={index} className={`git-diff__line is-${line.kind}`}><span className="git-diff__number" aria-label={line.old ? `Old line ${line.old}` : undefined}>{line.old}</span><span className="git-diff__number" aria-label={line.next ? `New line ${line.next}` : undefined}>{line.next}</span><code>{line.text || ' '}</code></div>)}</div></div> : <div className="right-panel__split" role="region" aria-label="Split diff" tabIndex={0}><div>{splitDiffLines(diff.text).filter(row => row.heading === undefined || row.heading.startsWith('@@')).map((row, index) => row.heading !== undefined ? <div key={index} className="right-panel__split-heading">{row.heading}</div> : <div key={index} className="right-panel__split-row">{[row.left, row.right].map((line, side) => <div key={side} className={`right-panel__split-cell is-${line?.kind ?? 'empty'}`}><span className="git-diff__number">{side === 0 ? line?.old : line?.next}</span><code>{line?.text ?? ' '}</code></div>)}</div>)}</div></div>}
      </>}
    </>}
  </div>;
}

function statusLabel(code: string) {
  const value = code.trim();
  return value === '??' ? 'Untracked' : ({ M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict' } as Record<string, string>)[value.charAt(0)] ?? value;
}
