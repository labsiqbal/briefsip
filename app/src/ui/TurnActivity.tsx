import { useEffect, useState } from 'react';
import { Badge, Collapsible } from './kit';
import { activityLabel, liveTurn, type TurnActivityData } from './transcript';

type Props = {
  turn: {
    status: string; paused: number; created: string; routing?: string | null; recipient?: string | null; agent_name?: string;
    coordination?: { kind: string; child: string | null; owner_name: string; target_name: string }[];
    agentMessages?: { id: string; name: string; status: string; settled: number; expects_reply: number; taskId?: string; task?: string; wait?: boolean; agent?: string; thread?: string }[];
    receivedAgentReplies?: { id: string; name: string; status: string }[];
    events?: { id: string; event: string; status: string }[];
    questions?: { id: string; prompt: string; answer: string | null }[];
    activity?: TurnActivityData & { checkpoints?: { turn: string; state: string }[] };
    generatedFiles?: { id: string; name: string }[];
  };
  agentName: string;
  onOpenTask: (id: string) => void;
  onOpenAgent?: (agent: string, thread: string) => void;
};

export function TurnActivity({ turn, agentName, onOpenTask, onOpenAgent }: Props) {
  const [now, setNow] = useState(Date.now);
  const live = liveTurn(turn);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const steps: { id: string; text: string; task?: string | null }[] = [];
  if (turn.routing || turn.recipient) steps.push({ id: 'routing', text: turn.routing === 'pending' ? 'Selecting recipient' : turn.routing === 'clarify' ? 'Requested routing clarification' : turn.routing === 'none' ? 'No task needed' : turn.routing === 'released' ? 'Waiting for an available recipient' : `Recipient selected: ${turn.agent_name ?? agentName}` });
  for (const step of turn.activity?.harness ?? []) steps.push({ id: `harness-${step.id}`, text: `${step.name} · ${step.state}` });
  const actions = turn.coordination ?? [];
  const tools = turn.activity?.tools ?? [];
  for (let index = 0; index <= actions.length; index++) {
    for (const tool of tools.filter(tool => tool.after_action === index)) steps.push({ id: `tool-${tool.id}`, text: `${tool.name}${tool.failed ? ' · Error recorded' : ' · Result recorded'}` });
    const action = actions[index];
    if (action) steps.push({ id: `coordination-${index}`, text: `${action.owner_name} ${action.kind === 'delegate_task' ? 'delegated to' : 'transferred to'} ${action.target_name}`, task: action.child });
  }
  for (const item of turn.agentMessages ?? []) steps.push({ id: `message-${item.id}`, text: item.taskId ? `Delegated to ${item.name}: ${item.task?.slice(0, 160) ?? 'Task'}${(item.task?.length ?? 0) > 160 ? '…' : ''}` : `Message to ${item.name} · ${item.settled ? item.status : item.expects_reply ? 'Waiting for reply' : 'No reply requested'}`, task: item.taskId ?? null });
  for (const item of turn.receivedAgentReplies ?? []) steps.push({ id: `received-${item.id}`, text: `Result received from ${item.name} · ${item.status}` });
  for (const event of turn.events ?? []) steps.push({ id: `event-${event.id}`, text: `Event ${event.event} · ${event.status}` });
  for (const question of turn.questions ?? []) steps.push({ id: `question-${question.id}`, text: `${question.answer === null ? 'Asked' : 'Answered'}: ${question.prompt}` });
  for (const file of turn.generatedFiles ?? []) steps.push({ id: `file-${file.id}`, text: `Generated ${file.name}` });
  for (const checkpoint of turn.activity?.checkpoints ?? []) steps.push({ id: `checkpoint-${checkpoint.turn}`, text: checkpoint.state === 'done' ? 'Git checkpoint captured' : `Git checkpoint ${checkpoint.state}` });
  if (turn.activity?.fallback_model) steps.push({ id: 'fallback', text: `Fallback model used: ${turn.activity.fallback_model}` });
  return <div className="turn-activity">
    <Collapsible title={<span>{activityLabel(turn, now)}</span>}>
      {!!turn.activity?.calls.length && <p className="activity-timing">Elapsed time spans the first provider request to the latest response (or now while working), including waits between requests.</p>}
      {steps.length ? <ol className="activity-list" aria-label="Turn activity">{steps.map(step => { const item = (turn.agentMessages ?? []).find(row => row.taskId === step.task); return <li key={step.id}><span>{step.text}</span>{item?.taskId && <Badge tone={['done'].includes(item.status) ? 'success' : ['failed','cancelled','uncertain'].includes(item.status) ? 'warn' : 'brand'}>{item.status === 'queued' && item.wait ? 'Waiting' : item.status.charAt(0).toUpperCase() + item.status.slice(1)}</Badge>}{step.task && <button type="button" className="link-btn link-btn--small" onClick={() => item?.agent && item.thread ? onOpenAgent?.(item.agent, item.thread) : onOpenTask(step.task!)}>{item ? 'Open conversation' : 'View subtask'}</button>}</li>; })}</ol> : <p className="activity-timing">{live ? 'Waiting for provider response.' : 'No additional steps recorded.'}</p>}
    </Collapsible>
  </div>;
}
