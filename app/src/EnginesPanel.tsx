import { Fragment, useId, useState } from 'react';
import { Ellipsis, KeyRound, Plus } from 'lucide-react';
import { ActionMenu, Alert, Badge, Button, Card, Dialog, Field, IconButton, Input, PageHeader, Row, SkeletonRows, useConfirm } from './ui/kit';
import { copyText } from './ui/clipboard';
import type { HarnessRuntime } from '../shared/runtime';
import { useSetupData } from './hooks/useSetupData';

export type RuntimeChoice = {
  runtime: HarnessRuntime;
  label: string;
  available: boolean;
  enabled: boolean;
  version: string | null;
  signedIn: boolean | null;
  reason: string | null;
  model?: string;
  models: { id: string; label: string }[];
};

export type EngineLogin = {
  id: string;
  runtime: 'claude' | 'codex';
  name: string;
  checkedAt: string | null;
  signedIn: boolean;
  command: string;
};

export const engineLoginsPath = '/api/engine-logins';
export const loginBinding = (login: EngineLogin) => `login:${login.id}`;
export const isLoginBinding = (binding: string) => binding.startsWith('login:');
const supportsLogin = (runtime: string): runtime is EngineLogin['runtime'] => runtime === 'claude' || runtime === 'codex';
const focusHeading = (heading: HTMLHeadingElement | null) => heading?.focus();
const message = (error: unknown) => error instanceof Error ? error.message : 'Request failed. Try again.';
type Request = <T>(path: string, data?: unknown) => Promise<T>;

export function EnginesPanel({ request }: { request: Request }) {
  const { data, busy, error, reload } = useSetupData<{ choices: RuntimeChoice[] }>(request, '/api/runtimes');
  const logins = useSetupData<EngineLogin[]>(request, engineLoginsPath);
  const [adding, setAdding] = useState<EngineLogin['runtime'] | null>(null);
  const [command, setCommand] = useState<EngineLogin | null>(null);
  const [checking, setChecking] = useState('');
  const [actionError, setActionError] = useState('');
  const confirm = useConfirm();

  function save(login: EngineLogin) {
    logins.setData(current => current?.some(item => item.id === login.id)
      ? current.map(item => item.id === login.id ? login : item)
      : [...current ?? [], login]);
  }

  async function check(login: EngineLogin) {
    setChecking(login.id);
    setActionError('');
    try { save(await request<EngineLogin>(`${engineLoginsPath}/${login.id}/check`, { id: crypto.randomUUID() })); }
    catch (error) { setActionError(message(error)); }
    finally { setChecking(''); }
  }

  async function remove(login: EngineLogin) {
    if (!await confirm({ title: 'Remove login?', description: login.name, confirm: 'Remove', danger: true })) return;
    setChecking(login.id);
    setActionError('');
    try {
      await request(`${engineLoginsPath}/${login.id}/remove`, { id: crypto.randomUUID() });
      logins.setData(current => current?.filter(item => item.id !== login.id) ?? null);
    } catch (error) { setActionError(message(error)); }
    finally { setChecking(''); }
  }

  return <div className="k-page bs-root">
    <PageHeader headingRef={focusHeading} title="Engines" actions={<Button busy={busy || logins.busy} disabled={!!checking} onClick={() => { reload(); logins.reload(); }}>Re-check</Button>} />
    {error && <Alert tone="error">Engine status could not be loaded.</Alert>}
    {logins.error && <Alert tone="error">Engine logins could not be loaded.</Alert>}
    {actionError && <Alert tone="error">{actionError}</Alert>}
    {data ? <Card>{data.choices.map(choice => {
      const runtime = choice.runtime;
      return <Fragment key={runtime}>
        <Row title={choice.label} meta={<>
          {choice.version && <span>{choice.version}</span>}
          {choice.signedIn != null && <span>{choice.signedIn ? 'Signed in' : 'Signed out'}</span>}
          {choice.reason && <span>{choice.reason}</span>}
        </>} trailing={<>
          <Badge tone={choice.available ? 'success' : undefined}>{choice.available ? 'Available' : 'Unavailable'}</Badge>
          {supportsLogin(runtime) && <Button size="sm" aria-label={`Add login for ${choice.label}`} disabled={logins.busy || logins.error || !!checking} icon={<Plus size={14} aria-hidden />} onClick={() => { setActionError(''); setAdding(runtime); }}>Add login</Button>}
        </>} />
        {logins.data?.filter(login => login.runtime === runtime).map(login => <Row key={login.id}
          leading={<KeyRound size={16} aria-hidden />} title={login.name}
          meta={<span role="status">{login.signedIn ? 'Signed in' : login.checkedAt ? 'Signed out' : 'Not checked'}</span>}
          trailing={<>
            <Button size="sm" busy={checking === login.id} disabled={logins.busy || !!checking} onClick={() => void check(login)}>Check sign-in</Button>
            <ActionMenu label={`Actions for ${login.name}`} trigger={<IconButton label={`Actions for ${login.name}`} disabled={logins.busy || !!checking}><Ellipsis size={16} aria-hidden /></IconButton>} items={[
              { label: 'Sign-in command', onSelect: () => setCommand(login) },
              { label: 'Remove', danger: true, onSelect: () => void remove(login) },
            ]} />
          </>} />)}
      </Fragment>;
    })}</Card> : !error && <SkeletonRows />}
    {adding && <AddEngineLogin runtime={adding} request={request} onClose={() => setAdding(null)} onSaved={login => { save(login); setAdding(null); setCommand(login); }} />}
    {command && <LoginCommand login={command} onClose={() => setCommand(null)} />}
  </div>;
}

function AddEngineLogin({ runtime, request, onSaved, onClose }: {
  runtime: EngineLogin['runtime']; request: Request; onSaved: (login: EngineLogin) => void; onClose: () => void;
}) {
  const form = useId();
  const [id] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Dialog open title={runtime === 'codex' ? 'Add Codex login' : 'Add Claude login'} onOpenChange={open => { if (!open && !busy) onClose(); }} footer={<>
    <Button disabled={busy} onClick={onClose}>Cancel</Button>
    <Button type="submit" form={form} variant="primary" busy={busy}>Add login</Button>
  </>}>
    <form id={form} className="k-stack" onSubmit={async event => {
      event.preventDefault();
      if (busy) return;
      const name = String(new FormData(event.currentTarget).get('name')).trim();
      setBusy(true); setError('');
      try { onSaved(await request<EngineLogin>(engineLoginsPath, { id, runtime, name })); }
      catch (error) { setError(message(error)); }
      finally { setBusy(false); }
    }}>
      <Field label="Name"><Input name="name" maxLength={80} autoComplete="off" required readOnly={busy} /></Field>
      {error && <Alert tone="error">{error}</Alert>}
    </form>
  </Dialog>;
}

function LoginCommand({ login, onClose }: { login: EngineLogin; onClose: () => void }) {
  const [feedback, setFeedback] = useState('');
  return <Dialog open title="Sign in on this host" description={login.name} onOpenChange={open => { if (!open) onClose(); }} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
    <div className="k-stack">
      <Field label="Terminal command"><Input value={login.command} readOnly spellCheck={false} onFocus={event => event.target.select()} /></Field>
      <div className="k-row-actions">
        <Button onClick={async () => {
          try { await copyText(login.command); setFeedback('Copied'); }
          catch { setFeedback('Copy failed. Select the command to copy it.'); }
        }}>Copy command</Button>
        <span className="k-field__hint" role="status">{feedback}</span>
      </div>
    </div>
  </Dialog>;
}
