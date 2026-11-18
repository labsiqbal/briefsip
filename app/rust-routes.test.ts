import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

type Matcher = { kind: 'exact' | 'prefix' | 'regex' | 'regex-exact'; pattern: string; flags?: string; endpoint?: boolean };
type Inventory = { matchers: Matcher[]; publicMatchers: { pattern: string; flags?: string; endpoint?: boolean }[] };
const inventory = JSON.parse(readFileSync(new URL('./fixtures/pre-cutover-routes.json', import.meta.url), 'utf8')) as Inventory;
const nativeRoutes = new Set(['/api/restore/reconcile']);
const matcher = (entry: Matcher) => {
  if (entry.kind === 'exact') return (path: string) => path === entry.pattern;
  if (entry.kind === 'prefix') return (path: string) => path.startsWith(entry.pattern);
  const expression = new RegExp(entry.pattern, entry.flags);
  return (path: string) => expression.test(path);
};

test('Rust route inventory covers frozen pre-cutover matchers and native additions', t => {
  const matchers = new Map(inventory.matchers.map(entry => [entry.kind.startsWith('regex') ? `/${entry.pattern}/${entry.flags ?? ''}` : entry.pattern, matcher(entry)]));
  const endpoints = new Map(inventory.matchers.filter(entry => entry.endpoint === true).map(entry => [entry.kind.startsWith('regex') ? `/${entry.pattern}/${entry.flags ?? ''}` : entry.pattern, matcher(entry)]));
  const publicMatchers = inventory.publicMatchers.map(entry => new RegExp(entry.pattern, entry.flags));
  const src = new URL('../crates/briefsip-server/src/', import.meta.url);
  const rust = readdirSync(src, { recursive: true }).filter(name => String(name).endsWith('.rs')).map(name => readFileSync(new URL(String(name), src), 'utf8')).join('\n');
  const routes = [...rust.matchAll(/\.route\(\s*"([^"\n]+)"/g)].map(match => match[1]);
  assert(routes.length > 0);
  const duplicates = routes.filter((route, index) => routes.indexOf(route) !== index);
  assert.deepEqual(duplicates, [], `Rust routes registered twice: ${duplicates.join(', ')}`);
  const id = '00000000-0000-4000-8000-000000000001';
  const ported = new Set<string>();
  assert([...nativeRoutes].every(route => routes.includes(route)));
  for (const route of routes) {
    if (nativeRoutes.has(route)) continue;
    const witness = route.replace(/\{seq\}/g, '1').replace(/\{[^}]+\}/g, id);
    if (!/^\/(?:api(?:\/|$)|mcp(?:\/|$))/.test(route)) {
      assert(publicMatchers.some(publicMatcher => publicMatcher.test(witness)), `Rust public route absent from the route inventory: ${route}`);
      continue;
    }
    const environment = witness.replace(/^\/api\/projects\/[^/]+(\/environment(?:\/(?:remove|settings))?)$/, '/api$1');
    const matches = [...endpoints].filter(([, testMatcher]) => testMatcher(witness) || testMatcher(environment));
    assert(matches.length > 0, `Rust route absent from the route inventory: ${route}`);
    for (const [name] of matches) ported.add(name);
  }
  const witnesses = routes.map(route => route.replace(/\{seq\}/g, '1').replace(/\{[^}]+\}/g, id));
  for (const [name, testMatcher] of matchers) if (!endpoints.has(name) && witnesses.some(witness => testMatcher(witness))) ported.add(name);
  assert(![...endpoints.values()].some(testMatcher => testMatcher('/api/__inventory_unknown')));
  assert(![...endpoints.values()].some(testMatcher => testMatcher(`/api/agents/${id}/__inventory_unknown`)));
  assert.equal(matchers.size, 206);
  assert.equal(ported.size, 206);
  t.diagnostic(`ported ${ported.size}/${matchers.size} (${routes.length} Rust route registrations)`);
  for (const name of matchers.keys()) if (!ported.has(name)) t.diagnostic(`missing ${name}`);
  for (const route of routes) t.diagnostic(route);
});
