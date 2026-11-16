import { useLayoutEffect, useRef } from 'react';
import { routePath, type AppRoute } from '../navigation';

export function useRoutePresentation(route: AppRoute, title: string | undefined, selectTab?: (tab: 'agents' | 'projects') => void) {
  const destination = routePath({ ...route, settings: undefined });
  const previous = useRef(destination);
  useLayoutEffect(() => { document.title = title ? `${title} - Briefsip` : 'Briefsip'; }, [title]);
  useLayoutEffect(() => {
    if (route.room || route.project) selectTab?.('projects');
    else if (previous.current !== '/' && destination !== previous.current && (route.agent || route.machine)) selectTab?.('agents');
    previous.current = destination;
  }, [destination, route.room, route.project, route.agent, route.machine, selectTab]);
}
