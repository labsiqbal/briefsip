import { useEffect, useRef, type RefObject } from 'react';
import { useNextFrame } from './useNextFrame';

export function useReturnFocus(trigger: RefObject<HTMLElement | null>, open: boolean) {
  const wasOpen = useRef(open), nextFrame = useNextFrame();
  useEffect(() => {
    if (wasOpen.current && !open) nextFrame(() => { if (!wasOpen.current) trigger.current?.focus(); });
    wasOpen.current = open;
  }, [open, trigger, nextFrame]);
}
