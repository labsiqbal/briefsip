import { useEffect, useRef, useState, type SetStateAction } from 'react';
import { parseRoute, routePath, type AppRoute } from '../../navigation';

export function useAppRoute() {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname + window.location.search));
  const current = useRef(route);
  useEffect(() => {
    const pop = () => { current.current = parseRoute(window.location.pathname + window.location.search); setRoute(current.current); };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  const navigate = (next: SetStateAction<AppRoute>, replace = false) => {
    const value = typeof next === 'function' ? next(current.current) : next;
    const path = routePath(value);
    if (path !== window.location.pathname + window.location.search) window.history[replace ? 'replaceState' : 'pushState'](null, '', path);
    current.current = value; setRoute(value);
  };
  return { route, navigate };
}

export function useRouteFallback(invalid: boolean, fallback: AppRoute, navigate: (route: AppRoute, replace: boolean) => void) {
  useEffect(() => { if (invalid && routePath(fallback) !== window.location.pathname + window.location.search) navigate(fallback, true); });
}
