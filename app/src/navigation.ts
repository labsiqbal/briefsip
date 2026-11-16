export type SettingsSection = 'general' | 'appearance' | 'providers' | 'skills' | 'connected-apps' | 'hub' | 'mcp' | 'machines' | 'updates' | 'usage' | 'data' | 'backup' | 'mcp-server';
export type AppRoute = { notFound?: boolean; agent?: string; thread?: string; room?: string; project?: string; machine?: string; remoteAgent?: string; view?: 'routines' | 'workflows'; settings?: SettingsSection };
const settings = new Set(['general', 'appearance', 'providers', 'skills', 'connected-apps', 'hub', 'mcp', 'machines', 'updates', 'usage', 'data', 'backup', 'mcp-server']);
const id = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';

export function parseRoute(location: string): AppRoute {
  const [path, query = ''] = location.split('?');
  let match;
  if (path === '/') return {};
  if ((match = /^\/settings\/([^/]+)$/.exec(path)) && settings.has(match[1])) {
    const from = new URLSearchParams(query).get('from') ?? '/';
    return { ...(!from.startsWith('/settings/') && !parseRoute(from).notFound ? parseRoute(from) : {}), settings: match[1] as SettingsSection };
  }
  if ((match = new RegExp(`^/agents/(${id})(?:/conversations/(${id}))?$`, 'i').exec(path))) return { agent: match[1].toLowerCase(), ...(match[2] ? { thread: match[2].toLowerCase() } : {}) };
  if ((match = new RegExp(`^/rooms/(${id})$`, 'i').exec(path))) return { room: match[1].toLowerCase() };
  if ((match = new RegExp(`^/projects/(${id})$`, 'i').exec(path))) return { project: match[1].toLowerCase() };
  if ((match = new RegExp(`^/machines/(${id})/agents/(${id})$`, 'i').exec(path))) return { machine: match[1].toLowerCase(), remoteAgent: match[2].toLowerCase() };
  if (path === '/routines' || path === '/workflows') return { view: path.slice(1) as 'routines' | 'workflows' };
  return { notFound: true };
}

export function routePath(route: AppRoute): string {
  if (route.settings) {
    const from = routePath({ ...route, settings: undefined });
    return `/settings/${route.settings}${from === '/' ? '' : `?${new URLSearchParams({ from })}`}`;
  }
  if (route.view) return `/${route.view}`;
  if (route.machine && route.remoteAgent) return `/machines/${route.machine}/agents/${route.remoteAgent}`;
  if (route.project) return `/projects/${route.project}`;
  if (route.room) return `/rooms/${route.room}`;
  if (route.agent) return `/agents/${route.agent}${route.thread ? `/conversations/${route.thread}` : ''}`;
  return '/';
}
