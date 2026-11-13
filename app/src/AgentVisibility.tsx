import { useEffect, useRef, useState } from 'react';
import { visibilityCommand } from '../agent-visibility';

export function AgentVisibility({ agent, request, onChanged }: { agent: { id: string; hidden?: boolean; visibility_revision?: number }; request: <T>(path: string, body?: unknown) => Promise<T>; onChanged: () => Promise<void> }) {
  const key = `briefsip-visibility:${agent.id}`;
  const [recovery, setRecovery] = useState(() => {
    try { const raw = sessionStorage.getItem(key); return { pending: raw ? visibilityCommand(JSON.parse(raw)) : null, invalid: false }; }
    catch { return { pending: null, invalid: true }; }
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const flight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function save() {
    if (flight.current || recovery.invalid) return;
    if (!recovery.pending && !window.confirm(agent.hidden ? 'Restore agent? The held queue will resume. Missed schedules will not run again.' : 'Hide agent? Running work can finish. The queue is held and new messages are rejected until the agent is restored.')) return;
    const command = recovery.pending ?? { id: crypto.randomUUID(), revision: agent.visibility_revision ?? 0, hidden: !agent.hidden };
    try { sessionStorage.setItem(key, JSON.stringify(command)); } catch { setError('Status could not be saved in the browser. Check site storage before trying again.'); return; }
    flight.current = true; setBusy(true); setError(''); setRecovery({ pending: command, invalid: false });
    try {
      await request(`/api/agents/${agent.id}/visibility`, command);
      if (!mounted.current) return;
      await onChanged();
      if (!mounted.current) return;
      if (sessionStorage.getItem(key) === JSON.stringify(command)) sessionStorage.removeItem(key); setRecovery({ pending: null, invalid: false });
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Changes are not confirmed yet. Try again.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  async function reload() {
    if (flight.current || !window.confirm('Discard the saved request and load the latest status? Changes already accepted by the server still apply.')) return;
    flight.current = true; setBusy(true);
    try { const stored = sessionStorage.getItem(key); await onChanged(); if (!mounted.current) return; if (sessionStorage.getItem(key) === stored) sessionStorage.removeItem(key); if (mounted.current) { setRecovery({ pending: null, invalid: false }); setError(''); } }
    catch { if (mounted.current) setError('Latest status has not loaded. Try reloading again.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  return <section aria-label="Agent visibility"><h2>{agent.hidden ? 'Agent hidden' : 'Agent visibility'}</h2><p>History, files, memory, and sidebar sections remain saved.</p>
    {recovery.pending && <p role="status">Changes are not confirmed yet. Retry with the same request.</p>}
    {recovery.invalid && <p role="alert" className="error">Saved request is invalid. Load the latest status before continuing.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="form-actions"><button type="button" className="secondary" disabled={busy || recovery.invalid} onClick={() => void save()}>{busy ? 'Saving...' : recovery.pending ? 'Retry change' : agent.hidden ? 'Restore agent' : 'Hide agent'}</button><button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>Load latest status</button></div>
  </section>;
}
