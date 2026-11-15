// Changed-file navigation and unified/split toolbar adapted from T3 DiffPanel (MIT).
import { useEffect, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { Alert, Badge, Card, EmptyState, Row, Section, Select, SkeletonRows } from './ui/kit';
import { UnifiedDiff } from './SourceControl';
import { splitDiffLines } from '../diff-lines';
import type { PanelRequest } from './RightPanel';
export type GitStatus = { isRepo: boolean; branch?: string | null; changedFiles?: { code: string; path: string }[] };
type Diff = { text: string; truncated: boolean; binaryFiles: string[] };
export function PanelDiff({ base, status, request, refresh }: { base: string; status: GitStatus; request: PanelRequest; refresh: number }) {
  const files = status.changedFiles ?? [], [selected, setSelected] = useState(files[0]?.path ?? ''), [layout, setLayout] = useState('unified');
  const [diff, setDiff] = useState<Diff | null>(null), [error, setError] = useState('');
  const file = files.some(file => file.path === selected) ? selected : files[0]?.path;
  useEffect(() => { setDiff(null); }, [base, file]);
  useEffect(() => {
    let stopped = false; setError('');
    if (file) void request<Diff>(`${base}/git/diff?${new URLSearchParams({ path: file })}`).then(result => { if (!stopped) setDiff(result); }).catch(reason => { if (!stopped) setError(reason instanceof Error ? reason.message : 'Diff could not load.'); });
    return () => { stopped = true; };
  }, [base, file, request, refresh, status]);
  return <div className="right-panel__body k-stack">
    <Section title={status.branch ?? 'Detached HEAD'} actions={<Badge>{files.length} changed</Badge>}><p className="k-field__hint right-panel__branch"><GitBranch size={14} aria-hidden />Working tree, including staged and untracked files</p></Section>
    {!files.length ? <EmptyState title="Working tree clean" /> : <>
      <div className="right-panel__changed-files" aria-label="Changed files"><Card>{files.map(item => <Row key={item.path} title={<span title={item.path}>{item.path}</span>} leading={<span className="source-control__status">{item.code}</span>} meta={item.path === file ? 'Selected' : undefined} onClick={() => setSelected(item.path)} />)}</Card></div>
      <div className="right-panel__diff-toolbar"><span className="right-panel__path" title={file}>{file}</span><Select size="sm" label="Diff layout" value={layout} onChange={setLayout} options={[{ value: 'unified', label: 'Unified' }, { value: 'split', label: 'Split' }]} /></div>
      {error ? <Alert tone="error">{error}</Alert> : diff === null ? <SkeletonRows /> : <>
        {diff.truncated && <Alert tone="warn">Partial diff. Preview is limited to 256 KiB.</Alert>}
        {diff.binaryFiles.length ? <EmptyState title="Binary file">Only text diffs can be displayed.</EmptyState> : !diff.text ? <EmptyState title="No changes">File matches the current commit.</EmptyState> : layout === 'unified' ? <UnifiedDiff text={diff.text} /> : <div className="right-panel__split" role="region" aria-label="Split diff" tabIndex={0}><div>{splitDiffLines(diff.text).map((row, index) => row.heading !== undefined ? <div key={index} className="right-panel__split-heading">{row.heading}</div> : <div key={index} className="right-panel__split-row">{[row.left, row.right].map((line, side) => <div key={side} className={`right-panel__split-cell is-${line?.kind ?? 'empty'}`}><span className="git-diff__number">{side === 0 ? line?.old : line?.next}</span><code>{line?.text ?? ' '}</code></div>)}</div>)}</div></div>}
      </>}
    </>}
  </div>;
}
