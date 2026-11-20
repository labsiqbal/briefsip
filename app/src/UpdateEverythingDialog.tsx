// Adapted from T3 UpdateEverythingDialog.tsx (MIT). See app/t3/provenance.json.
import { ArrowRight } from 'lucide-react';
import { Alert, Badge, Button, Dialog, SkeletonRows } from './ui/kit';
import { describeUpdateCapsule, describeUpdateEverything, downloadLabel, phases, type RunMachine } from './updateEverything.logic';
import { SidebarUpdateReleaseNotes } from './SidebarUpdateReleaseNotes';
import type { UpdateEverythingState } from './hooks/useUpdateEverything';

export function UpdateEverythingDialog({ updates }: { updates: UpdateEverythingState }) {
  const { run, active, reconnecting, error, storageError, state, downloads } = updates;
  const rows = run?.rows ?? updates.plan;
  const { count, version, warning } = describeUpdateEverything(rows);
  const result = describeUpdateCapsule(run, reconnecting);
  const source = rows.find(row => !row.skipped)?.source;
  const release = [state?.available, state?.github, state?.feed].find(item => item?.version === version && item?.source === source);
  const title = storageError && !run ? 'Update recovery' : run
    ? active ? `Updating ${count} ${count === 1 ? 'machine' : 'machines'}` : result.attention ? 'Update results' : 'Update complete'
    : updates.planning || !count ? 'Update machines' : `Update ${count} ${count === 1 ? 'machine' : 'machines'}?`;
  return <Dialog open={updates.open} onOpenChange={open => { if (!open) updates.dismiss(); }}
    title={title} description={version ? [`Minarbot ${version}`, source].filter(Boolean).join(' · ') : undefined} size="lg"
    onCloseAutoFocus={event => {
      if (document.activeElement === document.body && !updates.ready && !active) {
        const fallback = document.querySelector<HTMLButtonElement>('.sidebar-settings, .sidebar-reveal');
        if (fallback) { event.preventDefault(); fallback.focus(); }
      }
    }}
    footer={<>
      {!run && !updates.planning && count > 0 && <span className="k-dialog__foot-note updates-warning">{warning}</span>}
      <Button onClick={updates.dismiss}>{run ? 'Close' : 'Cancel'}</Button>
      {!run && <Button variant="primary" disabled={updates.planning || !count || reconnecting || !!error || !!storageError} onClick={() => updates.start(updates.plan)}>Update</Button>}
    </>}>
    <div className="k-stack">
      {storageError && <Alert tone="error" actions={!run ? <Button size="sm" onClick={updates.discardRecovery}>Discard saved update</Button> : undefined}>{storageError}</Alert>}
      {reconnecting && <p role="status" className="k-field__hint">Reconnecting…</p>}
      {error && <Alert tone="error">{error}</Alert>}
      {run && <p className="sr-only" role="status">{result.label}</p>}
      {!run && updates.planning ? <SkeletonRows /> : rows.length > 0 ? <div className="k-table-wrap">
        <table className="k-table updates-table">
          <thead><tr><th scope="col">Machine</th><th scope="col">Minarbot</th><th scope="col">Running turns</th></tr></thead>
          <tbody>{rows.map(row => {
            const status = (row as Partial<RunMachine>).status;
            const reason = (row as Partial<RunMachine>).reason;
            const download = downloads[row.id];
            const failed = status === 'failed' || status === 'rolled-back' || status === 'unconfirmed';
            return <tr key={row.id}>
              <th scope="row"><span>{row.name}</span>{row.local && <small>Connected server</small>}</th>
              <td>
                <span className="updates-version">{row.current}{row.target && <><ArrowRight size={13} aria-label="to" />{row.target}</>}</span>
                {row.skipped ? <small>{row.skipped}</small> : status && <div className="updates-result">
                  <Badge tone={failed ? 'warn' : status === 'done' ? 'success' : 'neutral'}>{download ? downloadLabel(download) : phases[status] ?? status}</Badge>
                  {download?.source && <small>{download.source}</small>}
                  {reason && <small>{reason}</small>}
                </div>}
              </td>
              <td>{row.running}</td>
            </tr>;
          })}</tbody>
        </table>
      </div> : !state && !storageError && <SkeletonRows />}
      {!run && <SidebarUpdateReleaseNotes release={release} />}
    </div>
  </Dialog>;
}
