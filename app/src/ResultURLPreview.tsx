import { navigateResult } from './hooks/useResultRoute';
import { useComputerResult } from './hooks/useComputerResult';
import { useURLPreview } from './hooks/useURLPreview';
import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { ComputerViewer } from './ComputerViewer';
import { EmptyState, IconButton, Button } from './ui/kit';
import type { PanelRequest } from './RightPanel';
import type { ResultTarget } from './navigation';

export function ResultURLPreview({ target, computer, name, request, onBack }: { target: ResultTarget; computer?: string; name: string; request: PanelRequest; onBack: () => void }) {
  const status = useURLPreview(target.path);
  const [failed, setFailed] = useState(false), browser = target.view === 'computer';
  const computerState = useComputerResult(browser ? computer : undefined, target.path, request);
  return <div className="right-panel__body k-stack">
    <div className="right-panel__preview-head"><IconButton label="Back to files" onClick={onBack}><ArrowLeft size={15} aria-hidden /></IconButton><span className="right-panel__path">{target.name || target.path}</span></div>
    {browser && !computer ? <EmptyState title="Computer unavailable" /> : browser && computer && computerState ? <p role="status">{computerState}</p> : browser && computer ? <ComputerViewer agent={computer} name={name} request={request} url={target.path} /> : status === 'loading' ? <p role="status">Loading preview...</p> : failed || status === 'missing' ? <EmptyState title="Page not found" /> : <iframe className="right-panel__preview" title="URL preview" sandbox="" referrerPolicy="no-referrer" src={target.path} onError={() => setFailed(true)} />}
    {!browser && computer && <Button onClick={() => navigateResult({ ...target, view: 'computer', agent: computer })}>Open in Computer</Button>}
  </div>;
}
