import { useEffect, useRef, useState } from 'react';

export function BackupPanel({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [downloaded, setDownloaded] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), controller = useRef<AbortController | null>(null);
  useEffect(() => { heading.current?.focus(); return () => controller.current?.abort(); }, []);
  async function download() {
    if (controller.current || !window.confirm('Backup berisi seluruh percakapan, file, instruksi, dan secret webhook. File tidak dienkripsi. Simpan secara privat. Lanjutkan unduhan?')) return;
    const pending = new AbortController(); controller.current = pending; setBusy(true); setError(''); setDownloaded(false);
    try {
      const response = await fetch('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: crypto.randomUUID(), confirmed: true }), signal: pending.signal });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Backup gagal dibuat. Coba lagi.');
      const blob = await response.blob();
      if (pending.signal.aborted) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = 'briefsip-workspace.sqlite'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setDownloaded(true);
    } catch (error) { if (!pending.signal.aborted) setError(error instanceof TypeError ? 'Koneksi terputus. Coba unduh backup lagi.' : error instanceof Error ? error.message : 'Backup gagal diunduh.'); }
    finally { if (!pending.signal.aborted) { controller.current = null; setBusy(false); } }
  }
  return <section className="setup"><h1 ref={heading} tabIndex={-1}>Backup workspace</h1>
    <p>Snapshot database mencakup agent, percakapan, file, rutinitas, workflow, hasil, dan secret webhook. Konfigurasi provider dari lingkungan server serta draft browser tidak termasuk.</p>
    <p className="notice">File tidak dienkripsi. Simpan secara privat dan jangan bagikan ke layanan yang tidak dipercaya.</p>
    <div className="form-actions"><button className="secondary" onClick={onClose}>Kembali ke percakapan</button><button disabled={busy} onClick={() => void download()}>{busy ? 'Membuat backup...' : 'Unduh backup workspace'}</button></div>
    {error && <p className="error" role="alert">{error}</p>}{downloaded && <p role="status">Unduhan dimulai. Pastikan file selesai tersimpan di browser.</p>}
    <h2>Pemulihan</h2><p>Pulihkan hanya backup yang dipercaya. Pemulihan memakai database baru dan tidak menimpa workspace lama. Jadwal, webhook, dan akses script dinonaktifkan; pekerjaan belum selesai ditahan untuk diperiksa.</p>
    <p>Jalankan dari direktori aplikasi di komputer server:</p><pre className="message-text">node --experimental-strip-types backup.ts restore BACKUP.sqlite /direktori-baru/briefsip.sqlite</pre>
    <p>Direktori tujuan harus sudah ada. Untuk memakai hasil pemulihan, arahkan BRIEFSIP_DATA_DIR ke direktori tersebut saat memulai aplikasi. Periksa hasil dan konfigurasi sebelum mengaktifkan otomatisasi lagi.</p>
  </section>;
}
