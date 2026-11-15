import { useCallback, useEffect, useRef } from 'react';

export function createFrameQueue() {
  const pending = new Set<number>();
  return {
    schedule(callback: () => void) {
      const frame = requestAnimationFrame(() => { pending.delete(frame); callback(); });
      pending.add(frame);
    },
    cancel() { for (const frame of pending) cancelAnimationFrame(frame); pending.clear(); },
  };
}

export function useNextFrame() {
  const queue = useRef<ReturnType<typeof createFrameQueue> | null>(null);
  useEffect(() => {
    const next = createFrameQueue(); queue.current = next;
    return () => { next.cancel(); queue.current = null; };
  }, []);
  return useCallback((callback: () => void) => queue.current?.schedule(callback), []);
}
