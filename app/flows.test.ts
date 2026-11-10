import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFlow, readyFlowSteps, type FlowOutcome } from './flows.ts';

test('routine flow graph rejects cycles, foreign agents and disconnected branches', () => {
  const agents = new Set(['a', 'b', 'c', 'd']);
  assert.deepEqual(validateFlow([], 'a', agents), { root: 'a', nodes: ['a'], links: [] });
  const graph = validateFlow([{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }], 'a', agents);
  assert.deepEqual(graph.nodes, ['a', 'b', 'c', 'd']);
  for (const links of [null, [{ from: 'a', to: 'x' }], [{ from: 'a', to: 'a' }], [{ from: 'b', to: 'a' }], [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }], [{ from: 'c', to: 'd' }], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b' }], [{ from: 'a', to: 'b', unexpected: true }]]) assert.throws(() => validateFlow(links, 'a', agents));
  const many = new Set(Array.from({ length: 33 }, (_, i) => String(i)));
  assert.throws(() => validateFlow([...many].slice(1).map(to => ({ from: '0', to })), '0', many), /32/);
});

test('routine flow fan-in waits for every input and settles all-failed branches', () => {
  const graph = validateFlow([{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }], 'a', new Set(['a', 'b', 'c', 'd']));
  const outcomes = new Map<string, FlowOutcome>(graph.nodes.map(node => [node, { status: 'waiting', text: '' }]));
  assert.deepEqual(readyFlowSteps(graph, outcomes), []);
  outcomes.set('a', { status: 'done', text: 'Root result' });
  const first = readyFlowSteps(graph, outcomes);
  assert.deepEqual(first.map(step => step.agent), ['b', 'c']);
  assert(first.every(step => !step.skip && step.inputs[0].text === 'Root result'));
  outcomes.set('b', { status: 'done', text: 'B result' }); outcomes.set('c', { status: 'running', text: '' });
  assert.deepEqual(readyFlowSteps(graph, outcomes), []);
  outcomes.set('c', { status: 'failed', text: 'C failed' });
  assert.deepEqual(readyFlowSteps(graph, outcomes), [{ agent: 'd', skip: false, inputs: [{ agent: 'b', status: 'done', text: 'B result' }, { agent: 'c', status: 'failed', text: 'C failed' }] }]);
  outcomes.set('b', { status: 'failed', text: 'B failed' });
  assert.equal(readyFlowSteps(graph, outcomes)[0].skip, true);
  outcomes.set('d', { status: 'skipped', text: 'No successful input' });
  assert.deepEqual(readyFlowSteps(graph, outcomes), []);
  // Stored graph and outcomes survive serialization without making completed nodes ready again.
  const restored = new Map<string, FlowOutcome>(JSON.parse(JSON.stringify([...outcomes])));
  assert.deepEqual(readyFlowSteps(JSON.parse(JSON.stringify(graph)), restored), []);
});
