import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';

test('Rust route inventory stays within Node matchers and reports ported coverage', t => {
  const source = ts.createSourceFile('server.ts', readFileSync(new URL('./server.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const matchers = new Map<string, (path: string) => boolean>();
  const endpoints = new Map<string, (path: string) => boolean>();
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) && /^\/(?:api(?:\/|$)|mcp(?:\/|$))/.test(node.text)) {
      const parent = node.parent;
      const exact = ts.isBinaryExpression(parent)
        && ['===', '=='].includes(parent.operatorToken.getText(source))
        && ['path', 'url.pathname'].includes(parent.left.getText(source));
      const array = ts.isArrayLiteralExpression(parent) && ts.isPropertyAccessExpression(parent.parent) && parent.parent.name.text === 'includes';
      const prefix = ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) && ['startsWith', 'endsWith'].includes(parent.expression.name.text) && parent.expression.expression.getText(source) === 'path';
      const namespace = ['/api', '/api/', '/mcp/'].includes(node.text);
      if ((exact || array || prefix) && !namespace) {
        matchers.set(node.text, path => prefix ? path.startsWith(node.text) : path === node.text);
        if (exact || array) endpoints.set(node.text, path => path === node.text);
      }
    }
    if (ts.isRegularExpressionLiteral(node)) {
      const raw = node.getText(source), end = raw.lastIndexOf('/');
      const pattern = raw.slice(1, end);
      if (pattern.startsWith('^\\/api\\/') || pattern.startsWith('^\\/mcp')) {
        const matcher = new RegExp(pattern, raw.slice(end + 1)); matchers.set(raw, path => matcher.test(path));
        if (pattern.endsWith('$')) endpoints.set(raw, path => matcher.test(path));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const src = new URL('../crates/briefsip-server/src/', import.meta.url);
  const rust = readdirSync(src, { recursive: true }).filter(name => String(name).endsWith('.rs')).map(name => readFileSync(new URL(String(name), src), 'utf8')).join('\n');
  const routes = [...rust.matchAll(/\.route\(\s*"([^"\n]+)"/g)].map(match => match[1]);
  assert(routes.length > 0);
  const id = '00000000-0000-4000-8000-000000000001';
  const ported = new Set<string>();
  for (const route of routes) {
    const witness = route.replace(/\{[^}]+\}/g, id);
    const matches = [...endpoints].filter(([, matcher]) => matcher(witness));
    assert(matches.length > 0, `Rust route absent from Node: ${route}`);
    for (const [name] of matches) ported.add(name);
  }
  assert(![...endpoints.values()].some(matcher => matcher('/api/__inventory_unknown')));
  assert(![...endpoints.values()].some(matcher => matcher(`/api/agents/${id}/__inventory_unknown`)));
  t.diagnostic(`ported ${ported.size}/${matchers.size} (${routes.length} Rust route registrations)`);
  for (const route of routes) t.diagnostic(route);
});
