import { useEffect, useState } from 'react';
import type { WorkflowCommand } from '../workflow-command';

type Schedule = { revision: number; next_at: number; interval_ms: number | null; input: string; enabled: number };
type State = { schedule: Schedule | null; occurrences: { scheduled_at: number; run: string | null; missed: number; reason: string | null }[] };
export function WorkflowSchedule({ workflow, request, pending, locked, refresh, onSave, onRun, conflict, onLoaded }: {
  workflow: string; request: <T>(path: string, data?: unknown) => Promise<T>; pending?: WorkflowCommand;
  locked: boolean; refresh: number; onSave: (body: Record<string, unknown>) => Promise<void>; onRun: (id: string) => void; conflict: boolean; onLoaded: () => void;
}) {
  const [state, setState] = useState<State | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => {
    let stopped = false; setState(null); setError('');
    void request<State>(`/api/workflows/${workflow}/schedule`).then(data => { if (!stopped) { setState(data); onLoaded(); } }).catch(error => { if (!stopped) setError(error.message); });
    return () => { stopped = true; };
  }, [workflow, refresh, reload]);
  const snapshot = pending?.body, saved = state?.schedule;
  const date = new Date(Number(snapshot?.nextAt ?? saved?.next_at ?? Date.now() + 60000));
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  return <section><h2>Jadwal workflow</h2><p>Jadwal memakai waktu perangkat ini. Kejadian terlewat digabung satu eksekusi; jika workflow masih aktif, kejadian dilewati.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <button className="secondary" disabled={locked} onClick={() => { if (!state || window.confirm('Muat ulang jadwal dan buang perubahan form yang belum disimpan?')) setReload(value => value + 1); }}>Muat ulang jadwal</button>
    {!state ? !error && <p role="status">Memuat jadwal...</p> : <form key={`${refresh}:${reload}`} onSubmit={async event => {
      event.preventDefault(); if (locked || conflict) return;
      const form = new FormData(event.currentTarget), interval = String(form.get('interval') ?? '');
      const body = { id: crypto.randomUUID(), revision: saved?.revision ?? 0, nextAt: new Date(String(form.get('nextAt'))).getTime(), intervalSeconds: interval ? Number(interval) * 60 : null, input: String(form.get('input') ?? ''), enabled: form.get('enabled') === 'on' };
      await onSave(body);
    }}>
      <label>Waktu mulai workflow<input name="nextAt" type="datetime-local" step={1} required defaultValue={localDate} readOnly={locked || conflict} /></label>
      <label>Ulangi workflow setiap (menit)<input name="interval" type="number" min={1} max={525600} step={1} defaultValue={snapshot ? snapshot.intervalSeconds === null ? '' : Number(snapshot.intervalSeconds) / 60 : saved?.interval_ms ? saved.interval_ms / 60000 : ''} readOnly={locked || conflict} /><span className="muted">Kosongkan untuk sekali jalan.</span></label>
      <label>Input terjadwal<textarea name="input" maxLength={16000} defaultValue={String(snapshot?.input ?? saved?.input ?? '')} readOnly={locked || conflict} /></label>
      <label className="member-option"><input name="enabled" type="checkbox" defaultChecked={snapshot ? Boolean(snapshot.enabled) : !!saved?.enabled} disabled={locked || conflict} /> Jadwal workflow aktif</label>
      {conflict && <p role="alert">Jadwal sudah berubah. Draft tetap ditampilkan; muat ulang jadwal sebelum menyimpan lagi.</p>}
      <button disabled={locked || conflict}>Simpan jadwal workflow</button>
    </form>}
    {state && <><h3>Kejadian jadwal terakhir</h3>{!state.occurrences.length ? <p>Belum ada kejadian jadwal.</p> : <ul className="routine-list">{state.occurrences.map(item => <li key={item.scheduled_at}><p>{new Date(item.scheduled_at).toLocaleString('id-ID')} · {item.reason === 'busy' ? 'Dilewati: workflow masih aktif' : 'Eksekusi dibuat'}{item.missed > 0 ? ` · ${item.missed} interval terlewat` : ''}</p>{item.run && <button className="secondary" onClick={() => onRun(item.run!)}>Buka hasil jadwal</button>}</li>)}</ul>}</>}
  </section>;
}
