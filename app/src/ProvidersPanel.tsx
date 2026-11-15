import { useEffect, useRef, useState } from 'react';
import { Server } from 'lucide-react';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Row, Section, SkeletonRows } from './ui/kit';

type Request = <T>(path: string) => Promise<T>;
type Account = { id: string; name: string; host: string; configured: boolean; defaultModel: string };
export function ProvidersPanel({ request }: { request: Request }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    let alive = true;
    setError('');
    void request<Account[]>('/api/provider-accounts').then(rows => { if (alive) setAccounts(rows); }).catch(error => { if (alive) setError(error instanceof Error ? error.message : 'Providers could not be loaded.'); });
    return () => { alive = false; };
  }, [request, reload]);
  return <div className="k-page bs-root"><PageHeader headingRef={heading} title="Providers" />
    {error ? <Alert tone="error" actions={<Button size="sm" onClick={() => setReload(value => value + 1)}>Retry</Button>}>{error}</Alert> : !accounts ? <SkeletonRows /> : !accounts.length ? <EmptyState icon={<Server size={20} aria-hidden />} title="No providers" /> : accounts.map(account => <Section key={account.id} title={account.name}><Card>
      <Row title="Host" meta={account.host || 'Not configured'} trailing={<Badge tone={account.configured ? 'success' : undefined}>{account.configured ? 'Configured' : 'Not configured'}</Badge>} />
      <ProviderModels account={account} request={request} />
    </Card></Section>)}
  </div>;
}
function ProviderModels({ account, request }: { account: Account; request: Request }) {
  const [models, setModels] = useState<string[] | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => {
    if (!account.configured) return;
    let alive = true; setError('');
    void request<{ models: string[] }>(`/api/models?account=${encodeURIComponent(account.id)}`).then(data => { if (alive) setModels(data.models); }).catch(error => { if (alive) setError(error instanceof Error ? error.message : 'Models could not be loaded.'); });
    return () => { alive = false; };
  }, [account.id, account.configured, request, reload]);
  return <>
    {account.defaultModel && <Row title="Default model" meta={account.defaultModel} />}
    {account.configured && <Row title="Models" meta={error ? <span role="alert">{error}</span> : models ? models.join(', ') || 'No models' : <span role="status">Loading models...</span>} trailing={error && <Button size="sm" onClick={() => setReload(value => value + 1)}>Retry</Button>} />}
  </>;
}
