import { useState } from 'react';
import { Check, Plug, Plus, Send } from 'lucide-react';
import { AgentForm, type Agent, type FirstAgentDefaults } from './AgentProfileDialog';
import { ProviderForm, type ProviderAccount } from './ProvidersPanel';
import { engineLoginsPath, loginBinding, type EngineLogin, type RuntimeChoice } from './EnginesPanel';
import { Alert, Button, PageHeader } from './ui/kit';
import './first-run.css';
import { useSetupData } from './hooks/useSetupData';

const focusHeading = (heading: HTMLHeadingElement | null) => heading?.focus();
const steps = [
  { title: 'Connect an AI', icon: Plug },
  { title: 'Create agent', icon: Plus },
  { title: 'Send first message', icon: Send },
];

export function FirstRun({ request, isClientError, settingsOpen, onOpenEngines, onCreated }: {
  request: <T>(path: string, data?: unknown) => Promise<T>;
  isClientError: (error: unknown) => boolean;
  settingsOpen: boolean;
  onOpenEngines: () => void;
  onCreated: (agent: Agent) => void;
}) {
  const accounts = useSetupData<ProviderAccount[]>(request, '/api/provider-accounts', !settingsOpen);
  const engines = useSetupData<{ choices: RuntimeChoice[] }>(request, '/api/runtimes', !settingsOpen);
  const choices = engines.data?.choices;
  const logins = useSetupData<EngineLogin[]>(request, engineLoginsPath, !settingsOpen);
  const [adding, setAdding] = useState(false);
  const error = accounts.error || engines.error || logins.error;
  const connected = accounts.data?.filter(account => account.configured) ?? [];
  const codex = choices?.some(choice => choice.runtime === 'codex' && choice.available && choice.enabled);
  const openai = codex && connected.find(account => account.provider === 'openai-compatible');
  const account = openai || connected[0];
  const host = choices?.find(choice => !['codex', 'claude'].includes(choice.runtime)
    && choice.available && choice.enabled && choice.signedIn === true);
  const login = logins.data?.find(login => login.signedIn && choices?.some(choice => choice.runtime === login.runtime && choice.available && choice.enabled));
  const connection = account?.name ?? login?.name ?? host?.label;
  const defaults: FirstAgentDefaults | undefined = account
    ? { runtime: openai ? 'codex' : 'api', account: account.id, model: account.defaultModel }
    : login ? { runtime: login.runtime, account: loginBinding(login), model: 'default' }
    : host && { runtime: host.runtime, account: '', model: host.models[0]?.id ?? 'default' };
  const activeStep = defaults && !adding ? 1 : 0;

  return <main className="chat page-view bs-root"><div className="page-scroll">
    <div className="first-run">
      <PageHeader headingRef={focusHeading} title="Set up Briefsip" />
      {error && <Alert tone="error" actions={<Button size="sm" onClick={() => { accounts.reload(); engines.reload(); logins.reload(); }}>Retry</Button>}>Setup status could not be loaded.</Alert>}
      <ol className="first-run__steps" aria-label="Setup progress">
        {steps.map(({ title, icon: Icon }, index) => {
          const done = index < activeStep;
          const active = index === activeStep;
          return <li key={title} aria-current={active ? 'step' : undefined} className={done ? 'is-done' : active ? 'is-active' : undefined}>
            <div className="first-run__step">
              <span className="first-run__icon" aria-hidden>{done ? <Check size={15} /> : <Icon size={15} />}</span>
              <strong>{title}</strong>
              {done && <span className="first-run__status">{connection}</span>}
              {done && !account && <Button onClick={() => setAdding(true)}>Add provider</Button>}
            </div>
            {active && <div className="first-run__form">
              {index === 0 && (accounts.data || accounts.error) && <div className="k-stack">
                <Button onClick={() => { setAdding(false); onOpenEngines(); }}>Set up an engine login</Button>
                <div onFocusCapture={() => setAdding(true)}><ProviderForm request={request} onSaved={saved => {
                  accounts.setData(current => [...current ?? [], saved]);
                  setAdding(false);
                }} /></div>
                {defaults && <Button variant="ghost" onClick={() => setAdding(false)}>Use {connection}</Button>}
              </div>}
              {index === 1 && ((choices || !engines.busy) && defaults
                ? <AgentForm request={request} isClientError={isClientError} model={defaults.model} firstRun={defaults} onCreated={onCreated} />
                : <span className="k-field__hint" role="status">Checking engines…</span>)}
            </div>}
          </li>;
        })}
      </ol>
    </div>
  </div></main>;
}
