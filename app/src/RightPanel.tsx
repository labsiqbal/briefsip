import { usePolling } from './hooks/usePolling';
// Panel tabs and surface composition adapted from T3 (MIT); see ../t3/provenance.json.
import { useMemo, useState, type ReactNode } from 'react';
import { FileDiff, Files, Globe, Info, Monitor, RefreshCw, X } from 'lucide-react';
import { Alert, IconButton, TabPanel, Tabs } from './ui/kit';
import { PanelResizeHandle, detailsPanel, useResizablePanel } from './ui/resizable';
import { createRightPanelStore, rightPanelWidthKey } from './right-panel-state';
import { PanelFiles, PanelPreview, type PanelFile, type PanelSite } from './RightPanelFiles';
import { PanelDiff, type GitStatus } from './RightPanelDiff';
import { ComputerViewer } from './ComputerViewer';
import './right-panel.css';

export type PanelRequest = <T>(path: string, body?: unknown) => Promise<T>;
type Context = { workspace: { name: string; project?: string } | null; computer: string | null; sites: PanelSite[]; previews: PanelFile[] };
export type RightPanelExtension = { value: string; label: ReactNode; content: ReactNode };

export function useRightPanel(scope: string) {
  const store = useMemo(() => createRightPanelStore({ getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) }), []);
  const [tab, setTab] = useState(() => store.read(scope).tab);
  const spec = useMemo(() => ({ ...detailsPanel, key: rightPanelWidthKey(scope) }), [scope]);
  const panel = useResizablePanel(spec);
  return { tab, panel, select: (value: string) => { setTab(value); store.select(scope, value); } };
}

export function RightPanel({ path, name, state, request, onClose, details, settings, extensions = [] }: {
  path: string; name: string; state: ReturnType<typeof useRightPanel>; request: PanelRequest; onClose: () => void;
  details: ReactNode; settings?: ReactNode;
  /** Extra tabs: extensions={[{ value, label, content }]}. */
  extensions?: RightPanelExtension[];
}) {
  const base = `${path}/panel`;
  const [context, setContext] = useState<Context | null>(null), [files, setFiles] = useState<PanelFile[]>([]), [git, setGit] = useState<GitStatus | null>(null);
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(true);
  usePolling(async signal => {
    try {
      const [next, rows] = await Promise.all([request<Context>(base), request<PanelFile[]>(`${base}/files`)]);
      if (signal.aborted) return;
      setContext(next); setFiles(rows); setError('');
      if (next.workspace) {
        try { const status = await request<GitStatus>(`${base}/git`); if (!signal.aborted) setGit(status); }
        catch (reason) { if (!signal.aborted) { setGit(null); setError(reason instanceof Error ? reason.message : 'Source control could not load.'); } }
      } else setGit(null);
    } catch (reason) { if (!signal.aborted) { setContext(null); setFiles([]); setGit(null); setError(reason instanceof Error ? reason.message : 'Panel could not load.'); } }
    finally { if (!signal.aborted) setLoading(false); }
  }, { interval: 5000 }, [base, request, refresh]);
  const tabs = [
    { value: 'details', title: 'Details', label: <><Info size={14} aria-hidden /><span className="right-panel__tab-label">Details</span></> },
    { value: 'files', title: 'Files', label: <><Files size={14} aria-hidden /><span className="right-panel__tab-label">Files</span></> },
    ...(git?.isRepo ? [{ value: 'diff', title: 'Diff', label: <><FileDiff size={14} aria-hidden /><span className="right-panel__tab-label">Diff</span></> }] : []),
    ...(context?.previews.length || context?.sites.length ? [{ value: 'preview', title: 'Preview', label: <><Globe size={14} aria-hidden /><span className="right-panel__tab-label">Preview</span></> }] : []),
    ...(context?.computer ? [{ value: 'computer', title: 'Computer', label: <><Monitor size={14} aria-hidden /><span className="right-panel__tab-label">Computer</span></> }] : []),
    ...extensions,
  ];
  const selected = tabs.some(tab => tab.value === state.tab) ? state.tab : 'details';
  return <aside ref={state.panel.ref} className="details right-panel bs-root" style={{ width: `${state.panel.width}px` }} aria-label="Conversation details">
    <PanelResizeHandle panel={state.panel} />
    <div className="right-panel__header"><span>Conversation</span><div>{settings}<IconButton label="Reload panel" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden /></IconButton><IconButton label="Close details" onClick={onClose}><X size={16} aria-hidden /></IconButton></div></div>
    <Tabs label="Conversation panel" value={selected} onChange={state.select} tabs={tabs}>
      {error && <div className="right-panel__error"><Alert tone="error">{error}</Alert></div>}
      <TabPanel value="details">{details}</TabPanel>
      <TabPanel value="files"><PanelFiles key={base} base={base} files={files} workspace={context?.workspace?.name} loading={loading} request={request} /></TabPanel>
      <TabPanel value="diff">{git?.isRepo && <PanelDiff base={base} status={git} request={request} refresh={refresh} />}</TabPanel>
      <TabPanel value="preview"><PanelPreview base={base} files={context?.previews ?? []} sites={context?.sites ?? []} request={request} /></TabPanel>
      <TabPanel value="computer">{context?.computer && <div className="right-panel__computer"><ComputerViewer agent={context.computer} name={name} request={request} /></div>}</TabPanel>
      {extensions.map(extension => <TabPanel key={extension.value} value={extension.value}>{extension.content}</TabPanel>)}
    </Tabs>
  </aside>;
}
