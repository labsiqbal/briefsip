import { useEffect, useRef, useState } from 'react';
import { Server } from 'lucide-react';
import { Alert, Badge, Button, Card, Collapsible, EmptyState, Input, PageHeader, Row, Section, SkeletonRows } from './ui/kit';

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
      <Row title="Host" trailing={<><span className="provider-fact">{account.host || 'Not configured'}</span><Badge tone={account.configured ? 'success' : undefined}>{account.configured ? 'Configured' : 'Not configured'}</Badge></>} />
      <ProviderModels account={account} request={request} />
    </Card></Section>)}
  </div>;
}
function ProviderModels({ account, request }: { account: Account; request: Request }) {
  const [query, setQuery] = useState(''), [closed, setClosed] = useState<string[]>([]);
  const [models, setModels] = useState<string[] | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => {
    if (!account.configured) return;
    let alive = true; setError('');
    void request<{ models: string[] }>(`/api/models?account=${encodeURIComponent(account.id)}`).then(data => { if (alive) setModels(data.models); }).catch(error => { if (alive) setError(error instanceof Error ? error.message : 'Models could not be loaded.'); });
    return () => { alive = false; };
  }, [account.id, account.configured, request, reload]);
  const groups = new Map<string, string[]>();
  for (const model of [...new Set(models ?? [])].sort()) {
    if (!model.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) continue;
    const prefix = model.includes('/') ? `${model.split('/')[0]}/` : 'Other';
    const items = groups.get(prefix) ?? [];
    items.push(model); groups.set(prefix, items);
  }
  return <>
    <Row title="Default model" trailing={<span className="provider-fact provider-model-id">{account.defaultModel || 'None'}</span>} />
    {account.configured && <div className="provider-models">
      <div className="provider-models__head"><span>Models</span>{models && <Badge>{models.length}</Badge>}</div>
      <Input type="search" aria-label={`Search models for ${account.name}`} placeholder="Search models" value={query} onChange={event => { setQuery(event.target.value); setClosed([]); }} />
      {error ? <Alert tone="error" actions={<Button size="sm" onClick={() => setReload(value => value + 1)}>Retry</Button>}>{error}</Alert> : !models ? <p role="status">Loading models...</p> : <div className="provider-models__scroll" role="region" aria-label={`Models for ${account.name}`} tabIndex={0}>
        {[...groups].map(([prefix, items]) => <Collapsible key={prefix} open={!closed.includes(prefix)} onOpenChange={open => setClosed(current => open ? current.filter(item => item !== prefix) : [...current, prefix])} title={<>{prefix}<Badge>{items.length}</Badge></>}>
          <ul className="provider-models__list">{items.map(model => <li key={model}><span className="provider-model-id">{model}</span>{model === account.defaultModel && <Badge>Default</Badge>}</li>)}</ul>
        </Collapsible>)}
        {!groups.size && <p role="status">{query.trim() ? 'No matching models' : 'No models'}</p>}
      </div>}
    </div>}
  </>;
}
