import { useEffect, useState } from 'react';
import { parseRoute, routePath, resultTarget, type ResultTarget } from '../../navigation.ts';

export function navigateResult(result?: ResultTarget) {
  const route = parseRoute(window.location.pathname + window.location.search);
  const path = routePath({ ...route, result: resultTarget(result) ?? undefined });
  if (path === window.location.pathname + window.location.search) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
export function useResultRoute() {
  const [, refresh] = useState(0);
  useEffect(() => {
    const sync = () => refresh(version => version + 1);
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  return parseRoute(window.location.pathname + window.location.search).result;
}
