// Adapted from T3 SidebarUpdateCapsule.tsx (MIT). See app/t3/provenance.json.
import { ArrowDownToLine, CircleAlert, Check } from 'lucide-react';
import { Button } from './ui/kit';
import { describeUpdateCapsule, downloadLabel, runActive } from './updateEverything.logic';
import type { UpdateEverythingState } from './hooks/useUpdateEverything';

export function SidebarUpdateCapsule({ updates }: { updates: UpdateEverythingState }) {
  const downloads = Object.values(updates.downloads);
  if (!updates.ready && !updates.run && !downloads.length) return null;
  const { label, attention } = describeUpdateCapsule(updates.run, updates.reconnecting);
  const progress = downloads.length ? downloadLabel({
    bytesTransferred: downloads.reduce((sum, item) => sum + (item.bytesTransferred ?? 0), 0),
    totalBytes: downloads.reduce((sum, item) => sum + (item.totalBytes ?? 0), 0),
  }) : null;
  const source = downloads.length ? downloads.every(item => item.source === downloads[0].source) && downloads[0].source
    : !updates.run && updates.rows.find(row => !row.skipped)?.source;
  const Icon = attention || updates.storageError ? CircleAlert : updates.run && !runActive(updates.run) ? Check : ArrowDownToLine;
  return <div className="sidebar-update">
    <Button className="sidebar-update__capsule" variant="secondary" aria-haspopup="dialog"
      icon={<Icon size={15} aria-hidden />} onClick={() => updates.show()}>
      <span className="sidebar-update__text">
        <span>{updates.storageError ? 'Update recovery' : (updates.reconnecting ? null : progress) ?? label}</span>
        {source && !updates.storageError && <small>{source}</small>}
      </span>
    </Button>
  </div>;
}
