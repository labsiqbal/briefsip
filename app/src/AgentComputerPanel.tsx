import { useEffect, useId, useRef, useState } from 'react';
import { Alert, Badge, Button, Dialog, Section } from './ui/kit';
import { Expand } from 'lucide-react';
import { ComputerViewer } from './ComputerViewer';
import type { DesktopStatus } from '../agent-desktop';
import type { ComputerControl, ComputerWait } from '../agent-computer';
export type ComputerStatus = DesktopStatus & { enabled: boolean; revision: number; control: ComputerControl; requests: ComputerWait[] };
export type ComputerRequest = <T>(path: string, body?: unknown) => Promise<T>;
export function AgentComputerPanel({ agent, name, request, compact = false }: { agent: string; name: string; request: ComputerRequest; compact?: boolean }) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ComputerStatus | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [frame, setFrame] = useState('');
  const root = useRef<HTMLDivElement>(null), locked = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let mounted = true, visible = true, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const observer = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? false; });
    if (root.current) observer.observe(root.current);
    async function refresh() {
      try {
        if (visible && !document.hidden && !locked.current) {
          const next = await request<ComputerStatus>(`/api/agents/${agent}/computer`);
          if (!mounted || locked.current) return; setStatus(next);
          if (next.enabled && ['running','idle'].includes(next.state)) {
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
      finally { if (mounted) timer = setTimeout(() => void refresh(), 1000); }
    }
    void refresh();
    return () => { mounted = false; controller.abort(); clearTimeout(timer); observer.disconnect(); };
  }, [agent, request]);
  async function control(operation: 'start' | 'stop') {
    if (locked.current) return; locked.current = true; setBusy(true); setError('');
    if (operation === 'start') setStatus(current => current && { ...current, state: 'starting' });
    try { const next = await request<ComputerStatus>(`/api/agents/${agent}/computer/${operation}`, {}); if (active.current) setStatus(next); }
    catch (error) { if (active.current) setError(error instanceof Error ? error.message : 'Computer state not confirmed. Check status before retrying.'); }
    finally { locked.current = false; if (active.current) setBusy(false); }
  }
  const state = status?.state ?? 'off';
  const controls = <>
    <p className="k-field__hint">{status?.control.mode === 'user' ? 'You are in control' : 'Agent in control'}{status?.stopsInMs != null ? ` · Stops in ${Math.max(1, Math.ceil(status.stopsInMs / 60000))} min` : ''}</p>
    {status && !status.available && <p className="k-field__hint">Computer is disabled on this server.</p>}
    {status?.available && !status.enabled && <p className="k-field__hint">Enable Computer in agent settings.</p>}
    {error && <Alert tone="error">{error}</Alert>}
    <div className="k-inline">{!compact && <Button size="sm" disabled={!status?.available || !status.enabled || busy || state !== 'off'} busy={busy && state === 'starting'} onClick={() => void control('start')}>Start computer</Button>}<Button size="sm" disabled={!status || busy || state === 'off'} onClick={() => void control('stop')}>Stop computer</Button></div>
  </>;
  return <div ref={root} className={`bs-root k-stack${compact ? ' computer-hero' : ''}`}><Section id={titleId} title="Computer" actions={<><Badge>{error ? 'Unavailable' : status?.requests.length ? 'Waiting for you' : status === null ? 'Loading...' : !status.available ? 'Unavailable' : !status.enabled ? 'Disabled' : state === 'starting' ? 'Starting' : state === 'running' ? 'Running' : state === 'idle' ? 'Idle' : 'Off'}</Badge><Button size="sm" icon={<Expand size={14} aria-hidden />} onClick={() => setOpen(true)}>Open</Button></>}>
    {!compact && <>{frame && ['running','idle'].includes(state) && <img src={frame} width={960} height={600} alt="Agent computer screen" style={{ display: 'block', width: '100%', height: 'auto', borderRadius: 'var(--radius-md)' }} />}{controls}</>}
  </Section><Dialog open={open} onOpenChange={setOpen} title={`${name}'s computer`} size="lg">{compact && <div className="k-stack">{controls}</div>}<ComputerViewer agent={agent} name={name} request={request} /></Dialog></div>;
}
