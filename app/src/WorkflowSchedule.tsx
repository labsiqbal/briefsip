import { useEffect, useState } from 'react';
import type { WorkflowCommand } from '../workflow-command';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, Field, IconButton, Input, Row, Section, SkeletonRows, Textarea, useConfirm } from './ui/kit';
import { RefreshCw } from 'lucide-react';

type Schedule = { revision: number; next_at: number; interval_ms: number | null; input: string; enabled: number };
type State = { schedule: Schedule | null; occurrences: { scheduled_at: number; run: string | null; missed: number; reason: string | null }[] };
// ponytail: kit Checkbox has no form name; mirror checked state until it supports native submission.
function FormCheckbox({ name, label, defaultChecked, disabled }: { name: string; label: string; defaultChecked: boolean; disabled: boolean }) {
  const [checked, setChecked] = useState(defaultChecked);
  return <><Checkbox checked={checked} onChange={setChecked} label={label} disabled={disabled} />{checked && <input type="hidden" name={name} value="on" disabled={disabled} />}</>;
}

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
  const confirm = useConfirm();
  const snapshot = pending?.body, saved = state?.schedule;
  const date = new Date(Number(snapshot?.nextAt ?? saved?.next_at ?? Date.now() + 60000));
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  return <Section title="Workflow schedule" actions={<IconButton label="Reload schedule" disabled={locked} onClick={async () => { if (!state || await confirm({ title: 'Reload schedule?', description: 'Reload the schedule and discard unsaved form changes?', confirm: 'Reload', danger: true })) setReload(value => value + 1); }}><RefreshCw size={15} aria-hidden /></IconButton>}><Alert>Schedules use this device time. Missed occurrences are combined into one run; if the workflow is still active, the occurrence is skipped.</Alert>
    {error && <Alert tone="error">{error}</Alert>}
    {!state ? !error && <><span className="sr-only" role="status">Loading schedule...</span><SkeletonRows /></> : <form className="k-fieldset" key={`${refresh}:${reload}`} onSubmit={async event => {
      event.preventDefault(); if (locked || conflict) return;
      const form = new FormData(event.currentTarget), interval = String(form.get('interval') ?? '');
      const body = { id: crypto.randomUUID(), revision: saved?.revision ?? 0, nextAt: new Date(String(form.get('nextAt'))).getTime(), intervalSeconds: interval ? Number(interval) * 60 : null, input: String(form.get('input') ?? ''), enabled: form.get('enabled') === 'on' };
      await onSave(body);
    }}>
      <Field label="Workflow start time"><Input name="nextAt" type="datetime-local" step={1} required defaultValue={localDate} readOnly={locked || conflict} /></Field>
      <Field label="Repeat workflow every (minutes)" hint="Leave empty to run once."><Input name="interval" type="number" min={1} max={525600} step={1} defaultValue={snapshot ? snapshot.intervalSeconds === null ? '' : Number(snapshot.intervalSeconds) / 60 : saved?.interval_ms ? saved.interval_ms / 60000 : ''} readOnly={locked || conflict} /></Field>
      <Field label="Scheduled input"><Textarea name="input" maxLength={16000} defaultValue={String(snapshot?.input ?? saved?.input ?? '')} readOnly={locked || conflict} /></Field>
      <FormCheckbox name="enabled" label="Workflow schedule active" defaultChecked={snapshot ? Boolean(snapshot.enabled) : !!saved?.enabled} disabled={locked || conflict} />
      {conflict && <Alert tone="warn">Schedule has changed. The draft remains visible; reload the schedule before saving again.</Alert>}
      <div className="k-inline"><Button type="submit" disabled={locked || conflict}>Save workflow schedule</Button></div>
    </form>}
    {state && <Section title="Recent schedule occurrences">{!state.occurrences.length ? <EmptyState title="No schedule occurrences yet" /> : <Card>{state.occurrences.map(item => <Row key={item.scheduled_at} title={new Date(item.scheduled_at).toLocaleString('en-US')} meta={<><Badge tone={item.reason === 'hidden' || item.reason === 'busy' ? 'warn' : 'neutral'}>{item.reason === 'hidden' ? 'Skipped: agent hidden' : item.reason === 'busy' ? 'Skipped: workflow still active' : 'Run created'}</Badge>{item.missed > 0 && <span>{item.missed} missed intervals</span>}</>} trailing={item.run && <Button size="sm" onClick={() => onRun(item.run!)}>Open result</Button>} />)}</Card>}</Section>}
  </Section>;
}
