import { useEffect, useRef, useState } from 'react';
import { visibilityCommand } from '../agent-visibility';

export function AgentVisibility({ agent, request, onChanged }: { agent: { id: string; hidden?: boolean; visibility_revision?: number }; request: <T>(path: string, body?: unknown) => Promise<T>; onChanged: () => Promise<void> }) {
  const key = `briefsip-visibility:${agent.id}`;
  const [recovery, setRecovery] = useState(() => {
    try { const raw = sessionStorage.getItem(key); return { pending: raw ? visibilityCommand(JSON.parse(raw)) : null, invalid: false }; }
    catch { return { pending: null, invalid: true }; }
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const flight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function save() {
    if (flight.current || recovery.invalid) return;
    if (!recovery.pending && !window.confirm(agent.hidden ? 'Pulihkan agent? Antrean yang ditahan akan dilanjutkan. Jadwal yang terlewat tidak dijalankan ulang.' : 'Sembunyikan agent? Pekerjaan yang sedang berjalan boleh selesai. Antrean ditahan dan pesan baru ditolak sampai agent dipulihkan.')) return;
    const command = recovery.pending ?? { id: crypto.randomUUID(), revision: agent.visibility_revision ?? 0, hidden: !agent.hidden };
    try { sessionStorage.setItem(key, JSON.stringify(command)); } catch { setError('Status tidak bisa disimpan di browser. Periksa penyimpanan situs sebelum mencoba lagi.'); return; }
    flight.current = true; setBusy(true); setError(''); setRecovery({ pending: command, invalid: false });
    try {
      await request(`/api/agents/${agent.id}/visibility`, command);
      if (!mounted.current) return;
      await onChanged();
      if (!mounted.current) return;
      if (sessionStorage.getItem(key) === JSON.stringify(command)) sessionStorage.removeItem(key); setRecovery({ pending: null, invalid: false });
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Perubahan belum terkonfirmasi. Coba lagi.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  async function reload() {
    if (flight.current || !window.confirm('Buang permintaan tersimpan dan muat status terbaru? Perubahan yang sudah diterima server tetap berlaku.')) return;
    flight.current = true; setBusy(true);
    try { const stored = sessionStorage.getItem(key); await onChanged(); if (!mounted.current) return; if (sessionStorage.getItem(key) === stored) sessionStorage.removeItem(key); if (mounted.current) { setRecovery({ pending: null, invalid: false }); setError(''); } }
    catch { if (mounted.current) setError('Status terbaru belum dimuat. Coba muat ulang lagi.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  return <section aria-label="Visibilitas agent"><h2>{agent.hidden ? 'Agent disembunyikan' : 'Visibilitas agent'}</h2><p>Riwayat, file, memori, dan bagian sidebar tetap tersimpan.</p>
    {recovery.pending && <p role="status">Perubahan belum terkonfirmasi. Coba lagi memakai permintaan yang sama.</p>}
    {recovery.invalid && <p role="alert" className="error">Permintaan tersimpan tidak valid. Muat status terbaru sebelum melanjutkan.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="form-actions"><button type="button" className="secondary" disabled={busy || recovery.invalid} onClick={() => void save()}>{busy ? 'Menyimpan...' : recovery.pending ? 'Coba perubahan lagi' : agent.hidden ? 'Pulihkan agent' : 'Sembunyikan agent'}</button><button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>Muat status terbaru</button></div>
  </section>;
}
