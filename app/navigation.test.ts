import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, routePath, type AppRoute } from './src/navigation.ts';
const agent = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';

test('routes round-trip agents, conversations, rooms, projects and settings return location', () => {
  const routes: AppRoute[] = [{}, { agent }, { agent, thread: other }, { room: other }, { project: other }, { view: 'routines' }, { view: 'workflows' }, { machine: other, remoteAgent: agent }];
  for (const route of routes) {
    assert.deepEqual(parseRoute(routePath(route)), route);
    assert.deepEqual(parseRoute(routePath({ ...route, settings: 'appearance' })), { ...route, settings: 'appearance' });
  }
});
test('malformed and external deep links show not found without throwing or retaining untrusted paths', () => {
  for (const path of ['/missing', '/agents/deleted', '/rooms/%ZZ', '/projects/../x', '//example.test', '/settings/nope', '/settings/general?from=https%3A%2F%2Fexample.test', '/settings/general?from=%2Fsettings%2Fgeneral']) {
    const parsed = parseRoute(path);
    assert.deepEqual(parsed, path.startsWith('/settings/general') ? { settings: 'general' } : { notFound: true });
    assert(!routePath(parsed).includes('example.test'));
  }
});

test('result links round-trip file and URL views without losing conversation routes', () => {
  for (const route of [{ agent }, { agent, thread: other }, { room: other }, { machine: other, remoteAgent: agent }]) {
    for (const result of [{ view: 'file' as const, path: `/api/agents/${agent}/panel/files/${other}`, name: 'Report.html' }, { view: 'computer' as const, agent, path: 'https://example.test/', name: 'Browser result' }, { view: 'url' as const, path: 'https://example.test/?a=1&b=2#part', name: 'Report' }]) {
      assert.deepEqual(parseRoute(routePath({ ...route, result })), { ...route, result });
    }
  }
  for (const result of [{ view: 'file', path: '/api/backup', name: 'Backup' }, { view: 'url', path: 'javascript:alert(1)', name: 'Bad' }, { view: 'url', path: 'https://user:pass@example.test/', name: 'Bad' }]) {
    assert(parseRoute(`/agents/${agent}?${new URLSearchParams({ result: JSON.stringify(result) })}`).notFound);
  }
});
