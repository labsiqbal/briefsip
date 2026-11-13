import { useEffect, useRef, useState } from 'react';
import type { WorkflowCommand } from '../workflow-command';

export type WorkflowHook = { route: string | null; url?: string; revision: number; enabled: number; secret?: string };
type Receipt = { route: string; delivery: string; received: number; result: { outcome: string; reason?: string; id?: string } };
export function WorkflowWebhook({ workflow, request, pending, locked, busy, refresh, secret, conflict, onLoaded, onSave, onRun }: {
  workflow: string; request: <T>(path: string, data?: unknown) => Promise<T>; pending?: WorkflowCommand;
  locked: boolean; busy: boolean; refresh: number; secret?: string; conflict: boolean; onLoaded: () => void;
  onSave: (body: Record<string, unknown>) => Promise<void>; onRun: (id: string) => void;
}) {
  const [state, setState] = useState<{ hook: WorkflowHook | null; receipts: Receipt[] } | null>(null);
  const [error, setError] = useState(''), [reload, setReload] = useState(0);
  const loaded = useRef('');
  useEffect(() => {
    const version = `${refresh}:${reload}`;
    if (busy || (state && loaded.current === version)) return;
    let stopped = false; setError('');
    void Promise.all([request<WorkflowHook | null>(`/api/workflows/${workflow}/webhook`), request<Receipt[]>(`/api/workflows/${workflow}/webhook-events`)]).then(([hook, receipts]) => {
      if (!stopped) { loaded.current = version; setState({ hook, receipts }); if (!state) onLoaded(); }
    }).catch(error => { if (!stopped) setError(error.message); });
    return () => { stopped = true; };
  }, [workflow, refresh, reload, busy]);
  const snapshot = pending?.body, hook = state?.hook;
  return <section><h2>Workflow webhook</h2><p>Send signed events to run the workflow. Events received while the workflow is still active are skipped and will not run again.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <button className="secondary" disabled={locked} onClick={() => { if (!state || window.confirm('Reload the webhook and discard unsaved form changes?')) { setState(null); setReload(value => value + 1); } }}>Reload webhook</button>
    {!state ? !error && <p role="status">Loading webhook...</p> : <form key={`${hook?.revision ?? 0}:${refresh}:${reload}`} onSubmit={event => {
      event.preventDefault(); if (locked || conflict) return;
      const form = new FormData(event.currentTarget);
      void onSave({ id: crypto.randomUUID(), revision: hook?.revision ?? 0, enabled: form.get('enabled') === 'on', rotate: !hook?.route || form.get('rotate') === 'on' });
    }}>
      {hook?.route && <label>Workflow webhook URL<input readOnly value={hook.url} onFocus={event => event.currentTarget.select()} /></label>}
      {secret && <label>Workflow webhook secret<input readOnly type="password" value={secret} onFocus={event => event.currentTarget.select()} /><span className="muted">Save this secret. It will not be shown again after you leave or reload the page.</span></label>}
      <label className="member-option"><input name="enabled" type="checkbox" disabled={locked || conflict} defaultChecked={snapshot ? Boolean(snapshot.enabled) : !!hook?.enabled} /> Workflow webhook active</label>
      {hook?.route && <label className="member-option"><input name="rotate" type="checkbox" disabled={locked || conflict} defaultChecked={Boolean(snapshot?.rotate)} /> Replace secret. Senders must use the new secret.</label>}
      {conflict && <p role="alert">Webhook has changed. Reload settings before saving again.</p>}
      <button disabled={locked || conflict}>Save workflow webhook</button>
      {hook?.route && <button type="button" className="secondary" disabled={locked || conflict} onClick={() => {
        if (window.confirm('Delete the webhook trigger? The old URL and secret will no longer work. Runs already started and history remain saved.')) void onSave({ id: crypto.randomUUID(), revision: hook.revision, remove: true, route: hook.route });
      }}>Delete webhook trigger</button>}
    </form>}
    {state && <><h3>Recent webhook events</h3>{!state.receipts.length ? <p>No webhook events yet.</p> : <ul className="routine-list">{state.receipts.map(row => <li key={`${row.route}:${row.delivery}`}><p>{row.delivery} · {new Date(row.received).toLocaleString('en-US')} · {row.result.outcome === 'queued' ? 'Run created' : row.result.reason === 'busy' ? 'Skipped: workflow still active' : 'Skipped: webhook inactive'}</p>{row.result.id && <button className="secondary" onClick={() => onRun(row.result.id!)}>Open webhook result</button>}</li>)}</ul>}</>}
  </section>;
}
