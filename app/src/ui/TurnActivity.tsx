import { ChevronDown, MessageSquare, Wrench } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge } from './kit';
import { Collapsible as Disclosure } from 'radix-ui';
import { useLiveClock } from '../hooks/useLiveClock';
import { Markdown } from '../Markdown';
import { activityLabel, liveTurn, turnActivitySteps } from './transcript';
import type { RunTarget } from '../right-panel-state';

type Props = {
  logOnly?: boolean; actions?: ReactNode;
  scope?: string;
  turn: Parameters<typeof turnActivitySteps>[0] & { id?: string; paused: number; created: string };
  onInspect?: (target: RunTarget) => void;
  agentName: string;
  remote?: boolean;
  onOpenTask: (id: string) => void;
  onOpenAgent?: (agent: string, thread: string) => void;
};

export function TurnActivity({ turn, agentName, onOpenTask, onOpenAgent, onInspect, remote, logOnly, actions: controls, scope = '' }: Props) {
  const live = liveTurn(turn), now = useLiveClock(live);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!live) setOpen(false); }, [live]);
  const steps = turnActivitySteps(turn, agentName);
  const turnId = turn.id;
  const inspect = turnId && onInspect && !remote ? (stepId?: string) => onInspect({ turnId, stepId }) : undefined;
  const failedStep = steps.findLast(step => step.state === 'Failed')?.stepId;
  const inspectButton = inspect && (failedStep || ['failed', 'interrupted'].includes(turn.status))
    ? <button type="button" className="link-btn link-btn--small turn-activity__inspect" onClick={() => inspect(failedStep)}>Inspect</button>
    : null;
  const contents = steps.length > 0 && <ol className="activity-list" aria-label="Turn activity">
    {steps.map(step => {
      const item = step.task ? turn.agentMessages?.find(row => row.taskId === step.task) : undefined;
      const title = <>{step.text}{step.state && <span className="activity-step-state" data-state={step.state}>{step.state}</span>}</>;
      return <li key={step.id}>
        {step.prose ? <MessageSquare className="activity-step-icon" aria-hidden /> : <Wrench className="activity-step-icon" aria-hidden />}
        {step.prose ? <div className="legacy"><Markdown text={step.text} scope={scope} origin={window.location.origin} /></div>
          : inspect && step.stepId ? <button type="button" className="activity-step-button" onClick={() => inspect(step.stepId)}>{title}</button>
          : <span>{title}</span>}
        {item?.taskId && <Badge tone={item.status === 'done' ? 'success' : ['failed', 'cancelled', 'uncertain'].includes(item.status) ? 'warn' : 'brand'}>{item.status === 'queued' && item.wait ? 'Waiting' : item.status.charAt(0).toUpperCase() + item.status.slice(1)}</Badge>}
        {step.task && <button type="button" className="link-btn link-btn--small" onClick={() => item?.agent && item.thread ? onOpenAgent?.(item.agent, item.thread) : onOpenTask(step.task!)}>{item ? 'Open conversation' : 'View subtask'}</button>}
      </li>;
    })}
  </ol>;
  const label = <span className="activity-label">{live && turn.status === 'running' && <span className="activity-working" aria-hidden />}{activityLabel(turn, now)}</span>;
  if (logOnly) return <div className="turn-activity-log">{inspectButton}{contents}</div>;
  if (!steps.length) return <div className="turn-activity"><div className="turn-activity__header">{label}{inspectButton}{controls}</div></div>;
  return <Disclosure.Root className="turn-activity" open={open} onOpenChange={setOpen}>
    <div className="turn-activity__header">
      <Disclosure.Trigger className="k-collapsible__trigger">{label}<ChevronDown size={14} aria-hidden className="k-collapsible__chev" /></Disclosure.Trigger>
      {inspectButton}{controls}
    </div>
    <Disclosure.Content className="k-collapsible__content">{contents}</Disclosure.Content>
  </Disclosure.Root>;
}
