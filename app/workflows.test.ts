import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow, workflowTransition } from './workflows.ts';
import { restoreWorkflowCommand } from './workflow-command.ts';
import { randomUUID } from 'node:crypto';

test('model condition validation requires model and question and parses only yes/no', () => {
  const node = { id: 'check', kind: 'condition', operator: 'model', model: 'fixture', value: 'Accept?', yes: 'out', no: 'out' };
  const graph = { entry: 'check', maxSteps: 2, nodes: [node, { id: 'out', kind: 'output' }] };
  const validated = validateWorkflow(graph, new Set());
  assert.equal(workflowTransition(validated.nodes[0], ' YES\n'), 'out');
  assert.equal(workflowTransition(validated.nodes[0], 'no'), 'out');
  assert.throws(() => workflowTransition(validated.nodes[0], 'yes because it matches'), /yes atau no/);
  for (const patch of [{ model: '' }, { value: '' }, { next: 'out' }]) assert.throws(() => validateWorkflow({ ...graph, nodes: [{ ...node, ...patch }, graph.nodes[1]] }, new Set()));
});

test('workflow graphs validate explicit approval, bounded loops and terminal paths', () => {
  const input = { entry: 'draft', maxSteps: 12, nodes: [
    { id: 'draft', kind: 'agent', agent: 'a', prompt: 'Draft', next: 'review' },
    { id: 'review', kind: 'approval', prompt: 'Accept draft?', yes: 'check', no: 'draft' },
    { id: 'check', kind: 'condition', operator: 'equals', value: 'ready', yes: 'done', no: 'revise' },
    { id: 'revise', kind: 'model', model: 'fixture', prompt: 'Revise', next: 'review' },
    { id: 'done', kind: 'output' },
  ] };
  const agents = new Set(['a']), graph = validateWorkflow(input, agents);
  assert.deepEqual(graph, input);
  assert.throws(() => workflowTransition(graph.nodes[1], 'yes'), /eksplisit/);
  assert.equal(workflowTransition(graph.nodes[1], 'irrelevant', false), 'draft');
  assert.equal(workflowTransition(graph.nodes[1], 'irrelevant', true), 'check');
  assert.equal(workflowTransition(graph.nodes[2], 'ready'), 'done');
  assert.equal(workflowTransition(graph.nodes[2], 'not ready'), 'revise');
  assert.equal(workflowTransition(graph.nodes[4], 'saved'), null);
  for (const bad of [
    { ...input, maxSteps: 0 }, { ...input, maxSteps: 1001 }, { ...input, maxSteps: 1.5 },
    { ...input, extra: true }, { ...input, entry: 'missing' },
    { ...input, nodes: [...input.nodes, input.nodes[0]] },
    { ...input, nodes: [...input.nodes, { id: 'orphan', kind: 'output' }] },
    { ...input, nodes: [{ id: 'forever', kind: 'agent', agent: 'a', prompt: 'Loop', next: 'forever' }], entry: 'forever' },
    { ...input, nodes: [{ id: 'script', kind: 'shell', command: 'anything' }], entry: 'script' },
  ]) assert.throws(() => validateWorkflow(bad, agents));
  assert.throws(() => validateWorkflow(input, new Set()));
  assert.throws(() => validateWorkflow({ ...input, nodes: [{ ...input.nodes[0], next: 'missing' }, ...input.nodes.slice(1)] }, agents));
  assert.equal(workflowTransition({ id: 'c', kind: 'condition', operator: 'contains', value: 'A', yes: 'yes', no: 'no' }, 'DATA'), 'yes');
  assert.equal(workflowTransition({ id: 'c', kind: 'condition', operator: 'contains', value: 'a', yes: 'yes', no: 'no' }, 'DATA'), 'no');
});
test('workflow recovery rejects malformed commands and preserves valid retry identity', () => {
  const owner = randomUUID(), agents = new Set([owner]);
  const workflow = { id: randomUUID(), agent: owner, name: 'Saved', revision: 1, graph: { entry: 'out', maxSteps: 1, nodes: [{ id: 'out', kind: 'output' }] } };
  const run = { kind: 'run', workflow, path: `/api/workflows/${workflow.id}/run`, body: { id: randomUUID(), revision: 1, input: 'marker' } };
  const save = { kind: 'save', path: `/api/agents/${owner}/workflows`, body: { id: randomUUID(), revision: 0, name: 'New', graph: workflow.graph } };
  const approve = { kind: 'approve', workflow, path: `/api/workflow-runs/${randomUUID()}/approve`, body: { id: randomUUID(), revision: 2, accepted: true } };
  const restore = { kind: 'restore', workflow, path: `/api/workflows/${workflow.id}/restore`, body: { id: randomUUID(), revision: 1, version: 1 } };
  const schedule = { kind: 'schedule', workflow, path: `/api/workflows/${workflow.id}/schedule`, body: { id: randomUUID(), revision: 0, nextAt: Date.now(), intervalSeconds: null, input: 'scheduled', enabled: false } };
  for (const command of [run, save, approve, restore, schedule]) assert.deepEqual(restoreWorkflowCommand(JSON.stringify(command), owner, agents), command);
  assert.equal(restoreWorkflowCommand(null, owner, agents), null);
  for (const command of [{ kind: 'run' }, { kind: 'save', path: '/api/agents/x/workflows', body: { id: 'x', name: 'bad', graph: {} } },
    { ...save, body: { ...save.body, graph: {} } }, { ...run, workflow: { ...workflow, agent: randomUUID() } },
    { ...run, path: '/api/agents' }, { ...approve, body: { ...approve.body, accepted: 'yes' } },
    { ...run, body: { ...run.body, revision: -1 } }, { ...run, workflow: { ...workflow, graph: {} } }, { ...restore, body: { ...restore.body, version: '1' } },
    { ...schedule, body: { ...schedule.body, nextAt: 253370764800000 } }, { ...schedule, body: { ...schedule.body, intervalSeconds: 1 } }, { ...schedule, body: { ...schedule.body, enabled: 'yes' } }]) {
    assert.throws(() => restoreWorkflowCommand(JSON.stringify(command), owner, agents));
  }
});
