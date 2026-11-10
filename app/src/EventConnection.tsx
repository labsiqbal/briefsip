import { useEffect, useRef, useState } from 'react';

export function EventConnection({ path, request }: { path: string; request: <T>(path: string) => Promise<T> }) {
  const [connection, setConnection] = useState<{ event: string; deadline: number; url: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function reveal() {
    if (busy) return;
    const version = generation.current; setBusy(true); setError('');
    try { const value = await request<NonNullable<typeof connection>>(path); if (version === generation.current) setConnection(value); }
    catch (error) { if (version === generation.current) setError(error instanceof Error ? error.message : 'Koneksi event belum tersedia. Coba lagi.'); }
    finally { if (version === generation.current) setBusy(false); }
  }
  return <section><h3>Menunggu event</h3><p>Event hanya berlaku untuk permintaan ini. URL lokal memerlukan Briefsip tetap berjalan.</p>
    {error && <p role="alert" className="error">{error}</p>}
    <button className="secondary" disabled={busy} aria-expanded={!!connection} onClick={() => connection ? setConnection(null) : void reveal()}>{busy ? 'Memuat koneksi...' : connection ? 'Sembunyikan koneksi' : 'Tampilkan koneksi event'}</button>
    {connection && <>
      <p>Nama event: {connection.event}. Batas waktu: {new Date(connection.deadline).toLocaleString('id-ID')}.</p>
      <label>URL event<input readOnly value={connection.url} /></label><label>Secret penandatanganan<input readOnly value={connection.secret} autoComplete="off" spellCheck={false} /></label>
      <p className="notice">Secret memberi izin melanjutkan langkah ini. Simpan hanya di integrasi tepercaya; jangan masukkan ke percakapan.</p>
      <p>Kirim JSON dengan event, eventTime opsional, dan payload. Header X-Briefsip-Time berisi waktu Unix detik, X-Briefsip-Id berisi ID pengiriman unik, dan X-Briefsip-Signature berisi HMAC-SHA256 heksadesimal dari waktu, newline, ID, newline, lalu byte JSON persis. Gunakan secret sebagai teks UTF-8.</p>
    </>}
  </section>;
}
