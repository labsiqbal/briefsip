export type TurnActivityData = {
  calls: { seq: number; model: string; purpose: string; phase: string; status: string; created: string; finished: string | null }[];
  tools: { id: string; name: string; after_action: number; failed: number }[];
  harness?: { id: string; name: string; state: string }[];
  fallback_model: string | null;
};

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
  if (turn.status === 'queued' && !calls.length) return 'Queued';
  return duration ? `Working… ${duration}` : 'Working…';
}
