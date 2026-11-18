import { validateWorkflow, type WorkflowGraph } from './workflows.ts';

type Workflow = { id: string; agent: string; name: string; revision: number; graph: WorkflowGraph };
export type WorkflowCommand = { path: string; body: Record<string, unknown>; kind: 'save' | 'run' | 'approve' | 'cancel' | 'restore' | 'schedule' | 'retry' | 'webhook' | 'delete'; workflow?: Workflow; autosave?: boolean };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function restoreWorkflowCommand(raw: string | null, owner: string, agents: ReadonlySet<string>): WorkflowCommand | null {
  if (raw === null) return null;
  const command = JSON.parse(raw) as WorkflowCommand;
  if (!command || !['save', 'run', 'approve', 'cancel', 'restore', 'schedule', 'retry', 'webhook', 'delete'].includes(command.kind) || !command.body || typeof command.path !== 'string'
    || typeof command.body.id !== 'string' || !uuid.test(command.body.id) || !Number.isSafeInteger(command.body.revision) || Number(command.body.revision) < 0) throw new Error('Invalid workflow command');
  const workflow = command.workflow;
  if (command.autosave !== undefined && (typeof command.autosave !== 'boolean' || command.kind !== 'save' || !workflow)) throw new Error('Invalid workflow autosave');
  if (workflow) {
    if (!uuid.test(workflow.id) || workflow.agent !== owner || typeof workflow.name !== 'string' || !Number.isSafeInteger(workflow.revision) || workflow.revision < 1) throw new Error('Invalid workflow owner');
    validateWorkflow(workflow.graph, agents);
  }
  if (command.kind === 'save') {
    if (command.path !== (workflow ? `/api/workflows/${workflow.id}/edit` : `/api/agents/${owner}/workflows`)
      || command.body.revision !== (workflow?.revision ?? 0) || typeof command.body.name !== 'string' || !command.body.name.trim() || command.body.name.length > 80) throw new Error('Invalid workflow save');
    validateWorkflow(command.body.graph, agents);
  } else {
    if (!workflow) throw new Error('Missing workflow');
    if (command.kind === 'delete') {
      if (command.path !== `/api/workflows/${workflow.id}/delete` || command.body.revision !== workflow.revision
        || Object.keys(command.body).some(key => !['id', 'revision'].includes(key))) throw new Error('Invalid workflow delete');
    } else if (command.kind === 'webhook') {
      const body = command.body;
      if (command.path !== `/api/workflows/${workflow.id}/webhook` || (body.remove === true
        ? typeof body.route !== 'string' || !uuid.test(body.route) || Number(body.revision) < 1 || Object.keys(body).some(key => !['id', 'revision', 'remove', 'route'].includes(key))
        : typeof body.enabled !== 'boolean' || typeof body.rotate !== 'boolean' || Object.keys(body).some(key => !['id', 'revision', 'enabled', 'rotate'].includes(key)))) throw new Error('Invalid workflow webhook');
    } else if (command.kind === 'schedule') {
      const body = command.body;
      if (command.path !== `/api/workflows/${workflow.id}/schedule` || !Number.isSafeInteger(body.nextAt) || Number(body.nextAt) < 1 || Number(body.nextAt) > 253370764799999
        || (body.intervalSeconds !== null && (!Number.isSafeInteger(body.intervalSeconds) || Number(body.intervalSeconds) < 60 || Number(body.intervalSeconds) > 31536000))
        || typeof body.input !== 'string' || body.input.length > 16000 || typeof body.enabled !== 'boolean') throw new Error('Invalid workflow schedule');
    } else if (command.kind === 'restore') {
      if (command.path !== `/api/workflows/${workflow.id}/restore` || command.body.revision !== workflow.revision || !Number.isSafeInteger(command.body.version) || Number(command.body.version) < 1) throw new Error('Invalid workflow restore');
    } else if (command.kind === 'run') {
      if (command.path !== `/api/workflows/${workflow.id}/run` || command.body.revision !== workflow.revision || typeof command.body.input !== 'string' || command.body.input.length > 16000) throw new Error('Invalid workflow run');
    } else {
      const parts = command.path.split('/');
      if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'workflow-runs' || !uuid.test(parts[3]) || parts[4] !== command.kind
        || (command.kind === 'approve' && typeof command.body.accepted !== 'boolean')) throw new Error('Invalid workflow action');
    }
  }
  return command;
}
