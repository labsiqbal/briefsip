import { useState } from 'react';
import { Download, Monitor } from 'lucide-react';
import type { UpdateEverythingState } from './hooks/useUpdateEverything';
import { phases, terminalUpdate } from './updateEverything.logic';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Row, Section, SkeletonRows, Switch } from './ui/kit';
import './ui/updates.css';
import './machines-data.css';

const focusHeading = (heading: HTMLHeadingElement | null) => heading?.focus();

export function UpdatesPanel({ updates }: { updates: UpdateEverythingState }) {
  const [selected, setSelected] = useState<string[]>([]);
  const { state, rows, active, error, reconnecting, lastAttempt: attempt } = updates;
  const peers = rows.filter(row => !row.local);
  const chosen = peers.filter(row => !row.skipped && selected.includes(row.id));
  const inFlight = active || !!attempt && !terminalUpdate(attempt.status);
  return <div className="k-page bs-root updates-page set4-page">
    <PageHeader headingRef={focusHeading} title="Updates"
      actions={updates.run || updates.storageError ? <Button onClick={() => updates.show()}>{updates.storageError ? 'Update recovery' : 'Update progress'}</Button> : undefined} />
    {error && <Alert tone="error">{error}</Alert>}
    {reconnecting && <Alert title="Reconnecting" />}
    {!state ? <SkeletonRows /> : <>
      <Section title="This device"><Card>
        <Row leading={<Monitor size={17} aria-hidden />} title="Current version" meta={state.current.id === 'development' ? 'Development' : state.current.commit.slice(0, 8)} trailing={<Badge>{state.current.version}</Badge>} />
        {state.launcherAvailable && state.previous && <Row title="Previous version" trailing={<Badge>{state.previous.version}</Badge>} />}
        {state.launcherAvailable && (state.available ? <>
          <Row leading={<Download size={17} aria-hidden />} title={`Briefsip ${state.available.version}`} meta={`Published ${new Date(state.available.created).toLocaleDateString()}`} trailing={<Badge tone="brand">Update available</Badge>} />
          <div className="updates-release"><p className="updates-notes">{state.available.notes}</p>
            <div className="updates-actions">
              <span className="k-field__hint">{state.runningTurns} running {state.runningTurns === 1 ? 'turn' : 'turns'}</span>
              <Button variant="primary" disabled={inFlight || !!updates.run} onClick={() => updates.show(['local'])}>{updates.localPending ? 'Retry update' : 'Update now'}</Button>
            </div>
          </div>
        </> : <Row title="Up to date" />)}
      </Card></Section>
      {attempt && <Section title="Last update"><Alert tone={['rolled-back', 'failed'].includes(attempt.status) ? 'warn' : 'info'} title={phases[attempt.status] ?? attempt.status}><span role="status">Version {attempt.version}{attempt.reason ? ` - ${attempt.reason}` : ''}</span></Alert></Section>}
      <Section title="Paired machines" actions={chosen.length > 0 ? <Button disabled={!!updates.run} onClick={() => updates.show(chosen.map(row => row.id))}>Update selected ({chosen.length})</Button> : undefined}>
        {!peers.length ? <EmptyState title="No paired machines" /> : <Card>{peers.map(row => <Row key={row.id} title={row.name}
          meta={<>{row.skipped ?? 'Ready to update'}<span>{row.running} running turns</span></>}
          trailing={<><Badge>{row.current}</Badge>{!row.skipped && <label className="k-inline"><span>Also update {row.name}</span>
            <Switch label={`Also update ${row.name}`} checked={selected.includes(row.id)} onChange={checked => setSelected(ids => checked ? [...ids, row.id] : ids.filter(id => id !== row.id))} />
          </label>}</>} />)}</Card>}
      </Section>
    </>}
  </div>;
}
