import { useEffect, useRef } from 'react';

export function useMessageChanged(onChanged: () => void) {
  const callback = useRef(onChanged); callback.current = onChanged;
  useEffect(() => {
    const changed = () => callback.current();
    window.addEventListener('minarbot:message-changed', changed);
    return () => window.removeEventListener('minarbot:message-changed', changed);
  }, []);
}
