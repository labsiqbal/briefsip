import { restoreDetailsOpen } from '../right-panel-state';
import { useEffect, useState, type ReactNode } from 'react';

const detailsKey = 'briefsip:details-open';
const detailsEvent = 'briefsip:details-open';

/** Whether the right-hand details panel is open. Shared by every conversation and kept per browser. */
export function useDetailsOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      const sidebar = localStorage.getItem('briefsip:sidebar-collapsed') === '1' ? 0 : Math.min(window.innerWidth - 360, Math.max(240, Number(localStorage.getItem('briefsip:sidebar-width')) || 300));
      return restoreDetailsOpen(window.innerWidth, sidebar, localStorage.getItem(detailsKey)); } catch { /* Fall back to the width default. */ }
    return window.innerWidth >= 1280;
  });
  useEffect(() => {
    const sync = (event: Event) => setOpen((event as CustomEvent<boolean>).detail);
    window.addEventListener(detailsEvent, sync);
    return () => window.removeEventListener(detailsEvent, sync);
  }, []);
  return [open, (next: boolean) => {
    try { localStorage.setItem(detailsKey, next ? '1' : '0'); } catch { /* The choice still applies to this page. */ }
    window.dispatchEvent(new CustomEvent(detailsEvent, { detail: next }));
  }];
}

/** Main-column page for forms and directories that predate the chat layout. */
export function PageView({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <main className="chat page-view bs-root"><div className="page-scroll"><div className={`page legacy${wide ? ' is-wide' : ''}`}>{children}</div></div></main>;
}
