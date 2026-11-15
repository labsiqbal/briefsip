// Panel tabs and surface composition adapted from T3 (MIT); see ../t3/provenance.json.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Activity, FileDiff, Files, Globe, MessageSquare, Monitor, X } from 'lucide-react';
import { Dialog as Sheet } from 'radix-ui';
import { useVisiblePolling } from './hooks/useVisiblePolling';
import type { ComputerStatus } from './AgentComputerPanel';
import { Alert, Badge, Button, IconButton, TabPanel, Tabs } from './ui/kit';
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
  const [selection, setSelection] = useState(() => ({ scope, tab: store.read(scope).tab }));
  if (selection.scope !== scope) setSelection({ scope, tab: store.read(scope).tab });
  const tab = selection.scope === scope ? selection.tab : store.read(scope).tab;
  const computer = tab === 'computer';
  const spec = useMemo(() => ({ ...detailsPanel, key: rightPanelWidthKey(computer ? `${scope}:computer` : scope), defaultWidth: computer ? Math.round(window.innerWidth / 2) : 360 }), [scope, computer]);
  const panel = useResizablePanel(spec, -360);
  const select = useCallback((value: string) => { setSelection({ scope, tab: value }); store.select(scope, value); }, [scope, store]);
  return { tab, panel, select };
}

export function RightPanel({ path, name, state, request, onClose, details, activity, attached = [], attachedCount = attached.length, onAttach, attachDisabled = false, settings, extensions = [] }: {
  path: string; name: string; state: ReturnType<typeof useRightPanel>; request: PanelRequest; onClose: () => void;
  details: ReactNode; activity: ReactNode; attached?: string[]; attachedCount?: number; onAttach?: (file: PanelFile) => void; attachDisabled?: boolean; settings?: ReactNode;
  /** Extra tabs: extensions={[{ value, label, content }]}. */
  extensions?: RightPanelExtension[];
}) {
  const base = `${path}/panel`;
  const [context, setContext] = useState<Context | null>(null), [files, setFiles] = useState<PanelFile[]>([]), [git, setGit] = useState<GitStatus | null>(null);
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(true);
  const [computerAvailable, setComputerAvailable] = useState(false);
  const root = useVisiblePolling(useCallback(async current => {
    try {
      const [next, rows] = await Promise.all([request<Context>(base), request<PanelFile[]>(`${base}/files`)]);
      if (!current()) return;
      setContext(next); setFiles(rows); setError('');
      if (next.computer) {
        const computer = await request<ComputerStatus>(`/api/agents/${next.computer}/computer`);
        if (current()) { setComputerAvailable(computer.available); if (!computer.available && state.tab === 'computer') state.select('chats'); }
      } else { setComputerAvailable(false); if (state.tab === 'computer') state.select('chats'); }
      if (next.workspace) {
        const status = await request<GitStatus>(`${base}/git`);
        if (current()) setGit(status);
      } else setGit(null);
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : 'Panel could not load.'); }
    finally { if (current()) setLoading(false); }
  }, [base, request, refresh, state.tab, state.select]));
  const host = useRef<HTMLDivElement>(null), [available, setAvailable] = useState(window.innerWidth);
  useLayoutEffect(() => {
    const parent = host.current?.parentElement;
    if (!parent) return;
    const measure = () => setAvailable(parent.clientWidth);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  const setHost = useCallback((element: HTMLDivElement | null) => { host.current = element; state.panel.ref(element); }, [state.panel.ref]);
  const [mount] = useState(() => { const element = document.createElement('div'); element.className = 'right-panel-mount'; return element; });
  const place = useCallback((element: HTMLDivElement | null) => { if (element) element.appendChild(mount); }, [mount]);
  const inside = useRef(new WeakSet<Event>());
  const [overlay, setOverlay] = useState(false);
  useLayoutEffect(() => {
    // Keep open dialogs mounted across panel layout changes.
    const measure = () => {
      if ([...document.querySelectorAll('[role=dialog], [role=alertdialog]')].some(dialog => !dialog.closest('.right-panel-sheet'))) return;
      setOverlay(available - state.panel.width < 640);
    };
    measure();
    const observer = new MutationObserver(measure); observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [available, state.panel.width]);
  const tabs = [
    { value: 'chats', title: 'Chats', label: <><MessageSquare size={14} aria-hidden /><span className="right-panel__tab-label">Chats</span></> },
    { value: 'activity', title: 'Activity', label: <><Activity size={14} aria-hidden /><span className="right-panel__tab-label">Activity</span></> },
    { value: 'files', title: 'Files', label: <><Files size={14} aria-hidden /><span className="right-panel__tab-label">Files</span></> },
    ...(context?.computer && computerAvailable ? [{ value: 'computer', title: 'Computer', label: <><Monitor size={14} aria-hidden /><span className="right-panel__tab-label">Computer</span></> }] : []),
    ...extensions,
  ];
  const selected = ['diff', 'preview'].includes(state.tab) ? 'files' : tabs.some(tab => tab.value === state.tab) ? state.tab : 'chats';
  const content = <aside className="details right-panel bs-root" style={{ width: `${state.panel.width}px` }} aria-label="Conversation details" onPointerDownCapture={event => inside.current.add(event.nativeEvent)}>
    {!overlay && <PanelResizeHandle panel={state.panel} />}
    <div className="right-panel__header"><span>Conversation</span><div>{settings}<IconButton label="Close details" onClick={onClose}><X size={16} aria-hidden /></IconButton></div></div>
    <Tabs label="Conversation panel" value={selected} onChange={state.select} tabs={tabs}>
      {error && <div className="right-panel__error"><Alert tone="error" actions={<Button size="sm" onClick={() => setRefresh(value => value + 1)}>Retry</Button>}>{error}</Alert></div>}
      <TabPanel value="chats">{details}</TabPanel>
      <TabPanel value="activity">{activity}</TabPanel>
      <TabPanel value="files">
        {state.tab === 'diff' && git?.isRepo ? <><div className="right-panel__body"><Button size="sm" variant="ghost" onClick={() => state.select('files')}>Back to files</Button></div><PanelDiff base={base} status={git} request={request} refresh={refresh} /></> : state.tab === 'preview' ? <><div className="right-panel__body"><Button size="sm" variant="ghost" onClick={() => state.select('files')}>Back to files</Button></div><PanelPreview base={base} files={context?.previews ?? []} sites={context?.sites ?? []} request={request} /></> : <>
          {(git?.isRepo || !!context?.previews.length || !!context?.sites.length) && <div className="right-panel__body k-stack">
            {git?.isRepo && <Button variant="ghost" icon={<FileDiff size={14} aria-hidden />} onClick={() => state.select('diff')}>Source control <Badge>{git.changedFiles?.length ?? 0} changed</Badge></Button>}
            {(!!context?.previews.length || !!context?.sites.length) && <Button variant="ghost" icon={<Globe size={14} aria-hidden />} onClick={() => state.select('preview')}>Preview artifacts</Button>}
          </div>}
          <PanelFiles attachedCount={attachedCount} attached={attached} onAttach={onAttach} attachDisabled={attachDisabled} key={base} base={base} files={files} workspace={context?.workspace?.name} loading={loading} request={request} />
        </>}
      </TabPanel>
      <TabPanel value="computer">{context?.computer && <div className="right-panel__computer"><ComputerViewer agent={context.computer} name={name} request={request} /></div>}</TabPanel>
      {extensions.map(extension => <TabPanel key={extension.value} value={extension.value}>{extension.content}</TabPanel>)}
    </Tabs>
  </aside>;
  return <div ref={setHost} className="right-panel-slot" style={{ width: overlay ? 0 : `${state.panel.width}px` }}>
    <div ref={root} className="right-panel-poll" />
    {createPortal(content, mount)}
    {overlay ? <Sheet.Root open onOpenChange={open => { if (!open) onClose(); }}><Sheet.Portal>
      <Sheet.Overlay className="right-panel-backdrop" />
      <Sheet.Content className="right-panel-sheet" aria-describedby={undefined} onPointerDownOutside={event => { if (inside.current.has(event.detail.originalEvent)) event.preventDefault(); }} onKeyDownCapture={event => { if ((event.target as HTMLElement).closest('[role="dialog"]') !== event.currentTarget) return; if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'b') { event.preventDefault(); onClose(); } }} onCloseAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLButtonElement>('[aria-label="Show details"]')?.focus(); }}>
        <Sheet.Title className="sr-only">Conversation panel</Sheet.Title><div ref={place} className="right-panel-mount" />
      </Sheet.Content>
    </Sheet.Portal></Sheet.Root> : <div ref={place} className="right-panel-mount" />}
  </div>;
}
