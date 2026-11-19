// Adapted from T3 SidebarUpdateCapsule.tsx (MIT). See app/t3/provenance.json.
import { ArrowDownToLine, CircleAlert, Check } from 'lucide-react';
import { Button } from './ui/kit';
import { describeUpdateCapsule, runActive } from './updateEverything.logic';
import type { UpdateEverythingState } from './hooks/useUpdateEverything';

export function SidebarUpdateCapsule({ updates }: { updates: UpdateEverythingState }) {
  if (!updates.ready && !updates.run) return null;
  const { label, attention } = describeUpdateCapsule(updates.run, updates.reconnecting);
  const Icon = attention || updates.storageError ? CircleAlert : updates.run && !runActive(updates.run) ? Check : ArrowDownToLine;
  return <div className="sidebar-update">
    <Button className="sidebar-update__capsule" variant="secondary" aria-haspopup="dialog"
      icon={<Icon size={15} aria-hidden />} onClick={() => updates.show()}>
      {updates.storageError ? 'Update recovery' : label}
    </Button>
  </div>;
}
