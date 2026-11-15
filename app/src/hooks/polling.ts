export type Poll = (signal: AbortSignal) => Promise<void | number> | void | number;
export type PollingOptions = { interval: number; enabled?: boolean; immediate?: boolean; backoff?: boolean };
type Flight = { current: Promise<void | number> | null };

export function startPolling(fn: Poll, { interval, enabled = true, immediate = true, backoff = false }: PollingOptions, visibility: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document, flight: Flight = { current: null }) {
  if (!Number.isFinite(interval) || interval <= 0) throw new RangeError('Polling interval must be positive and finite.');
  const controller = new AbortController(), { signal } = controller;
  let timer: ReturnType<typeof setTimeout> | undefined, running = false, failures = 0;
  function schedule(delay: number) {
    if (!signal.aborted && !visibility.hidden) timer = setTimeout(() => void run(), delay);
  }
  async function run() {
    if (signal.aborted || visibility.hidden || running) return;
    running = true;
    let delay = interval;
    try {
      while (flight.current) await flight.current.catch(() => {});
      if (signal.aborted || visibility.hidden) return;
      const pending = Promise.resolve().then(() => signal.aborted || visibility.hidden ? undefined : fn(signal));
      flight.current = pending;
      try {
        const next = await pending;
        if (typeof next === 'number' && Number.isFinite(next) && next > 0) delay = next;
        failures = 0;
      } finally { if (flight.current === pending) flight.current = null; }
    } catch {
      failures++;
      if (backoff) delay = Math.min(interval * 2 ** Math.min(failures, 5), Math.max(interval, 60000));
    } finally {
      running = false;
      schedule(delay);
    }
  }
  function changed() {
    clearTimeout(timer);
    if (!visibility.hidden) void run();
  }
  if (enabled) {
    visibility.addEventListener('visibilitychange', changed);
    globalThis.window?.addEventListener('focus', changed);
    if (immediate) void run(); else schedule(interval);
  }
  return () => {
    controller.abort();
    clearTimeout(timer);
    visibility.removeEventListener('visibilitychange', changed);
    globalThis.window?.removeEventListener('focus', changed);
  };
}
