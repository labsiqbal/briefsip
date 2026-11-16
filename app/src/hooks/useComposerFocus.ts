import { useCallback, useEffect, useRef } from 'react';

export function useComposerFocus() {
  const cancel = useRef<() => void>(() => {});
  useEffect(() => () => cancel.current(), []);
  return useCallback(() => {
    cancel.current();
    const previous = document.querySelector<HTMLTextAreaElement>('.composer__input');
    previous?.focus();
    const focus = () => {
      const composer = document.querySelector<HTMLTextAreaElement>('.composer__input');
      if (!composer || composer === previous) return;
      composer.focus(); cancel.current();
    };
    const observer = new MutationObserver(focus);
    const stop = () => {
      observer.disconnect();
      window.removeEventListener('pointerdown', stop, true);
      window.removeEventListener('keydown', stop, true);
    };
    cancel.current = stop;
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('pointerdown', stop, true);
    window.addEventListener('keydown', stop, true);
  }, []);
}
