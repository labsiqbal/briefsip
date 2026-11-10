import { useEffect, useRef, useState } from 'react';
import type { WorkflowCommand } from '../workflow-command';

export type WorkflowHook = { route: string | null; url?: string; revision: number; enabled: number; secret?: string };
type Receipt = { route: string; delivery: string; received: number; result: { outcome: string; reason?: string; id?: string } };
export function WorkflowWebhook({ workflow, request, pending, locked, busy, refresh, secret, conflict, onLoaded, onSave, onRun }: {
  workflow: string; request: <T>(path: string, data?: unknown) => Promise<T>; pending?: WorkflowCommand;
  locked: boolean; busy: boolean; refresh: number; secret?: string; conflict: boolean; onLoaded: () => void;
  onSave: (body: Record<string, unknown>) => Promise<void>; onRun: (id: string) => void;
}) {
  const [state, setState] = useState<{ hook: WorkflowHook | null; receipts: Receipt[] } | null>(null);
  const [error, setError] = useState(''), [reload, setReload] = useState(0);
  const loaded = useRef('');
  useEffect(() => {
    const version = `${refresh}:${reload}`;
    if (busy || (state && loaded.current === version)) return;
    let stopped = false; setError('');
    void Promise.all([request<WorkflowHook | null>(`/api/workflows/${workflow}/webhook`), request<Receipt[]>(`/api/workflows/${workflow}/webhook-events`)]).then(([hook, receipts]) => {
      if (!stopped) { loaded.current = version; setState({ hook, receipts }); if (!state) onLoaded(); }
    }).catch(error => { if (!stopped) setError(error.message); });
    return () => { stopped = true; };
  }, [workflow, refresh, reload, busy]);
  const snapshot = pending?.body, hook = state?.hook;
  return <section><h2>Webhook workflow</h2><p>Kirim event bertanda tangan untuk menjalankan workflow. Event saat workflow masih aktif dilewati dan tidak dijalankan ulang.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <button className="secondary" disabled={locked} onClick={() => { if (!state || window.confirm('Muat ulang webhook dan buang perubahan form yang belum disimpan?')) { setState(null); setReload(value => value + 1); } }}>Muat ulang webhook</button>
    {!state ? !error && <p role="status">Memuat webhook...</p> : <form key={`${hook?.revision ?? 0}:${refresh}:${reload}`} onSubmit={event => {
      event.preventDefault(); if (locked || conflict) return;
      const form = new FormData(event.currentTarget);
      void onSave({ id: crypto.randomUUID(), revision: hook?.revision ?? 0, enabled: form.get('enabled') === 'on', rotate: !hook?.route || form.get('rotate') === 'on' });
    }}>
      {hook?.route && <label>URL webhook workflow<input readOnly value={hook.url} onFocus={event => event.currentTarget.select()} /></label>}
      {secret && <label>Secret webhook workflow<input readOnly type="password" value={secret} onFocus={event => event.currentTarget.select()} /><span className="muted">Simpan secret ini. Secret tidak ditampilkan lagi setelah keluar atau memuat ulang halaman.</span></label>}
      <label className="member-option"><input name="enabled" type="checkbox" disabled={locked || conflict} defaultChecked={snapshot ? Boolean(snapshot.enabled) : !!hook?.enabled} /> Webhook workflow aktif</label>
      {hook?.route && <label className="member-option"><input name="rotate" type="checkbox" disabled={locked || conflict} defaultChecked={Boolean(snapshot?.rotate)} /> Ganti secret. Pengirim harus memakai secret baru.</label>}
      {conflict && <p role="alert">Webhook sudah berubah. Muat ulang pengaturan sebelum menyimpan lagi.</p>}
      <button disabled={locked || conflict}>Simpan webhook workflow</button>
      {hook?.route && <button type="button" className="secondary" disabled={locked || conflict} onClick={() => {
        if (window.confirm('Hapus pemicu webhook? URL dan secret lama tidak dapat dipakai lagi. Eksekusi yang sudah dimulai dan riwayat tetap tersimpan.')) void onSave({ id: crypto.randomUUID(), revision: hook.revision, remove: true, route: hook.route });
      }}>Hapus pemicu webhook</button>}
    </form>}
    {state && <><h3>Event webhook terakhir</h3>{!state.receipts.length ? <p>Belum ada event webhook.</p> : <ul className="routine-list">{state.receipts.map(row => <li key={`${row.route}:${row.delivery}`}><p>{row.delivery} · {new Date(row.received).toLocaleString('id-ID')} · {row.result.outcome === 'queued' ? 'Eksekusi dibuat' : row.result.reason === 'busy' ? 'Dilewati: workflow masih aktif' : 'Dilewati: webhook nonaktif'}</p>{row.result.id && <button className="secondary" onClick={() => onRun(row.result.id!)}>Buka hasil webhook</button>}</li>)}</ul>}</>}
  </section>;
}
