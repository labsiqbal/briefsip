import { ChevronDown, MessageSquare, Wrench } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge } from './kit';
import { Collapsible as Disclosure } from 'radix-ui';
import { useLiveClock } from '../hooks/useLiveClock';
import { Markdown } from '../Markdown';
import type { StreamPartial } from '../../turn-stream';
import { activityLabel, liveTurn, streamWork, toolTitle, type TurnActivityData } from './transcript';

type Props = {
  logOnly?: boolean; actions?: ReactNode;
  scope?: string;
  turn: {
    partial?: StreamPartial | null;
    room?: { quiet: { name: string; silent: string }[] } | null; status: string; paused: number; created: string; routing?: string | null; recipient?: string | null; agent_name?: string;
    coordination?: { kind: string; child: string | null; owner_name: string; target_name: string }[];
    agentMessages?: { id: string; name: string; status: string; settled: number; expects_reply: number; taskId?: string; task?: string; wait?: boolean; agent?: string; thread?: string }[];
    receivedAgentReplies?: { id: string; name: string; status: string }[];
    events?: { id: string; event: string; status: string }[];
    questions?: { id: string; prompt: string; answer: string | null }[];
    activity?: TurnActivityData & { checkpoints?: { turn: string; state: string }[] };
    generatedFiles?: { id: string; name: string }[];
  };
  agentName: string;
  remote?: boolean;
  onOpenTask: (id: string) => void;
  onOpenAgent?: (agent: string, thread: string) => void;
};

export function TurnActivity({ turn, agentName, onOpenTask, onOpenAgent, remote, logOnly, actions: controls, scope = '' }: Props) {
  const live = liveTurn(turn), now = useLiveClock(live);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!live) setOpen(false); }, [live]);
  const steps: { id: string; text: string; prose?: boolean; task?: string | null }[] = [];
  const streamedTools = new Set<string>();
  for (const segment of streamWork(turn)) {
    const id = `${segment.seq}:${segment.id}`;
    if (segment.kind === 'text') steps.push({ id, text: segment.text, prose: true });
    else {
      const toolId = segment.id.slice(5); streamedTools.add(toolId);
      const native = turn.activity?.harness?.find(tool => tool.id === toolId);
      const tool = turn.activity?.tools.find(tool => tool.id === toolId);
      steps.push({ id, text: `${tool?.title ?? toolTitle(tool?.name ?? native?.name ?? segment.text)}${native ? ` · ${native.state}` : tool?.failed ? ' · Failed' : !tool && segment.state !== 'done' ? ` · ${segment.state}` : ''}` });
    }
  }
  for (const item of turn.room?.quiet ?? []) steps.push({ id: `quiet-${item.name}`, text: `${item.name} stayed quiet${item.silent === 'not_mentioned' ? ' (not mentioned)' : ''}` });
  if (!turn.room && (turn.routing || turn.recipient)) steps.push({ id: 'routing', text: turn.routing === 'pending' ? 'Selecting recipient' : turn.routing === 'clarify' ? 'Requested routing clarification' : turn.routing === 'none' ? 'No task needed' : turn.routing === 'released' ? 'Waiting for an available recipient' : `Recipient selected: ${turn.agent_name ?? agentName}` });
  for (const step of turn.activity?.harness ?? []) if (!streamedTools.has(step.id)) steps.push({ id: `harness-${step.id}`, text: `${toolTitle(step.name)} · ${step.state}` });
  for (const link of (turn.activity?.dispatch ?? []).filter(link => link.mode === 'steer')) steps.push({ id: `dispatch-${link.target_turn}`, text: 'Guidance linked to running turn', task: link.source_turn });
  const actions = turn.coordination ?? [];
  const tools = turn.activity?.tools ?? [];
  for (let index = 0; index <= actions.length; index++) {
    for (const tool of tools.filter(tool => tool.after_action === index && !streamedTools.has(tool.id))) steps.push({ id: `tool-${tool.id}`, text: `${tool.title ?? toolTitle(tool.name)}${tool.failed ? ' · Failed' : ''}` });
    const action = actions[index];
    if (action) steps.push({ id: `coordination-${index}`, text: `${action.owner_name} ${action.kind === 'delegate_task' ? 'delegated to' : 'transferred to'} ${action.target_name}`, task: action.child });
  }
  for (const item of turn.agentMessages ?? []) steps.push({ id: `message-${item.id}`, text: item.taskId ? `Delegated to ${item.name}: ${item.task?.slice(0, 160) ?? 'Task'}${(item.task?.length ?? 0) > 160 ? '…' : ''}` : `Message to ${item.name} · ${item.settled ? item.status : item.expects_reply ? 'Waiting for reply' : 'No reply requested'}`, task: item.taskId ?? null });
  for (const item of turn.receivedAgentReplies ?? []) steps.push({ id: `received-${item.id}`, text: `Result received from ${item.name} · ${item.status}` });
  for (const event of turn.events ?? []) steps.push({ id: `event-${event.id}`, text: `Event ${event.event} · ${event.status}` });
  for (const question of turn.questions ?? []) steps.push({ id: `question-${question.id}`, text: `${question.answer === null ? 'Asked' : 'Answered'}: ${question.prompt}` });
  for (const checkpoint of turn.activity?.checkpoints ?? []) steps.push({ id: `checkpoint-${checkpoint.turn}`, text: checkpoint.state === 'done' ? 'Git checkpoint captured' : `Git checkpoint ${checkpoint.state}` });
  if (turn.activity?.budget_stopped) steps.push({ id: 'budget', text: `Stopped after ${turn.activity.budget_stopped} tool steps` });
  if (turn.activity?.fallback_model) steps.push({ id: 'fallback', text: `Fallback model used: ${turn.activity.fallback_model}` });
  const contents = <>
      {steps.length ? <ol className="activity-list" aria-label="Turn activity">{steps.map(step => { const item = (turn.agentMessages ?? []).find(row => row.taskId === step.task); return <li key={step.id}>{step.prose ? <MessageSquare className="activity-step-icon" aria-hidden /> : <Wrench className="activity-step-icon" aria-hidden />}{step.prose ? <div className="legacy"><Markdown text={step.text} scope={scope} origin={window.location.origin} /></div> : <span>{step.text}</span>}{item?.taskId && <Badge tone={['done'].includes(item.status) ? 'success' : ['failed','cancelled','uncertain'].includes(item.status) ? 'warn' : 'brand'}>{item.status === 'queued' && item.wait ? 'Waiting' : item.status.charAt(0).toUpperCase() + item.status.slice(1)}</Badge>}{step.task && <button type="button" className="link-btn link-btn--small" onClick={() => item?.agent && item.thread ? onOpenAgent?.(item.agent, item.thread) : onOpenTask(step.task!)}>{item ? 'Open conversation' : 'View subtask'}</button>}</li>; })}</ol> : null}
  </>;
  if (logOnly) return <div className="turn-activity-log">{contents}</div>;
  return <Disclosure.Root className="turn-activity" open={open} onOpenChange={setOpen}><div className="turn-activity__header"><Disclosure.Trigger className="k-collapsible__trigger"><span className="activity-label">{live && turn.status === 'running' && <span className="activity-working" aria-hidden />}{activityLabel(turn, now)}</span><ChevronDown size={14} aria-hidden className="k-collapsible__chev" /></Disclosure.Trigger>{controls}</div><Disclosure.Content className="k-collapsible__content">{contents}</Disclosure.Content></Disclosure.Root>;
}
