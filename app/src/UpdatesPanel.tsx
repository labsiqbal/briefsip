import { Fragment, useState } from 'react';
import { Download, Monitor } from 'lucide-react';
import type { UpdateEverythingState } from './hooks/useUpdateEverything';
import { availableUpdates, downloadLabel, phases, terminalUpdate } from './updateEverything.logic';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Row, Section, SkeletonRows, Switch } from './ui/kit';
import './ui/updates.css';
import './machines-data.css';

const focusHeading = (heading: HTMLHeadingElement | null) => heading?.focus();

export function UpdatesPanel({ updates }: { updates: UpdateEverythingState }) {
  const [selected, setSelected] = useState<string[]>([]);
  const { state, rows, downloads, active, error, reconnecting, lastAttempt: attempt } = updates;
  const peers = rows.filter(row => !row.local);
  const chosen = peers.filter(row => !row.skipped && selected.includes(row.id));
  const offers = state ? availableUpdates(state) : [];
  const inFlight = active || !!attempt && !terminalUpdate(attempt.status);
  return <div className="k-page bs-root updates-page set4-page">
    <PageHeader headingRef={focusHeading} title="Updates"
      actions={updates.run || updates.storageError ? <Button onClick={() => updates.show()}>{updates.storageError ? 'Update recovery' : 'Update progress'}</Button> : undefined} />
    {error && <Alert tone="error">{error}</Alert>}
    {reconnecting && <Alert title="Reconnecting" />}
    {state?.githubError && <Alert tone="warn">{state.githubError}</Alert>}
    {!state ? <SkeletonRows /> : <>
      <Section title="This device"><Card>
        <Row leading={<Monitor size={17} aria-hidden />} title="Current version" meta={state.current.id === 'development' ? 'Development' : state.current.commit.slice(0, 8)} trailing={<Badge>{state.current.version}</Badge>} />
        {state.launcherAvailable && state.previous && <Row title="Previous version" trailing={<Badge>{state.previous.version}</Badge>} />}
        {state.launcherAvailable && (offers.length ? offers.map(release => <Fragment key={release.source ?? release.id}>
          <Row leading={<Download size={17} aria-hidden />} title={`Minarbot ${release.version}`}
            meta={`${release.source ?? 'Local feed'} · Published ${new Date(release.created).toLocaleDateString()}`}
            trailing={<Badge tone="brand">Update available</Badge>} />
          <div className="updates-release"><p className="updates-notes">{release.notes}</p>
            <div className="updates-actions">
              <span className="k-field__hint">{state.runningTurns} running {state.runningTurns === 1 ? 'turn' : 'turns'}</span>
              <Button variant="primary" disabled={inFlight || !!updates.run} onClick={() => updates.show(['local'], release)} aria-label={offers.length > 1 && !updates.localPending ? `Update from ${release.source ?? 'Local feed'}` : undefined}>{updates.localPending ? 'Retry update' : 'Update now'}</Button>
            </div>
          </div>
        </Fragment>) : <Row title={state.githubError ? 'No updates available' : 'Up to date'} />)}
      </Card></Section>
      {attempt && <Section title="Last update"><Alert tone={['rolled-back', 'failed'].includes(attempt.status) ? 'warn' : 'info'} title={downloads.local ? downloadLabel(downloads.local) : phases[attempt.status] ?? attempt.status}>
        <span>Version {attempt.version}{attempt.source ? ` · ${attempt.source}` : ''}{attempt.reason ? ` - ${attempt.reason}` : ''}</span>
        {downloads.local?.totalBytes && <progress className="updates-download" aria-label="Download progress"
          value={downloads.local.bytesTransferred ?? 0} max={downloads.local.totalBytes} />}</Alert></Section>}
      <Section title="Paired machines" actions={chosen.length > 0 ? <Button disabled={!!updates.run} onClick={() => updates.show(chosen.map(row => row.id))}>Update selected ({chosen.length})</Button> : undefined}>
        {!peers.length ? <EmptyState title="No paired machines" /> : <Card>{peers.map(row => <Row key={row.id} title={row.name}
          meta={<>{downloads[row.id] ? [downloads[row.id].source, downloadLabel(downloads[row.id])].filter(Boolean).join(' · ')
            : row.skipped ?? ['Ready to update', row.source].filter(Boolean).join(' · ')}<span>{row.running} running turns</span></>}
          trailing={<><Badge>{row.current}</Badge>{!row.skipped && <label className="k-inline"><span>Also update {row.name}</span>
            <Switch label={`Also update ${row.name}`} checked={selected.includes(row.id)} onChange={checked => setSelected(ids => checked ? [...ids, row.id] : ids.filter(id => id !== row.id))} />
          </label>}</>} />)}</Card>}
      </Section>
    </>}
  </div>;
}
