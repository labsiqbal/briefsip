import { readProductStorage, removeProductStorage } from './rename-storage.ts';
import { useEffect, useRef, useState } from 'react';
import { visibilityCommand } from '../shared/agent-visibility';
import { Alert, Badge, Button, Card, Row, useConfirm, RecoveryAlert } from './ui/kit';

export function AgentVisibility({ agent, request, onChanged }: { agent: { id: string; name: string; hidden?: boolean; visibility_revision?: number }; request: <T>(path: string, body?: unknown) => Promise<T>; onChanged: () => Promise<void> }) {
  const key = `minarbot-visibility:${agent.id}`;
  const [recovery, setRecovery] = useState(() => {
    try { const raw = readProductStorage(sessionStorage, key); return { pending: raw ? visibilityCommand(JSON.parse(raw)) : null, invalid: false }; }
    catch { return { pending: null, invalid: true }; }
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const flight = useRef(false), mounted = useRef(true), confirm = useConfirm();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function save() {
    if (flight.current || recovery.invalid) return;
    if (!recovery.pending && !await confirm(agent.hidden ? { title: `Restore ${agent.name}?`, description: 'The held queue will resume. Missed schedules will not run again.', confirm: 'Restore agent' } : { title: `Hide ${agent.name}?`, description: 'Running work can finish. The queue is held and new messages are rejected until the agent is restored.', confirm: 'Hide agent', danger: true })) return;
    const command = recovery.pending ?? { id: crypto.randomUUID(), revision: agent.visibility_revision ?? 0, hidden: !agent.hidden };
    try { sessionStorage.setItem(key, JSON.stringify(command)); } catch { setError('Status could not be saved in the browser. Check site storage before trying again.'); return; }
    flight.current = true; setBusy(true); setError(''); setRecovery({ pending: command, invalid: false });
    try {
      await request(`/api/agents/${agent.id}/visibility`, command);
      if (!mounted.current) return;
      await onChanged();
      if (!mounted.current) return;
      if (readProductStorage(sessionStorage, key) === JSON.stringify(command)) removeProductStorage(sessionStorage, key); setRecovery({ pending: null, invalid: false });
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Changes are not confirmed yet. Try again.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  async function reload() {
    if (flight.current || !await confirm({ title: 'Discard the saved request and load the latest status?', description: 'Changes already accepted by the server still apply.', confirm: 'Discard and reload', danger: true })) return;
    flight.current = true; setBusy(true);
    try { const stored = readProductStorage(sessionStorage, key); await onChanged(); if (!mounted.current) return; if (readProductStorage(sessionStorage, key) === stored) removeProductStorage(sessionStorage, key); if (mounted.current) { setRecovery({ pending: null, invalid: false }); setError(''); } }
    catch { if (mounted.current) setError('Latest status has not loaded. Try reloading again.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  return <div className="k-stack bs-root">
      <Card><Row title={<Badge>{agent.hidden ? 'Hidden · queue paused' : 'Available'}</Badge>} trailing={<Button size="sm" busy={busy} disabled={busy || recovery.invalid} onClick={() => void save()}>{busy ? 'Saving...' : recovery.pending ? 'Try again' : agent.hidden ? 'Restore agent' : 'Hide agent'}</Button>} /></Card>
      {recovery.pending && <RecoveryAlert inFlight={busy} tone="warn" title="Not confirmed" actions={<Button size="sm" onClick={() => void reload()}>Discard and reload</Button>} />}
      {recovery.invalid && <Alert tone="error" actions={<Button size="sm" onClick={() => void reload()}>Discard and reload</Button>}>Saved request is invalid. Load the latest status before continuing.</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
  </div>;
}
