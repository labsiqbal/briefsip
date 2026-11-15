import { useEffect, useRef, useState } from 'react';
import { usePolling } from './usePolling';

export function useVisiblePolling(load: (current: () => boolean) => Promise<void>, interval = 5000) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false), [focus, setFocus] = useState(0);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting ?? false));
    if (ref.current) observer.observe(ref.current);
    const resume = () => setFocus(value => value + 1);
    window.addEventListener('focus', resume);
    return () => { observer.disconnect(); window.removeEventListener('focus', resume); };
  }, []);
  usePolling(signal => load(() => !signal.aborted && !document.hidden), { interval, enabled: visible }, [load, focus]);
  return ref;
}
