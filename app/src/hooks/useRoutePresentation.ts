import { useLayoutEffect, useRef } from 'react';
import { routePath, type AppRoute } from '../navigation';

export function useRoutePresentation(route: AppRoute, title: string | undefined, selectTab?: (tab: 'agents' | 'projects') => void, attentionCount = 0) {
  const destination = routePath({ ...route, settings: undefined });
  const previous = useRef<string | undefined>(undefined);
  useLayoutEffect(() => { document.title = `${attentionCount ? `(${attentionCount}) ` : ''}${title ? `${title} - Minarbot` : 'Minarbot'}`; }, [title, attentionCount]);
  useLayoutEffect(() => {
    if (destination === previous.current) return;
    if (route.room || route.project) selectTab?.('projects');
    else if (route.agent || route.machine) selectTab?.('agents');
    previous.current = destination;
  }, [destination, route.room, route.project, route.agent, route.machine, selectTab]);
}
