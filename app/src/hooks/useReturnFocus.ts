import { useEffect, useRef, type RefObject } from 'react';

export function useReturnFocus(trigger: RefObject<HTMLElement | null>, open: boolean) {
  const wasOpen = useRef(open);
  useEffect(() => {
    const frame = wasOpen.current && !open ? requestAnimationFrame(() => trigger.current?.focus()) : undefined;
    wasOpen.current = open;
    return () => { if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [open, trigger]);
}
