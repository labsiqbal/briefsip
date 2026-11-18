import type { Spec } from '../shared/routine-schedule.ts';
export type { Spec } from '../shared/routine-schedule.ts';
import { closedObject, ProtocolError } from '../shared/protocol.ts';
import { parseCronExpression, maxScheduleTime as maxTime, onceCandidate, cronCandidates } from './schedule-time.ts';

const invalid = () => new ProtocolError(400, 'invalid_schedule', 'Invalid schedule.');
export function epoch(value: unknown) { if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maxTime) throw invalid(); return Number(value); }
export function parseSpec(value: unknown): Spec {
  const kind = (value as Record<string, unknown> | null)?.kind;
  if (kind === 'instant') { const d = closedObject(value, ['kind', 'at']); return { kind, at: epoch(d.at) }; }
  if (kind === 'cron') { const d=closedObject(value,['kind','expression']);parseCronExpression(d.expression);return {kind,expression:String(d.expression)}; }
  if (kind === 'legacy_interval') {
    const d=closedObject(value,['kind','intervalMs','anchorAt']);
    if (!Number.isSafeInteger(d.intervalMs)||Number(d.intervalMs)<60000||Number(d.intervalMs)>31536000000||!Number.isSafeInteger(d.anchorAt)||Number(d.anchorAt)<0||Number(d.anchorAt)>maxTime) throw invalid();
    return {kind,intervalMs:Number(d.intervalMs),anchorAt:Number(d.anchorAt)};
  }
  if (kind === 'once') {
    const d=closedObject(value,['kind','date','time']);
    if (typeof d.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d.date)||Number(d.date.slice(0,4))<1970||typeof d.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time)) throw invalid();
    const date=Date.parse(d.date+'T00:00:00.000Z');
    if (!Number.isFinite(date)||new Date(date).toISOString().slice(0,10)!==d.date) throw invalid();
    return {kind,date:d.date,time:d.time};
  }
  if (kind !== 'interval') throw invalid();
  const d = closedObject(value, ['kind', 'amount', 'unit', 'anchorAt']);
  if (!Number.isSafeInteger(d.amount) || Number(d.amount) <= 0 || !['minute', 'hour', 'day'].includes(String(d.unit))) throw invalid();
  const spec: Spec = { kind, amount: Number(d.amount), unit: d.unit as 'minute' | 'hour' | 'day', anchorAt: epoch(d.anchorAt) };
  const duration = interval(spec);
  if (!Number.isSafeInteger(duration) || duration < 300000 || duration > maxTime) throw invalid();
  return spec;
}
export function interval(spec: Spec) { return spec.kind === 'interval' ? spec.amount * { minute: 60000, hour: 3600000, day: 86400000 }[spec.unit] : spec.kind === 'legacy_interval' ? spec.intervalMs : 0; }

export function nextScheduleTimes(spec: Spec, zone: string, after: number, count = 3) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10) throw invalid();
  if (spec.kind === 'once') return [onceCandidate(spec, zone).at].filter(at => at > after).slice(0, count);
  if (spec.kind === 'cron') {
    const times: number[] = [];
    for (const candidate of cronCandidates(spec.expression, zone, after)) if (candidate.candidateIndex === 0) { times.push(candidate.at); if (times.length === count) break; }
    return times;
  }
  if (spec.kind === 'interval') {
    const duration = interval(spec), first = spec.anchorAt > after ? spec.anchorAt : spec.anchorAt + Math.ceil((after - spec.anchorAt + 1) / duration) * duration;
    return Array.from({ length: count }, (_, index) => first + index * duration);
  }
  if (spec.kind === 'legacy_interval') {
    const first = spec.anchorAt > after ? spec.anchorAt : spec.anchorAt + Math.ceil((after - spec.anchorAt + 1) / spec.intervalMs) * spec.intervalMs;
    return Array.from({ length: count }, (_, index) => first + index * spec.intervalMs);
  }
  return spec.at > after ? [spec.at] : [];
}
