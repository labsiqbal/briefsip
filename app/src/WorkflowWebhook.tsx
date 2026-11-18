import { useEffect, useRef, useState } from 'react';
import type { WorkflowCommand } from './workflow-command';
import { ActionMenu, Alert, Badge, Button, Card, Checkbox, EmptyState, Field, IconButton, Input, Row, Section, SkeletonRows, useConfirm } from './ui/kit';
import { Ellipsis, RefreshCw } from 'lucide-react';

export type WorkflowHook = { route: string | null; url?: string; revision: number; enabled: number; secret?: string };
type Receipt = { route: string; delivery: string; received: number; result: { outcome: string; reason?: string; id?: string } };
// ponytail: kit Checkbox has no form name; mirror checked state until it supports native submission.
function FormCheckbox({ name, label, defaultChecked, disabled }: { name: string; label: string; defaultChecked: boolean; disabled: boolean }) {
  const [checked, setChecked] = useState(defaultChecked);
  return <><Checkbox checked={checked} onChange={setChecked} label={label} disabled={disabled} />{checked && <input type="hidden" name={name} value="on" disabled={disabled} />}</>;
}

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
  const confirm = useConfirm();
  const snapshot = pending?.body, hook = state?.hook;
  return <Section title="Workflow webhook" actions={<IconButton label="Reload webhook" disabled={locked} onClick={async () => { if (!state || await confirm({ title: 'Reload webhook?', description: 'Reload the webhook and discard unsaved form changes?', confirm: 'Reload', danger: true })) { setState(null); setReload(value => value + 1); } }}><RefreshCw size={15} aria-hidden /></IconButton>}><Alert>Send signed events to run the workflow. Events received while the workflow is still active are skipped and will not run again.</Alert>
    {error && <Alert tone="error">{error}</Alert>}
    {!state ? !error && <><span className="sr-only" role="status">Loading webhook...</span><SkeletonRows /></> : <form className="k-fieldset" key={`${hook?.revision ?? 0}:${refresh}:${reload}`} onSubmit={event => {
      event.preventDefault(); if (locked || conflict) return;
      const form = new FormData(event.currentTarget);
      void onSave({ id: crypto.randomUUID(), revision: hook?.revision ?? 0, enabled: form.get('enabled') === 'on', rotate: !hook?.route || form.get('rotate') === 'on' });
    }}>
      {hook?.route && <Field label="Workflow webhook URL"><Input readOnly value={hook.url} onFocus={event => event.currentTarget.select()} /></Field>}
      {secret && <Field label="Workflow webhook secret" hint="Save this secret. It will not be shown again after you leave or reload the page."><Input readOnly type="password" value={secret} onFocus={event => event.currentTarget.select()} /></Field>}
      <FormCheckbox name="enabled" label="Workflow webhook active" disabled={locked || conflict} defaultChecked={snapshot ? Boolean(snapshot.enabled) : !!hook?.enabled} />
      {hook?.route && <FormCheckbox name="rotate" label="Replace secret. Senders must use the new secret." disabled={locked || conflict} defaultChecked={Boolean(snapshot?.rotate)} />}
      {conflict && <Alert tone="warn">Webhook has changed. Reload settings before saving again.</Alert>}
      <div className="k-inline"><Button type="submit" disabled={locked || conflict}>Save workflow webhook</Button>
      {hook?.route && <ActionMenu label="Webhook actions" trigger={<IconButton label="Webhook actions"><Ellipsis size={16} aria-hidden /></IconButton>} items={[{ label: 'Delete webhook trigger', danger: true, disabled: locked || conflict, onSelect: async () => {
        if (await confirm({ title: 'Delete webhook trigger?', description: 'The old URL and secret will no longer work. Runs already started and history remain saved.', confirm: 'Delete trigger', danger: true })) void onSave({ id: crypto.randomUUID(), revision: hook.revision, remove: true, route: hook.route });
      } }]} />}</div>
    </form>}
    {state && <Section title="Recent webhook events">{!state.receipts.length ? <EmptyState title="No webhook events yet" /> : <Card>{state.receipts.map(row => <Row key={`${row.route}:${row.delivery}`} title={row.delivery} meta={<><span>{new Date(row.received).toLocaleString('en-US')}</span><Badge tone={row.result.outcome === 'queued' ? 'neutral' : 'warn'}>{row.result.outcome === 'queued' ? 'Run created' : row.result.reason === 'busy' ? 'Skipped: workflow still active' : 'Skipped: webhook inactive'}</Badge></>} trailing={row.result.id && <Button size="sm" onClick={() => onRun(row.result.id!)}>Open result</Button>} />)}</Card>}</Section>}
  </Section>;
}
