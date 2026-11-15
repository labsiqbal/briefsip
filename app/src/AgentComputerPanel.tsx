import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Dialog, Tooltip } from './ui/kit';
import { Expand, Monitor } from 'lucide-react';
import { useBrowserView } from './AgentBrowserViewer';
import { useComputerView } from './computer-view';
import { ComputerViewer } from './ComputerViewer';
import type { DesktopStatus } from '../agent-desktop';
import type { ComputerControl, ComputerWait } from '../agent-computer';
export type ComputerStatus = DesktopStatus & { enabled: boolean; revision: number; control: ComputerControl; requests: ComputerWait[] };
export type ComputerRequest = <T>(path: string, body?: unknown) => Promise<T>;
export function AgentComputerPanel({ agent, name, request, onSettings }: { agent: string; name: string; request: ComputerRequest; onSettings?: () => void }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ComputerStatus | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [frame, setFrame] = useState('');
  const running = !!status && ['running','idle'].includes(status.state);
  const browser = useBrowserView(agent, request, running && !open, 5000);
  const { view } = useComputerView(agent, !!browser.status?.tabs.length);
  const root = browser.root, locked = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let mounted = true, visible = true, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const observer = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? false; });
    if (root.current) observer.observe(root.current);
    async function refresh() {
      try {
        if (visible && !document.hidden && !open && !locked.current) {
          const next = await request<ComputerStatus>(`/api/agents/${agent}/computer`);
          if (!mounted || locked.current) return; setStatus(next);
          if (next.enabled && ['running','idle'].includes(next.state) && view === 'desktop') {
            const response = await fetch(`/api/agents/${agent}/computer/screenshot`, { signal: controller.signal });
            if (!response.ok) throw new Error('Screen not updated. Check computer status.');
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (!mounted || locked.current) return;
            let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
            setFrame(`data:image/jpeg;base64,${btoa(binary)}`);
          } else setFrame('');
          setError('');
        }
      } catch (error) { if (mounted && !locked.current) setError(error instanceof Error ? error.message : 'Computer status unavailable.'); }
      finally { if (mounted) timer = setTimeout(() => void refresh(), 5000); }
    }
    void refresh();
    return () => { mounted = false; controller.abort(); clearTimeout(timer); observer.disconnect(); };
  }, [agent, request, open, view]);
  async function start() {
    if (locked.current) return; locked.current = true; setBusy(true); setError('');
    setStatus(current => current && { ...current, state: 'starting' });
    try { const next = await request<ComputerStatus>(`/api/agents/${agent}/computer/start`, {}); if (active.current) setStatus(next); }
    catch (error) { if (active.current) setError(error instanceof Error ? error.message : 'Computer state not confirmed. Check status before retrying.'); }
    finally { locked.current = false; if (active.current) setBusy(false); }
  }
  const state = status?.state ?? 'off';
  const label = error ? 'Unavailable' : running && status?.requests.length ? 'Waiting for you' : status === null ? 'Loading...' : !status.available ? 'Unavailable' : !status.enabled ? 'Disabled' : state === 'starting' ? 'Starting' : state === 'running' ? 'Live' : state === 'idle' ? 'Idle' : 'Off';
  const pill = <Badge tone={label === 'Live' || label === 'Idle' ? 'success' : label === 'Starting' ? 'warn' : 'neutral'}>{label}</Badge>;
  const page = browser.status?.tabs.find(tab => tab.id === browser.status?.activeTab);
  let host = ''; try { host = page ? new URL(page.url).host : ''; } catch { /* Internal Chrome pages have no host. */ }
  const thumbnail = view === 'browser' ? browser.frame : frame;
  return <div ref={root} className="bs-root k-stack computer-hero"><section aria-label="Computer">
    {!status ? <p className="computer-card-note" role="status">Loading computer...</p> : !status.available ? <p className="computer-card-note">Computer unavailable on this server.</p> : !status.enabled ? <div className="computer-compact-row"><Monitor size={16} aria-hidden /><span className="computer-compact-info">Computer</span><Badge>Disabled</Badge>{onSettings && <Button size="sm" variant="ghost" onClick={onSettings}>Settings</Button>}</div> : <div className="computer-compact-row">
      {running && (thumbnail ? <img src={thumbnail} alt={view === 'browser' ? 'Agent browser page' : 'Agent computer screen'} className="computer-compact-thumb" /> : <span className="computer-compact-placeholder"><Monitor size={16} aria-hidden /></span>)}
      {!running && <Monitor size={16} aria-hidden />}
      <div className="computer-compact-info">{running ? <Tooltip content={[page?.title, host].filter(Boolean).join(' · ') || (view === 'browser' ? 'Browser' : 'Desktop')}><strong tabIndex={0}>{page?.title || (view === 'browser' ? 'Browser' : 'Desktop')}</strong></Tooltip> : <span>Computer</span>}</div>{pill}
      {running ? <Button size="sm" variant="ghost" icon={<Expand size={14} aria-hidden />} onClick={() => setOpen(true)}>Open</Button> : <Button size="sm" variant="ghost" busy={busy || state === 'starting'} disabled={busy || state === 'starting'} onClick={() => void start()}>Start computer</Button>}
    </div>}
    {error && <Alert tone="error">{error}</Alert>}
  </section><Dialog open={open} onOpenChange={setOpen} title={`${name}'s computer`} size="lg" hideHeader><ComputerViewer agent={agent} name={name} request={request} onClose={() => setOpen(false)} /></Dialog></div>;
}
