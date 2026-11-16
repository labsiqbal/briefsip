import type { StreamPartial, StreamSegment } from '../../turn-stream';

export type TurnActivityData = {
  artifacts?: { id: string; name: string; kind: string; url: string }[];
  started_at?: string | null;
  stopped_at?: string | null;
  budget_stopped?: number;
  dispatch?: { source_turn: string; target_turn: string; mode: 'steer' | 'restart' }[];
  calls: { seq: number; model: string; purpose: string; phase: string; status: string; created: string; finished: string | null }[];
  tools: { id: string; name: string; title?: string; after_action: number; failed: number }[];
  harness?: { id: string; name: string; state: string }[];
  stream?: StreamSegment[];
  fallback_model: string | null;
};

export function streamWork(turn: { partial?: StreamPartial | null; activity?: TurnActivityData }) {
  return (turn.activity?.stream ?? []).filter(segment => !segment.final && (segment.kind === 'tool' || !!segment.text && !(turn.partial?.seq === segment.seq && turn.partial.segment === segment.id)));
}

type ActivityTurn = { status: string; paused: number; created: string; activity?: TurnActivityData; questions?: { answer: string | null }[] };
export const liveTurn = (turn: ActivityTurn) => ['queued', 'running'].includes(turn.status) && !turn.paused && !turn.questions?.some(question => question.answer === null);
export const livePartial = (turn: { status: string; paused: number; partial?: { status: string; text: string } | null }) => turn.status === 'running' && !turn.paused && turn.partial?.status === 'pending' && !!turn.partial.text;
export const turnPollDelay = (turns: { status: string }[]) => turns.some(turn => ['queued', 'running'].includes(turn.status)) ? 400 : 1200;

export function activityLabel(turn: ActivityTurn, now: number) {
  if (!['done', 'cancelled'].includes(turn.status) && turn.questions?.some(question => question.answer === null)) return 'Waiting for your answer';
  if (!['done', 'cancelled'].includes(turn.status) && turn.paused) return 'Paused';
  const calls = turn.activity?.calls ?? [];
  const start = turn.activity?.started_at ?? calls[0]?.created ?? (turn.status === 'cancelled' ? null : turn.created);
  const end = turn.status === 'cancelled' ? turn.activity?.stopped_at : liveTurn(turn) ? now : calls.at(-1)?.finished;
  const elapsed = start && end ? Math.max(0, Math.floor((new Date(end).getTime() - Date.parse(start)) / 1000)) : null;
  const duration = elapsed !== null && Number.isFinite(elapsed) ? elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : elapsed === 0 ? '<1s' : `${elapsed}s` : null;
  if (turn.status === 'done') return duration ? `Worked for ${duration}` : 'Worked';
  if (turn.status === 'failed') return duration ? `Failed after ${duration}` : 'Failed';
  if (turn.status === 'interrupted') return duration ? `Interrupted after ${duration}` : 'Interrupted';
  if (turn.status === 'cancelled') return duration ? `Stopped after ${duration}` : 'Stopped';
  if (turn.status === 'queued') return 'Queued';
  return duration ? `Working… ${duration}` : 'Working…';
}

export function matchOffsets(text: string, query: string) {
  if (!query.trim()) return [];
  return [...text.matchAll(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'))]
    .map(match => ({ start: match.index, end: match.index + match[0].length }));
}

export function toolTitle(name: string) {
  return name.split('__').at(-1)!.replace(/[_-]+/g, ' ').replace(/^./, char => char.toUpperCase());
}
