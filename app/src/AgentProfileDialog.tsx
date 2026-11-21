import { useReturnFocus } from './hooks/useReturnFocus';
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { Tabs as RadixTabs } from 'radix-ui';
import { Brain, ChevronRight, Ellipsis, Globe, Terminal, Bot, Sparkles, Orbit, Wind, Circle, Code, Eclipse, Mountain } from 'lucide-react';
import type { Runtime } from '../shared/runtime';
import { DEVICE_BINDING, engineLoginsPath, isLoginBinding, loginBinding, usesEngineSignIn, type EngineLogin, type RuntimeChoice } from './EnginesPanel';
import { restoreAgentCreation, type AgentCreation } from '../shared/agent-create';
import { AgentAvatar, AvatarEditor } from './AgentAvatar';
import { MascotAvatar } from './ui/avatar-shapes';
import { CompactionPanel } from './CompactionPanel';
import { AgentComputerSettings } from './AgentComputerSettings';
import { AgentFolderSettings } from './AgentFolderSettings';
import { AgentVisibility } from './AgentVisibility';
import { ActionMenu, Alert, Button, Card, Collapsible, Combobox, Dialog, Field, IconButton, Input, RecoveryAlert, Row, Segmented, Select, Switch, Tabs, Textarea, Tooltip, useConfirm, type SelectOption } from './ui/kit';

import './agent-profile.css';

const AgentTemplateExport = lazy(() => import('./AgentTemplateImport').then(module => ({ default: module.AgentTemplateExport })).catch(() => ({ default: () => <Alert tone="error" actions={<Button onClick={() => window.location.reload()}>Reload app</Button>}>Panel could not be loaded</Alert> })));
const MemoryPanel = lazy(() => import('./MemoryPanel').then(module => ({ default: module.MemoryPanel })));
const SitesPanel = lazy(() => import('./SitesPanel').then(module => ({ default: module.SitesPanel })));
const message = (error: unknown) => error instanceof Error ? error.message : 'Connection failed. Try again.';

export type Agent = { workspace_connected?: boolean; runtime?: Runtime; runnable?: boolean; blocked_reason?: string | null; computer_waiting?: boolean; avatar_revision?: number; hidden?: boolean; visibility_revision?: number; provider_account?: string; provider_available?: boolean; backup_model?: string; thread_limit: number; tool_budget?: number; web_access?: 0 | 1; revision: number; id: string; name: string; role: string; model: string; instructions: string };

export type FirstAgentDefaults = { runtime: Runtime; account: string; model: string };
const harnessLabels = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes', antigravity: 'Antigravity', grok: 'Grok', pi: 'Pi', opencode: 'OpenCode', gemini: 'Gemini', kiro: 'Kiro' };

export function AgentForm({ model, firstRun, focusComputer = false, profile: liveProfile, onCreated, onCancel, onReload, onVisibilityChanged, onDelete, request: api, isClientError }: { request: <T>(path: string, data?: unknown) => Promise<T>; isClientError: (error: unknown) => boolean; model: string; firstRun?: FirstAgentDefaults; focusComputer?: boolean; profile?: Agent; onCreated: (agent: Agent) => void; onCancel?: () => void; onReload?: () => Promise<void>; onVisibilityChanged?: () => Promise<void>; onDelete?: (agent: Agent) => Promise<void> }) {
  const confirm = useConfirm();
  const [look, setLook] = useState<import('./ui/avatar-shapes').AvatarLook | null>(null);
  const [LookPicker] = useState(() => lazy(() => import('./ui/avatar-shapes').then(module => ({ default: module.AvatarPicker }))));
  const [profile] = useState(liveProfile);
  const creationKey = 'minarbot-agent-creation';
  const nameInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState(focusComputer ? 'advanced' : 'profile');
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [resource, setResource] = useState<'memory' | 'sites' | null>(null);
  const resourceTrigger = useRef<HTMLElement | null>(null);
  function openResource(value: 'memory' | 'sites') { resourceTrigger.current = document.activeElement as HTMLElement; setResource(value); }
  function closeResource() { setResource(null); }
  useReturnFocus(resourceTrigger, resource !== null);
  const exportTrigger = useRef<HTMLButtonElement>(null), avatarChange = useRef<HTMLButtonElement>(null);
  useReturnFocus(exportTrigger, exportOpen);
  useReturnFocus(avatarChange, avatarOpen);
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  const [recovery, setRecovery] = useState(() => { try { return { command: liveProfile ? null : restoreAgentCreation(sessionStorage.getItem(creationKey)), invalid: false }; } catch { return { command: null, invalid: true }; } });
  const [avatarName, setAvatarName] = useState(profile?.name ?? recovery.command?.name ?? '');
  const [instructionCount, setInstructionCount] = useState((profile?.instructions ?? recovery.command?.instructions ?? '').length);
  const [invalid, setInvalid] = useState(recovery.invalid);
  const [setup, setSetup] = useState(recovery.command?.setup ?? false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const [runtime, setRuntime] = useState(profile?.runtime ?? (recovery.command ? recovery.command.runtime ?? 'api' : firstRun?.runtime ?? 'api'));
  const runtimeChosen = useRef(false);
  const [runtimeChoices, setRuntimeChoices] = useState<RuntimeChoice[]>([]);
  const [harnessModel, setHarnessModel] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState('');
  const quick = !!firstRun;
  useEffect(() => {
    if (quick) return;
    let stopped = false;
    void api<{ choices: RuntimeChoice[]; defaultRuntime?: Runtime }>(profile ? `/api/agents/${profile.id}/runtimes` : '/api/runtimes').then(data => { if (stopped) return; setRuntimeChoices(data.choices); if (!profile && !recovery.command && !runtimeChosen.current && data.defaultRuntime) setRuntime(data.choices.some(choice => choice.runtime === data.defaultRuntime && choice.available && choice.enabled) ? data.defaultRuntime : 'api'); }).catch(error => { if (!stopped) setRuntimeError(message(error)); });
    return () => { stopped = true; };
  }, [profile, quick]);
  const [account, setAccount] = useState(profile?.provider_account ?? recovery.command?.providerAccount ?? firstRun?.account ?? '');
  const [accounts, setAccounts] = useState<{ id: string; name: string; configured: boolean; defaultModel: string }[]>([]);
  const [logins, setLogins] = useState<EngineLogin[]>([]);
  const [accountError, setAccountError] = useState('');
  const [accountReload, setAccountReload] = useState(0);
  useEffect(() => {
    if (quick) return;
    let stopped = false; setAccountError('');
    void api<typeof accounts>('/api/provider-accounts').then(items => { if (!stopped) setAccounts(items); }).catch(error => { if (!stopped) setAccountError(message(error)); });
    void api<EngineLogin[]>(engineLoginsPath).then(items => { if (!stopped) setLogins(items); }).catch(error => { if (!stopped) setAccountError(message(error)); });
    return () => { stopped = true; };
  }, [accountReload, quick]);
  const [models, setModels] = useState<string[]>([]);
  const [catalogStatus, setCatalogStatus] = useState('Loading models');
  useEffect(() => {
    if ((quick && model) || !['api', 'codex', 'claude'].includes(runtime)) { setModels([]); return; }
    if (usesEngineSignIn(account)) { setModels([]); setCatalogStatus(''); return; }
    let stopped = false;
    setModels([]); setCatalogStatus('Loading models');
    void api<{ models: string[] }>(`/api/models?account=${encodeURIComponent(account)}`).then(data => {
      if (!stopped) {
        setModels(data.models); setCatalogStatus(data.models.length ? '' : 'Enter model ID');
        if (quick) setModelValue(current => current || data.models[0] || '');
      }
    }).catch(error => { if (!stopped) setCatalogStatus(message(error)); });
    return () => { stopped = true; };
  }, [account, accountReload, model, runtime, quick]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [advancedOpen, setAdvancedOpen] = useState(!!recovery.command?.backupModel);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [modelValue, setModelValue] = useState(profile?.model ?? recovery.command?.model ?? model);
  const [backupValue, setBackupValue] = useState(profile?.backup_model ?? recovery.command?.backupModel ?? '');
  const [webAccess, setWebAccess] = useState(profile?.web_access !== 0);
  const pending = useRef<(AgentCreation & { revision?: number; webAccess?: boolean }) | null>(recovery.command);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || invalid) return;
    const form = new FormData(event.currentTarget);
    const data = pending.current ?? { id: crypto.randomUUID(), ...(profile ? { revision: profile.revision, webAccess } : setup ? { setup: true } : {}), providerAccount: account, name: String(form.get('name')).trim() || (setup ? 'New agent' : ''), role: String(form.get('role') ?? '').trim(), model: String(form.get('model')).trim(), backupModel: String(form.get('backupModel') ?? '').trim(), instructions: String(form.get('instructions') ?? '').trim() || 'Help the user complete their tasks.', threadLimit: Number(form.get('threadLimit') ?? 2), toolBudget: Number(form.get('toolBudget') ?? 90) };
    if (profile && runtime !== (profile.runtime ?? 'api') && !pending.current) {
      Object.assign(data, { runtime, confirmRuntime: true });
    }
    if (!profile && !pending.current) Object.assign(data, { runtime });
    if (profile && runtime !== 'api' && runtime !== 'codex' && runtime !== 'claude') Object.assign(data, { harnessModel: harnessModel ?? runtimeChoices.find(choice => choice.runtime === runtime)?.model ?? '' });
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
          const key = `minarbot-avatar:${created.id}`;
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
  const loginOptions: SelectOption[] = logins.filter(login => login.runtime === runtime).map(login => ({
    value: loginBinding(login),
    label: `${login.runtime === 'codex' ? 'Codex' : 'Claude'} login: ${login.name}`,
    hint: login.signedIn ? undefined : 'Signed out',
  }));
  const deviceOptions: SelectOption[] = runtime === 'codex' || runtime === 'claude' ? [{
    value: DEVICE_BINDING,
    label: `${harnessLabels[runtime]} on this machine`,
    hint: runtimeChoices.find(choice => choice.runtime === runtime)?.signedIn === false ? 'Signed out' : undefined,
  }] : [];
  const accountOptions: SelectOption[] = [
    ...(!accounts.some(item => item.id === '') ? [{ value: '', label: 'Default' }] : []),
    ...(account && !accounts.some(item => item.id === account) && !loginOptions.some(item => item.value === account) && !deviceOptions.some(item => item.value === account) ? [{ value: account, label: 'Unavailable account', hint: account }] : []),
    ...deviceOptions,
    ...accounts.map(item => ({ value: item.id, label: item.name.slice(0, 40), hint: item.configured ? undefined : 'Not connected' })),
    ...loginOptions,
  ];
  const submitLabel = profile ? 'Save changes' : pending.current ? 'Retry creation' : setup ? 'Create and draft' : 'Create agent';
  const profileFields = <>
    {(!profile || onVisibilityChanged) && <div className="agent-profile__avatar">
      {profile ? <AgentAvatar agent={liveProfile!} size={40} /> : <span className="agent-profile__initials">{look ? <MascotAvatar look={look} size={40} /> : <AgentAvatar agent={{ id: '', name: avatarName.trim() || '?' }} size={40} />}</span>}<span className="agent-profile__name">{profile?.name ?? 'Avatar'}</span>
      <Button ref={avatarChange} onClick={() => setAvatarOpen(true)}>Change</Button>
    </div>}
    <Field label={!profile && setup ? 'Temporary name' : 'Name'} optional={!profile && setup} error={fieldErrors.name}>
      <Input ref={nameInput} name="name" onChange={event => setAvatarName(event.target.value)} required={!setup} maxLength={80} readOnly={locked} defaultValue={profile?.name ?? recovery.command?.name} placeholder="Iris" />
    </Field>
    <Field label="Role" optional><Input name="role" maxLength={60} readOnly={locked} defaultValue={profile?.role ?? recovery.command?.role ?? ''} /></Field>
    <Field label={!profile && setup ? 'Brief' : 'Instructions'} optional={!profile && !setup} error={fieldErrors.instructions}>
      <Textarea name="instructions" required={!!profile || setup} maxLength={8000} readOnly={locked} defaultValue={profile?.instructions ?? recovery.command?.instructions} rows={6} onChange={event => setInstructionCount(event.target.value.length)} placeholder={!profile && setup ? 'Describe the work this agent should help with.' : undefined} />{profile && <span aria-hidden className="agent-profile__count">{instructionCount}/8000</span>}
    </Field>
  </>;
  const modelFields = <>
    {profile?.runtime === 'api' && <Button type="button" onClick={event => { flushSync(() => setRuntime('codex')); event.currentTarget.form?.requestSubmit(); }} disabled={locked || busy || !runtimeChoices.some(choice => choice.runtime === 'codex' && choice.available && choice.enabled)}>Use Codex</Button>}
    <Field label="Run with" error={runtimeError}>
      <span className="agent-profile__runtime"><Select label="Run with" valueLabel={runtime !== 'api' && !runtimeChoices.some(choice => choice.runtime === runtime) ? harnessLabels[runtime] : undefined} value={runtime} onChange={value => { runtimeChosen.current = true; setRuntime(value as Runtime); setHarnessModel(null); if (value !== runtime && (isLoginBinding(account) || account === DEVICE_BINDING && value !== 'codex' && value !== 'claude')) setAccount(''); }} disabled={locked || busy} options={[
        { value: 'api', label: <span className="agent-profile__runtime-label"><Globe size={16} aria-hidden />API model</span> },
        ...runtimeChoices.map(choice => {
          const Icon = { codex: Terminal, claude: Sparkles, hermes: Wind, antigravity: Orbit, grok: Eclipse, pi: Circle, opencode: Code, gemini: Bot, kiro: Mountain }[choice.runtime];
          const disabled = !choice.available || !choice.enabled;
          return {
            value: choice.runtime, disabled,
            hint: disabled ? <span className="agent-profile__runtime-reason">{choice.reason ?? 'Unavailable on this host.'}</span> : undefined,
            label: <span className="agent-profile__runtime-label"><Icon size={16} aria-hidden />{choice.label}</span>,
          };
        }),
      ]} /></span>
    </Field>
    <Field label="Provider" error={accountError && <>{accountError} <button type="button" className="k-link" onClick={() => setAccountReload(value => value + 1)}>Reload</button></>}>
      <Select value={account} onChange={setAccount} disabled={locked || !['api', 'codex', 'claude'].includes(runtime)} options={accountOptions} />
    </Field>
    {runtime !== 'api' && runtime !== 'codex' && runtime !== 'claude' && <Field label="Harness model">
      <Select label="Harness model" value={harnessModel ?? runtimeChoices.find(choice => choice.runtime === runtime)?.model ?? ''} onChange={setHarnessModel} disabled={locked || busy} options={[{ value: '', label: 'Host default' }, ...(runtimeChoices.find(choice => choice.runtime === runtime)?.models ?? []).map(model => ({ value: model.id, label: model.label }))]} />
    </Field>}
    <Field label="Model" error={fieldErrors.model} hint={['api', 'codex', 'claude'].includes(runtime) ? catalogStatus : undefined}>
      <Combobox name="model" value={modelValue} onChange={setModelValue} suggestions={models} required maxLength={160} readOnly={locked || !['api', 'codex', 'claude'].includes(runtime)} placeholder="Enter model ID" />
    </Field>
    {profile && <Collapsible title="Fallback model" defaultOpen={!!profile.backup_model}>
      <Field label="Fallback model" optional><Tooltip content="Tried once for quota or availability failure"><span><Combobox name="backupModel" value={backupValue} onChange={setBackupValue} suggestions={models} maxLength={160} readOnly={locked || runtime !== 'api'} placeholder="Enter model ID" /></span></Tooltip></Field>
    </Collapsible>}
  </>;
  const advancedFields = <>
    {!profile && <Field label="Fallback model" optional><Combobox name="backupModel" value={backupValue} onChange={setBackupValue} suggestions={models} maxLength={160} readOnly={locked || runtime !== 'api'} placeholder="Enter model ID" /></Field>}
    <Field label="Parallel chats" error={fieldErrors.threadLimit}><Tooltip content="Excludes main chat"><Input name="threadLimit" type="number" min={1} max={32} step={1} required readOnly={locked} defaultValue={profile?.thread_limit ?? recovery.command?.threadLimit ?? 2} /></Tooltip></Field>
    <Field label="Tool step limit" error={fieldErrors.toolBudget}><Tooltip content={runtime === 'api' ? 'Stops with summary at limit. Continue to resume.' : 'API tasks only'}><Input name="toolBudget" type="number" min={10} max={200} step={1} required readOnly={locked || runtime !== 'api'} defaultValue={profile?.tool_budget ?? recovery.command?.toolBudget ?? 90} /></Tooltip></Field>
  </>;
  if (firstRun) return <form className="k-stack" onSubmit={event => {
    if (!locked && !avatarName.trim()) {
      event.preventDefault(); setFieldErrors({ name: 'Enter a name.' }); nameInput.current?.focus(); return;
    }
    void create(event);
  }}>
    <Field label="Name" error={fieldErrors.name}><Input ref={nameInput} name="name" required maxLength={80} readOnly={locked || busy} value={avatarName} onChange={event => { setAvatarName(event.target.value); setFieldErrors({}); }} placeholder="Iris" autoFocus /></Field>
    <Field label="Model" hint={runtime === 'api' ? 'API model' : harnessLabels[runtime]}><Input name="model" required maxLength={160} readOnly={locked || busy || !['api', 'codex'].includes(runtime) && !usesEngineSignIn(account)} value={modelValue} onChange={event => setModelValue(event.target.value)} /></Field>
    {error && <Alert tone="error">{error}</Alert>}
    {invalid && <Alert tone="error" title="Recovery data could not be read" actions={<Button size="sm" onClick={() => void discardInvalid()}>Discard recovery data</Button>} />}
    <div className="k-row-actions">
      <Button type="submit" variant="primary" disabled={invalid || !modelValue.trim()} busy={busy}>{submitLabel}</Button>
      {locked && <Button variant="ghost" disabled={busy} onClick={() => void discardPending()}>Discard recovery</Button>}
    </div>
  </form>;
  return <>
    <Dialog open size={profile ? 'lg' : 'md'} onOpenChange={next => { if (!next && !busy) onCancel?.(); }} title={profile ? 'Agent profile' : 'New agent'}
      actions={profile && <ActionMenu label="Agent profile actions" trigger={<IconButton ref={exportTrigger} label="Agent profile actions" tooltip="More actions"><Ellipsis size={16} aria-hidden /></IconButton>} items={[{ label: 'Export template', onSelect: () => setExportOpen(true) }, ...(onVisibilityChanged ? [{ label: liveProfile?.hidden ? 'Restore agent' : 'Hide agent', onSelect: () => setVisibilityOpen(true) }] : []), ...(onDelete ? [{ label: 'Delete agent', danger: true, disabled: busy, onSelect: () => void onDelete(profile).catch(error => setError(message(error))) }] : [])]} />}
      footer={<>
        {!profile && pending.current && <Button variant="ghost" disabled={busy} onClick={() => void discardPending()} className="k-dialog__foot-start">Discard recovery</Button>}
        {profile && error && onReload && <Button variant="ghost" onClick={onReload} className="k-dialog__foot-start">Discard changes and reload</Button>}
        <Button disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button type="submit" form="agent-form" variant="primary" busy={busy} disabled={invalid}>{busy ? 'Saving...' : submitLabel}</Button>
      </>}>
      {invalid && <Alert tone="error" title="Recovery data could not be read" actions={<Button size="sm" onClick={() => void discardInvalid()}>Discard recovery data</Button>}>Check the agent list before discarding it.</Alert>}
      {!profile && pending.current && <RecoveryAlert inFlight={busy} tone="warn" title="Creation is not confirmed yet">Try again with the same request to avoid creating a duplicate agent.</RecoveryAlert>}
      <div className={`agent-profile${profile ? ' agent-profile--edit' : ''}`}>
        <Tabs value={tab} onChange={setTab} label="Agent profile" tabs={profile ? [{ value: 'profile', label: 'Profile' }, { value: 'model', label: 'Model' }, { value: 'advanced', label: 'Advanced' }] : []}>
          <form id="agent-form" className="k-fieldset" noValidate onChange={event => { setFieldErrors(current => { const next = { ...current }; if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) delete next[event.target.name]; return next; }); }} onSubmit={event => {
            const inputs = Array.from(event.currentTarget.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'));
            const invalid = inputs.filter(input => !input.validity.valid || input.required && !input.value.trim());
            setFieldErrors(Object.fromEntries(invalid.map(input => [input.name, input.validity.rangeUnderflow || input.validity.rangeOverflow ? `Use ${input.getAttribute('min')}-${input.getAttribute('max')}.` : input.validity.badInput || input.validity.stepMismatch ? 'Enter a whole number.' : 'Required.'])));
            if (invalid.length) {
              event.preventDefault();
              const input = invalid[0];
              flushSync(() => {
                if (profile) setTab(['model', 'backupModel'].includes(input.name) ? 'model' : ['threadLimit', 'toolBudget'].includes(input.name) ? 'advanced' : 'profile');
                else if (['model', 'backupModel', 'threadLimit', 'toolBudget'].includes(input.name)) setAdvancedOpen(true);
              });
              input.focus(); return;
            }
            void create(event);
          }}>
            {profile ? <>
              {/* Force-mounted panels keep all staged values in FormData, including coding-runtime API settings. */}
              <RadixTabs.Content tabIndex={-1} forceMount value="profile" hidden={tab !== 'profile'} className="k-tabs__panel">{profileFields}</RadixTabs.Content>
              <RadixTabs.Content tabIndex={-1} forceMount value="model" hidden={tab !== 'model'} className="k-tabs__panel">{modelFields}</RadixTabs.Content>
              <RadixTabs.Content tabIndex={-1} forceMount value="advanced" hidden={tab !== 'advanced'} className="k-tabs__panel">{advancedFields}
                <Card><Row title="Web access" trailing={<Switch label="Web access" checked={webAccess} onChange={setWebAccess} disabled={locked || busy} />} /></Card>
                <AgentComputerSettings agent={profile.id} request={api} autoFocus={focusComputer && tab === 'advanced'} />
                <AgentFolderSettings agent={profile.id} request={api} isClientError={isClientError} />
                <div className="details-list agent-profile__resources">
                  <button type="button" className="panel-row panel-row--link" onClick={() => openResource('memory')}><Brain size={16} aria-hidden /><span className="panel-row__title">Agent memory</span><ChevronRight size={14} aria-hidden /></button>
                  <CompactionPanel path={`/api/agents/${profile.id}/compaction`} request={api} />
                  <button type="button" className="panel-row panel-row--link" onClick={() => openResource('sites')}><Globe size={16} aria-hidden /><span className="panel-row__title">Agent sites</span><ChevronRight size={14} aria-hidden /></button>
                </div>
              </RadixTabs.Content>
            </> : <>
              <Segmented label="How to create an agent" value={setup ? 'describe' : 'manual'} disabled={busy || locked || invalid} onChange={value => setSetup(value === 'describe')} options={[{ value: 'manual', label: 'Manual' }, { value: 'describe', label: 'Draft with AI' }]} />
              {profileFields}
              <Collapsible title="Advanced settings" open={advancedOpen} onOpenChange={setAdvancedOpen}>{modelFields}{advancedFields}</Collapsible>
            </>}
          </form>
        </Tabs>
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Dialog>
    {profile && resource && <Dialog open size="lg" title={resource === 'memory' ? 'Agent memory' : 'Agent sites'} onOpenChange={open => { if (!open) closeResource(); }}>
      <Suspense fallback={<p role="status">Loading...</p>}>{resource === 'memory' ? <MemoryPanel channel={false} archived={false} path={`/api/agents/${profile.id}/memory`} request={api} onClose={closeResource} /> : <SitesPanel agent={profile.id} request={api} />}</Suspense>
    </Dialog>}
    {profile && onVisibilityChanged && <Dialog open={visibilityOpen} title="Availability" onOpenChange={setVisibilityOpen} footer={<Button onClick={() => setVisibilityOpen(false)}>Done</Button>}><AgentVisibility agent={liveProfile!} request={api} onChanged={onVisibilityChanged} /></Dialog>}
    {profile && exportOpen && <Dialog open size="lg" title="Export template" description={profile.name} onOpenChange={setExportOpen} footer={<Button onClick={() => setExportOpen(false)}>Done</Button>}><Suspense fallback={<p role="status">Loading saved profile...</p>}><AgentTemplateExport id={profile.id} request={api} /></Suspense></Dialog>}
    {!profile && <Dialog open={avatarOpen} size="md" title="Avatar" onOpenChange={setAvatarOpen} footer={<Button onClick={() => setAvatarOpen(false)}>Done</Button>}><Suspense fallback={<p role="status">Loading avatar picker...</p>}><LookPicker name={avatarName} value={look} onChange={setLook} disabled={busy || locked || invalid} /></Suspense></Dialog>}
    {profile && onVisibilityChanged && avatarOpen && <AvatarEditor agent={profile.id} request={api} onChanged={onVisibilityChanged} onClose={() => setAvatarOpen(false)} />}
  </>;
}
