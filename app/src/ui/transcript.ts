import type { StreamPartial, StreamSegment } from '../../turn-stream';

export type TurnActivityData = {
  budget_stopped?: number;
  dispatch?: { source_turn: string; target_turn: string; mode: 'steer' | 'restart' }[];
  calls: { seq: number; model: string; purpose: string; phase: string; status: string; created: string; finished: string | null }[];
  tools: { id: string; name: string; after_action: number; failed: number }[];
  harness?: { id: string; name: string; state: string }[];
  stream?: StreamSegment[];
  fallback_model: string | null;
};

export function streamWork(turn: { partial?: StreamPartial | null; activity?: TurnActivityData }) {
  return (turn.activity?.stream ?? []).filter(segment => !segment.final && (segment.kind === 'tool' || !!segment.text && !(turn.partial?.seq === segment.seq && turn.partial.segment === segment.id)));
}
export function streamIdentity(turn: { partial?: StreamPartial | null; activity?: TurnActivityData }) {
  if (turn.partial) return `${turn.partial.seq}:${turn.partial.segment ?? 'text-0'}`;
  const final = turn.activity?.stream?.findLast(segment => segment.final);
  return final ? `${final.seq}:${final.id}` : undefined;
}

type ActivityTurn = { status: string; paused: number; created: string; activity?: TurnActivityData; questions?: { answer: string | null }[] };
export const liveTurn = (turn: ActivityTurn) => ['queued', 'running'].includes(turn.status) && !turn.paused && !turn.questions?.some(question => question.answer === null);
export const livePartial = (turn: { status: string; paused: number; partial?: { status: string; text: string } | null }) => turn.status === 'running' && !turn.paused && turn.partial?.status === 'pending' && !!turn.partial.text;
export const turnPollDelay = (turns: { status: string }[]) => turns.some(turn => ['queued', 'running'].includes(turn.status)) ? 400 : 1200;

export function activityLabel(turn: ActivityTurn, now: number) {
  if (!['done', 'cancelled'].includes(turn.status) && turn.questions?.some(question => question.answer === null)) return 'Waiting for your answer';
  if (!['done', 'cancelled'].includes(turn.status) && turn.paused) return 'Paused';
  const calls = turn.activity?.calls ?? [];
  const start = calls[0]?.created ?? turn.created;
  // ponytail: provider ledger bounds elapsed time; exact terminal/paused timestamps need a turn lifecycle journal.
  const end = liveTurn(turn) ? now : calls.at(-1)?.finished;
  const elapsed = start && end ? Math.max(0, Math.floor((new Date(end).getTime() - Date.parse(start)) / 1000)) : null;
  const duration = elapsed !== null && Number.isFinite(elapsed) ? elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s` : null;
  if (turn.status === 'done') return duration ? `Worked for ${duration}` : 'Worked';
  if (turn.status === 'failed') return duration ? `Failed after ${duration}` : 'Failed';
  if (turn.status === 'interrupted') return duration ? `Interrupted after ${duration}` : 'Interrupted';
  if (turn.status === 'cancelled') return duration ? `Stopped after ${duration}` : 'Cancelled';
  if (turn.status === 'queued') return 'Queued';
  return duration ? `Working… ${duration}` : 'Working…';
}
