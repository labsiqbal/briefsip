import { useEffect, useState } from 'react';
import type { WorkflowCommand } from '../workflow-command';

type Schedule = { revision: number; next_at: number; interval_ms: number | null; input: string; enabled: number };
type State = { schedule: Schedule | null; occurrences: { scheduled_at: number; run: string | null; missed: number; reason: string | null }[] };
export function WorkflowSchedule({ workflow, request, pending, locked, refresh, onSave, onRun, conflict, onLoaded }: {
  workflow: string; request: <T>(path: string, data?: unknown) => Promise<T>; pending?: WorkflowCommand;
  locked: boolean; refresh: number; onSave: (body: Record<string, unknown>) => Promise<void>; onRun: (id: string) => void; conflict: boolean; onLoaded: () => void;
}) {
  const [state, setState] = useState<State | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => {
    let stopped = false; setState(null); setError('');
    void request<State>(`/api/workflows/${workflow}/schedule`).then(data => { if (!stopped) { setState(data); onLoaded(); } }).catch(error => { if (!stopped) setError(error.message); });
    return () => { stopped = true; };
  }, [workflow, refresh, reload]);
  const snapshot = pending?.body, saved = state?.schedule;
  const date = new Date(Number(snapshot?.nextAt ?? saved?.next_at ?? Date.now() + 60000));
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  return <section><h2>Workflow schedule</h2><p>Schedules use this device time. Missed occurrences are combined into one run; if the workflow is still active, the occurrence is skipped.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <button className="secondary" disabled={locked} onClick={() => { if (!state || window.confirm('Reload the schedule and discard unsaved form changes?')) setReload(value => value + 1); }}>Reload schedule</button>
    {!state ? !error && <p role="status">Loading schedule...</p> : <form key={`${refresh}:${reload}`} onSubmit={async event => {
      event.preventDefault(); if (locked || conflict) return;
      const form = new FormData(event.currentTarget), interval = String(form.get('interval') ?? '');
      const body = { id: crypto.randomUUID(), revision: saved?.revision ?? 0, nextAt: new Date(String(form.get('nextAt'))).getTime(), intervalSeconds: interval ? Number(interval) * 60 : null, input: String(form.get('input') ?? ''), enabled: form.get('enabled') === 'on' };
      await onSave(body);
    }}>
      <label>Workflow start time<input name="nextAt" type="datetime-local" step={1} required defaultValue={localDate} readOnly={locked || conflict} /></label>
      <label>Repeat workflow every (minutes)<input name="interval" type="number" min={1} max={525600} step={1} defaultValue={snapshot ? snapshot.intervalSeconds === null ? '' : Number(snapshot.intervalSeconds) / 60 : saved?.interval_ms ? saved.interval_ms / 60000 : ''} readOnly={locked || conflict} /><span className="muted">Leave empty to run once.</span></label>
      <label>Scheduled input<textarea name="input" maxLength={16000} defaultValue={String(snapshot?.input ?? saved?.input ?? '')} readOnly={locked || conflict} /></label>
      <label className="member-option"><input name="enabled" type="checkbox" defaultChecked={snapshot ? Boolean(snapshot.enabled) : !!saved?.enabled} disabled={locked || conflict} /> Workflow schedule active</label>
      {conflict && <p role="alert">Schedule has changed. The draft remains visible; reload the schedule before saving again.</p>}
      <button disabled={locked || conflict}>Save workflow schedule</button>
    </form>}
    {state && <><h3>Recent schedule occurrences</h3>{!state.occurrences.length ? <p>No schedule occurrences yet.</p> : <ul className="routine-list">{state.occurrences.map(item => <li key={item.scheduled_at}><p>{new Date(item.scheduled_at).toLocaleString('en-US')} · {item.reason === 'hidden' ? 'Skipped: agent hidden' : item.reason === 'busy' ? 'Skipped: workflow still active' : 'Run created'}{item.missed > 0 ? ` · ${item.missed} missed intervals` : ''}</p>{item.run && <button className="secondary" onClick={() => onRun(item.run!)}>Open scheduled result</button>}</li>)}</ul>}</>}
  </section>;
}
