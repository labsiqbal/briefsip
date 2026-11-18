// Adapted from T3 SidebarUpdateReleaseNotes.tsx (MIT). See app/t3/provenance.json.
import type { ReleaseInfo } from '../shared/updates';
import { Collapsible } from './ui/kit';

export function SidebarUpdateReleaseNotes({ release }: { release?: ReleaseInfo }) {
  if (!release?.notes.trim()) return null;
  return <Collapsible title="Release notes">
    <p className="updates-notes">{release.notes}</p>
  </Collapsible>;
}
