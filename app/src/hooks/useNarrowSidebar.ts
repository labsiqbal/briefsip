// Breakpoint subscription adapted from T3 useMediaQuery (MIT); app/t3/provenance.json.
import { useEffect, useSyncExternalStore } from 'react';

const query = '(max-width: 767px)';
const subscribe = (changed: () => void) => {
  const media = window.matchMedia(query);
  media.addEventListener('change', changed);
  return () => media.removeEventListener('change', changed);
};
export function useNarrowSidebar() {
  const narrow = useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
  useEffect(() => { if (narrow) window.dispatchEvent(new CustomEvent('briefsip:details-open', { detail: false })); }, [narrow]);
  return narrow;
}
