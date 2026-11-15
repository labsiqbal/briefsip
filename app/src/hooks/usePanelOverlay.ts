import { useLayoutEffect, useState } from 'react';
import { detailsDockMinWidth } from '../right-panel-state';

export function usePanelOverlay(available: number) {
  const [overlay, setOverlay] = useState(available < detailsDockMinWidth);
  useLayoutEffect(() => {
    const measure = () => {
      if ([...document.querySelectorAll('[role=dialog], [role=alertdialog]')].some(dialog => !dialog.closest('.right-panel-sheet'))) return;
      setOverlay(available < detailsDockMinWidth);
    };
    measure();
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [available]);
  return overlay;
}
