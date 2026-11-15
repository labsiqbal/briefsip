import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { restoreAgentCreation, type AgentCreation } from '../agent-create';
import { AvatarEditor } from './AgentAvatar';
import { AgentComputerSettings } from './AgentComputerSettings';
import { AgentVisibility } from './AgentVisibility';
import { Alert, Button, Collapsible, Combobox, Dialog, Field, Input, RecoveryAlert, Segmented, Select, Textarea, useConfirm, type SelectOption } from './ui/kit';

const panelLoadFailure = () => ({ default: () => <section className="empty"><h1>Panel could not be loaded</h1><p role="alert">Check your connection, then reload the app.</p><button onClick={() => window.location.reload()}>Reload app</button></section> });
const AgentTemplateExport = lazy(() => import('./AgentTemplateImport').then(module => ({ default: module.AgentTemplateExport })).catch(panelLoadFailure));
const SitesPanel = lazy(() => import('./SitesPanel').then(module => ({ default: module.SitesPanel })).catch(panelLoadFailure));
const message = (error: unknown) => error instanceof Error ? error.message : 'Connection failed. Try again.';

export type Agent = { workspace_connected?: boolean; runtime?: 'api' | 'codex' | 'claude'; computer_waiting?: boolean; avatar_revision?: number; hidden?: boolean; visibility_revision?: number; provider_account?: string; provider_available?: boolean; backup_model?: string; thread_limit: number; tool_budget?: number; revision: number; id: string; name: string; role: string; model: string; instructions: string };

export function AgentForm({ model, focusComputer = false, profile: liveProfile, onCreated, onCancel, onReload, onVisibilityChanged, request: api, isClientError }: { request: <T>(path: string, data?: unknown) => Promise<T>; isClientError: (error: unknown) => boolean; model: string; focusComputer?: boolean; profile?: Agent; onCreated: (agent: Agent) => void; onCancel: () => void; onReload?: () => Promise<void>; onVisibilityChanged?: () => Promise<void> }) {
  const confirm = useConfirm();
  const [look, setLook] = useState<import('./ui/avatar-shapes').AvatarLook | null>(null);
  const [LookPicker] = useState(() => lazy(() => import('./ui/avatar-shapes').then(module => ({ default: module.AvatarPicker }))));
  const [profile] = useState(liveProfile);
  const creationKey = 'briefsip-agent-creation';
  const nameInput = useRef<HTMLInputElement>(null);
  const [recovery, setRecovery] = useState(() => { try { return { command: liveProfile ? null : restoreAgentCreation(sessionStorage.getItem(creationKey)), invalid: false }; } catch { return { command: null, invalid: true }; } });
  const [invalid, setInvalid] = useState(recovery.invalid);
  const [setup, setSetup] = useState(recovery.command?.setup ?? false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const [runtime, setRuntime] = useState(profile?.runtime ?? 'api');
  const [runtimeChoices, setRuntimeChoices] = useState<{ runtime: 'codex' | 'claude'; enabled: boolean; version: string | null; reason: string | null }[]>([]);
  const [runtimeError, setRuntimeError] = useState('');
  useEffect(() => {
    if (!profile) return;
    let stopped = false;
    void api<{ choices: typeof runtimeChoices }>(`/api/agents/${profile.id}/runtimes`).then(data => { if (!stopped) setRuntimeChoices(data.choices); }).catch(error => { if (!stopped) setRuntimeError(message(error)); });
    return () => { stopped = true; };
  }, [profile]);
  const [account, setAccount] = useState(profile?.provider_account ?? recovery.command?.providerAccount ?? '');
  const [accounts, setAccounts] = useState<{ id: string; name: string; configured: boolean; defaultModel: string }[]>([]);
  const [accountError, setAccountError] = useState('');
  const [accountReload, setAccountReload] = useState(0);
  useEffect(() => {
    let stopped = false; setAccountError('');
    void api<typeof accounts>('/api/provider-accounts').then(items => { if (!stopped) setAccounts(items); }).catch(error => { if (!stopped) setAccountError(message(error)); });
    return () => { stopped = true; };
  }, [accountReload]);
  const [models, setModels] = useState<string[]>([]);
  const [catalogStatus, setCatalogStatus] = useState('Loading model list. Wait for suggestions or enter a model ID.');
  useEffect(() => {
    if (runtime !== 'api') { setModels([]); return; }
    let stopped = false;
    setModels([]); setCatalogStatus('Loading model list. Wait for suggestions or enter a model ID.');
    void api<{ models: string[] }>(`/api/models?account=${encodeURIComponent(account)}`).then(data => {
      if (!stopped) { setModels(data.models); setCatalogStatus(data.models.length ? `${data.models.length} models available. Select a suggestion or enter a model ID.` : 'Provider has not listed any models. Enter a model ID available in your account.'); }
    }).catch(error => { if (!stopped) setCatalogStatus(`${message(error)} Model ID can still be entered manually.`); });
    return () => { stopped = true; };
  }, [account, accountReload, runtime]);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [modelValue, setModelValue] = useState(profile?.model ?? recovery.command?.model ?? model);
  const [backupValue, setBackupValue] = useState(profile?.backup_model ?? recovery.command?.backupModel ?? '');
  const pending = useRef<(AgentCreation & { revision?: number }) | null>(recovery.command);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || invalid) return;
    const form = new FormData(event.currentTarget);
    const data = pending.current ?? { id: crypto.randomUUID(), ...(profile ? { revision: profile.revision } : setup ? { setup: true } : {}), providerAccount: account, name: String(form.get('name')).trim() || (setup ? 'New agent' : ''), role: String(form.get('role')).trim(), model: String(form.get('model')).trim(), backupModel: String(form.get('backupModel')).trim(), instructions: String(form.get('instructions')).trim(), threadLimit: Number(form.get('threadLimit')), toolBudget: Number(form.get('toolBudget')) };
    if (profile && runtime !== (profile.runtime ?? 'api') && !pending.current) {
      if (!await confirm({ title: 'Change agent runtime?', description: 'Future turns use the selected runtime and its host login. Existing history remains in Briefsip; the new runtime starts a fresh conversation. Workspace edits can persist after a turn stops.', confirm: 'Change runtime' })) return;
      Object.assign(data, { runtime, confirmRuntime: true });
    }
    setBusy(true); setError('');
    function clearRecovery() { if (!profile && restoreAgentCreation(sessionStorage.getItem(creationKey))?.id === data.id) sessionStorage.removeItem(creationKey); }
    try {
      if (!profile) { restoreAgentCreation(JSON.stringify(data)); sessionStorage.setItem(creationKey, JSON.stringify(data)); }
      pending.current = data;
      const created = await api<Agent>(profile ? `/api/agents/${profile.id}/edit` : '/api/agents', data);
      clearRecovery();
      if (!profile && look) {
        const { avatarPng, notifyAvatarFailure } = await import('./ui/avatar-shapes');
        try {
          const key = `briefsip-avatar:${created.id}`;
          const command = { id: crypto.randomUUID(), revision: created.avatar_revision ?? 0, image: await avatarPng(look) };
          sessionStorage.setItem(key, JSON.stringify(command));
          const result = await api<{ revision: number }>(`/api/agents/${created.id}/avatar`, command);
          created.avatar_revision = result.revision;
          sessionStorage.removeItem(key);
        } catch { notifyAvatarFailure(); }
      }
      if (active.current) onCreated(created);
    } catch (error) {
      if (isClientError(error)) { try { clearRecovery(); pending.current = null; } catch { /* Keep exact retry if recovery storage cannot be cleared. */ } }
      if (active.current) setError(message(error));
    } finally { if (active.current) setBusy(false); }

  }
  const locked = !!pending.current;
  const discardInvalid = async () => {
    if (!await confirm({ title: 'Discard recovery data?', description: 'The agent may already have been created; check the agent list before discarding it.', confirm: 'Discard', danger: true })) return;
    try { sessionStorage.removeItem(creationKey); setInvalid(false); nameInput.current?.focus(); } catch { setError('Recovery storage could not be cleared.'); }
  };
  const discardPending = async () => {
    if (!await confirm({ title: 'Discard this request?', description: 'The agent may already have been created; check the agent list before creating a new one.', confirm: 'Discard recovery', danger: true })) return;
    try { sessionStorage.removeItem(creationKey); pending.current = null; setRecovery({ command: null, invalid: false }); setError(''); nameInput.current?.focus(); } catch { setError('Recovery storage could not be cleared.'); }
  };
  const accountOptions: SelectOption[] = [
    ...(!accounts.some(item => item.id === '') ? [{ value: '', label: 'Server default' }] : []),
    ...(account && !accounts.some(item => item.id === account) ? [{ value: account, label: 'Account unavailable' }] : []),
    ...accounts.map(item => ({ value: item.id, label: item.name.slice(0, 40), hint: item.configured ? undefined : 'Not connected' })),
  ];
  const submitLabel = profile ? 'Save profile' : pending.current ? 'Retry creation' : setup ? 'Create and draft' : 'Create agent';
  return <Dialog open size={profile ? 'lg' : 'md'} onOpenChange={next => { if (!next && !busy) onCancel(); }}
    title={profile ? 'Edit agent profile' : 'New agent'}
    description={profile ? undefined : 'Name it, choose a model, then explain how it should work.'}
    footer={<>
      {!profile && pending.current && <Button variant="ghost" disabled={busy} onClick={() => void discardPending()} className="k-dialog__foot-start">Discard recovery</Button>}
      {profile && error && onReload && <Button variant="ghost" onClick={onReload} className="k-dialog__foot-start">Discard changes and reload</Button>}
      <Button disabled={busy} onClick={onCancel}>Cancel</Button>
      <Button type="submit" form="agent-form" variant="primary" busy={busy} disabled={invalid}>{busy ? 'Saving...' : submitLabel}</Button>
    </>}>
    {invalid && <Alert tone="error" title="Recovery data could not be read" actions={<Button size="sm" onClick={() => void discardInvalid()}>Discard recovery data</Button>}>Check the agent list before discarding it.</Alert>}
    {!profile && pending.current && <RecoveryAlert inFlight={busy} tone="warn" title="Creation is not confirmed yet">Try again with the same request to avoid creating a duplicate agent.</RecoveryAlert>}
    {profile && onVisibilityChanged && <div className="legacy k-legacy-block agent-form__avatar"><AvatarEditor agent={profile.id} request={api} onChanged={onVisibilityChanged} /></div>}
    <form id="agent-form" className="k-fieldset" onSubmit={create}>
      {!profile && <Suspense fallback={<p role="status">Loading avatar picker...</p>}><LookPicker value={look} onChange={setLook} disabled={busy || locked || invalid} /></Suspense>}
      {!profile && <Segmented label="How to create an agent" value={setup ? 'describe' : 'manual'} disabled={busy || locked || invalid} onChange={value => setSetup(value === 'describe')} options={[
        { value: 'manual', label: 'Fill in yourself', description: 'Enter the name and instructions.' },
        { value: 'describe', label: 'Draft from a description', description: 'The agent drafts its profile through chat.' },
      ]} />}
      <Field label={!profile && setup ? 'Temporary name' : 'Name'} optional={!profile && setup}>
        <Input ref={nameInput} name="name" required={!setup} maxLength={80} readOnly={locked} defaultValue={profile?.name ?? recovery.command?.name} placeholder="For example: Research partner" />
      </Field>
      <Field label="Role" optional hint="Shown under the agent's name, e.g. Orchestration agent">
        <Input name="role" maxLength={60} readOnly={locked} defaultValue={profile?.role ?? recovery.command?.role ?? ''} />
      </Field>
      <Field label="Runtime" hint={profile ? 'Coding runtimes use the host login and the current project folder. Direct chats need a host workspace binding. Steer restarts the running turn; image attachments are unavailable.' : 'Create the agent, add it to a project, then choose a coding runtime.'} error={runtimeError}>
        <Select label="Runtime" value={runtime} onChange={value => setRuntime(value as typeof runtime)} disabled={locked || busy} options={[{ value: 'api', label: 'API model' }, ...(['codex','claude'] as const).map(value => { const choice = runtimeChoices.find(item => item.runtime === value); return { value, label: value === 'codex' ? 'Codex' : 'Claude Code', disabled: !choice?.enabled, hint: choice?.reason ?? choice?.version ?? 'Add this agent to a project first.' }; })]} />
      </Field>
      <div className="k-grid-2">
        <Field label="Provider account" hint={accountError ? undefined : 'API keys stay on the server.'} error={accountError && <>{accountError} <button type="button" className="k-link" onClick={() => setAccountReload(value => value + 1)}>Reload</button></>}>
          <Select value={account} onChange={setAccount} disabled={locked || runtime !== 'api'} options={accountOptions} />
        </Field>
        <Field label="Model" hint={runtime === 'api' ? catalogStatus : 'Saved API model. Coding runtimes use their host default model.'}>
          <Combobox name="model" value={modelValue} onChange={setModelValue} suggestions={models} required maxLength={160} readOnly={locked || runtime !== 'api'} placeholder="Model ID from provider" />
        </Field>
      </div>
      <Field label={!profile && setup ? 'Needs description' : 'Instructions'} hint={!profile && setup ? 'Uses the selected provider. The agent and drafting task are created together; results or questions appear in chat.' : undefined}>
        <Textarea name="instructions" required maxLength={8000} readOnly={locked} defaultValue={profile?.instructions ?? recovery.command?.instructions} rows={5} placeholder={!profile && setup ? 'Describe the work this agent should help with.' : 'What should this agent do? How should it present results?'} />
      </Field>
      <Collapsible title="Advanced settings" defaultOpen={!!(profile?.backup_model || recovery.command?.backupModel)}>
        <div className="k-grid-2">
          <Field label="Fallback model" optional hint={runtime === 'api' ? 'Tried once if the main model rejects because of quota or is unavailable.' : 'API model fallback stays saved; coding runtimes do not use it.'}>
            <Combobox name="backupModel" value={backupValue} onChange={setBackupValue} suggestions={models} maxLength={160} readOnly={locked || runtime !== 'api'} placeholder="Leave empty to disable" />
          </Field>
          <Field label="Concurrent side threads" hint="Main chat has its own queue.">
            <Input name="threadLimit" type="number" min={1} max={32} step={1} required readOnly={locked} defaultValue={profile?.thread_limit ?? recovery.command?.threadLimit ?? 2} />
          </Field>
          <Field label="Tool steps per task" hint={runtime === 'api' ? '10-200 steps. Stops with a summary; reply “continue” for more.' : 'Saved for API tasks. Coding runtimes manage their own steps.'}>
            <Input name="toolBudget" type="number" min={10} max={200} step={1} required readOnly={locked || runtime !== 'api'} defaultValue={profile?.tool_budget ?? recovery.command?.toolBudget ?? 90} />
          </Field>
        </div>
      </Collapsible>
      {error && <Alert tone="error">{error}</Alert>}
    </form>
    {profile && <div className="legacy k-legacy-block">
      <AgentComputerSettings agent={profile.id} request={api} autoFocus={focusComputer} />
      {onVisibilityChanged && <AgentVisibility agent={liveProfile!} request={api} onChanged={onVisibilityChanged} />}
      <Suspense fallback={<p role="status">Loading local sites...</p>}><SitesPanel key={`sites:${profile.id}`} agent={profile.id} request={api} /></Suspense>
      <Suspense fallback={<p className="empty" role="status">Loading agent export...</p>}><AgentTemplateExport key={profile.id} id={profile.id} request={api} /></Suspense>
    </div>}
  </Dialog>;
}
