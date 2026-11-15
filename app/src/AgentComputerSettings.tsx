import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Progress, Row, Section, Switch, useConfirm, RecoveryAlert } from './ui/kit';
import type { ComputerRequest, ComputerStatus } from './AgentComputerPanel';
type Command = { id: string; revision: number; enabled: boolean };
export function AgentComputerSettings({ agent, request, autoFocus = false }: { agent: string; request: ComputerRequest; autoFocus?: boolean }) {
  const section = useRef<HTMLDivElement>(null);
  const key = `briefsip-computer:${agent}`;
  const [status, setStatus] = useState<ComputerStatus | null>(null), [pending, setPending] = useState<Command | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [invalid, setInvalid] = useState(false);
  useEffect(() => { if (!autoFocus) return; const frame = requestAnimationFrame(() => { section.current?.scrollIntoView({ block: 'center' }); section.current?.querySelector<HTMLButtonElement>('[role="switch"]')?.focus(); }); return () => cancelAnimationFrame(frame); }, [autoFocus, status?.available]);
  const mounted = useRef(true), flight = useRef(false), confirm = useConfirm();
  useEffect(() => {
    mounted.current = true;
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) { const saved = JSON.parse(raw); if (!saved || typeof saved !== 'object' || Object.keys(saved).length !== 3 || typeof saved.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(saved.id) || !Number.isSafeInteger(saved.revision) || saved.revision < 0 || typeof saved.enabled !== 'boolean') throw new Error(); setPending(saved); }
    } catch { setInvalid(true); }
    void request<ComputerStatus>(`/api/agents/${agent}/computer`).then(value => { if (mounted.current) setStatus(value); }).catch(error => { if (mounted.current) setError(error instanceof Error ? error.message : 'Computer status unavailable.'); });
    return () => { mounted.current = false; };
  }, [agent, key, request]);
  async function save(enabled: boolean) {
    if (flight.current || !status || invalid) return;
    const command = pending ?? { id: crypto.randomUUID(), revision: status.revision, enabled };
    try { sessionStorage.setItem(key, JSON.stringify(command)); } catch { setError('Browser could not save recovery data. Check site storage.'); return; }
    flight.current = true; setPending(command); setBusy(true); setError('');
    try { const next = await request<ComputerStatus>(`/api/agents/${agent}/computer`, command); if (!mounted.current) return; sessionStorage.removeItem(key); setStatus(next); setPending(null); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Computer change is not confirmed. Retry same request.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  async function reload() {
    if (flight.current) return;
    if ((pending || invalid) && !await confirm({ title: 'Discard computer request?', description: 'Changes already accepted by the server still apply.', confirm: 'Discard and reload', danger: true })) return;
    flight.current = true; setBusy(true);
    try { const next = await request<ComputerStatus>(`/api/agents/${agent}/computer`); if (!mounted.current) return; sessionStorage.removeItem(key); setStatus(next); setPending(null); setInvalid(false); setError(''); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Status could not load.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  const target = pending?.enabled ?? status?.enabled ?? false;
  const action = target ? 'Turning on computer...' : 'Stopping computer...';
  return <div ref={section} className="bs-root k-stack"><Section title="Computer"><Card><Row title="Agent computer" meta={<>{status?.available ? null : 'Unavailable on this server.'}{busy && <Progress>{pending ? action : 'Loading computer status...'}</Progress>}</>} trailing={<Switch label="Computer" checked={target} disabled={!status?.available || busy || !!pending || invalid} onChange={value => void save(value)} />} /></Card>
    {pending && <RecoveryAlert inFlight={busy} progress={false} tone="warn" title="Couldn't confirm the change" actions={<><Button size="sm" variant="primary" onClick={() => void save(pending.enabled)}>Retry change</Button><Button size="sm" onClick={() => void reload()}>Load latest status</Button></>}>Retry to finish it, or load the latest status.</RecoveryAlert>}
    {invalid && <Alert tone="error" actions={<Button size="sm" disabled={busy} onClick={() => void reload()}>Load latest status</Button>}>Saved computer request is invalid. Load latest status before continuing.</Alert>}
    {error && !pending && !invalid && <Alert tone="error" actions={<Button size="sm" disabled={busy} onClick={() => void reload()}>Load latest status</Button>}>{error}</Alert>}
  </Section></div>;
}
