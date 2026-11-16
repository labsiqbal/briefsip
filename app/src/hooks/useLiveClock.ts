import { useState } from 'react';
import { usePolling } from './usePolling';

export function useLiveClock(live: boolean) {
  const [now, setNow] = useState(Date.now);
  usePolling(() => { setNow(Date.now()); }, { interval: 200, enabled: live });
  return now;
}
