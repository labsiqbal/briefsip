import { useEffect, useRef, type DependencyList } from 'react';
import { startPolling, type Poll, type PollingOptions } from './polling.ts';

export function usePolling(fn: Poll, { interval, enabled = true, immediate = true, backoff = false }: PollingOptions, dependencies: DependencyList = []) {
  const callback = useRef(fn), flight = useRef<Promise<void | number> | null>(null);
  useEffect(() => { callback.current = fn; });
  useEffect(() => startPolling(signal => callback.current(signal), { interval, enabled, immediate, backoff }, document, flight), [interval, enabled, immediate, backoff, ...dependencies]);
}
