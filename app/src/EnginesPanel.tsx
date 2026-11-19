import { Badge, Button, Card, Alert, PageHeader, Row, SkeletonRows } from './ui/kit';
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

const focusHeading = (heading: HTMLHeadingElement | null) => heading?.focus();

export function EnginesPanel({ request }: { request: <T>(path: string) => Promise<T> }) {
  const { data, busy, error, reload } = useSetupData<{ choices: RuntimeChoice[] }>(request, '/api/runtimes');

  return <div className="k-page bs-root">
    <PageHeader headingRef={focusHeading} title="Engines" actions={<Button busy={busy} onClick={reload}>Re-check</Button>} />
    {error && <Alert tone="error">Engine status could not be loaded.</Alert>}
    {data ? <Card>{data.choices.map(choice => <Row key={choice.runtime} title={choice.label} meta={<>
      {choice.version && <span>{choice.version}</span>}
      {choice.signedIn != null && <span>{choice.signedIn ? 'Signed in' : 'Signed out'}</span>}
      {choice.reason && <span>{choice.reason}</span>}
    </>} trailing={<Badge tone={choice.available ? 'success' : undefined}>{choice.available ? 'Available' : 'Unavailable'}</Badge>} />)}</Card> : !error && <SkeletonRows />}
  </div>;
}
