import { useEffect, useRef, useState } from 'react';
import { HostMetricsSection } from './HostMetricsSection';

type Call = { account?: string; family: string; seq: number; agent_name: string; model: string; origin: string; purpose: string; phase: string; status: string; created: string; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null };
type Report = { transcription: { calls: number; pending: number; uncertain: number; unknown: number; input_tokens: string | null; output_tokens: string | null; total_tokens: string | null; seconds: number | null }; summary: { calls: number; pending: number; failed: number; interrupted: number; input_tokens: string | null; output_tokens: string | null; total_tokens: string | null; unknown_input: number; unknown_output: number; unknown_total: number }; calls: Call[]; next_before: number | null };
const statuses: Record<string, string> = { pending: 'Menunggu respons', received: 'Respons diterima', failed: 'Gagal atau dibatalkan', interrupted: 'Terputus, hasil tidak diketahui' };
const amount = (value: number | string | null) => value === null ? 'Tidak diketahui' : BigInt(value).toLocaleString('id-ID');
export function UsagePanel({ request, onClose }: { request: <T>(path: string) => Promise<T>; onClose: () => void }) {
  const [report, setReport] = useState<Report | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [cursors, setCursors] = useState<number[]>([]), before = cursors.at(-1);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [before]);
  useEffect(() => {
    let stopped = false; setReport(null); setError('');
    void request<Report>(`/api/usage${before ? `?before=${before}` : ''}`).then(data => { if (!stopped) setReport(data); }).catch(error => { if (!stopped) setError(error.message); });
    return () => { stopped = true; };
  }, [before, refresh]);
  return <section className="setup workflow-panel"><h1 ref={heading} tabIndex={-1}>Pemakaian</h1>
    <div className="form-actions routine-actions"><button className="secondary" onClick={onClose}>Kembali ke percakapan</button><button className="secondary" onClick={() => setRefresh(value => value + 1)}>Muat ulang pemakaian</button></div>
    <HostMetricsSection request={request} />
    <h2>Pemakaian provider</h2>
    <p>Catatan panggilan sejak pencatatan diaktifkan. Token berasal dari laporan provider, bukan perkiraan. Biaya dan sisa kuota belum diketahui.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {!report ? !error && <p role="status">Memuat pemakaian...</p> : <><h2>Panggilan chat dan gambar</h2><p>{report.summary.calls} panggilan · {report.summary.pending} menunggu · {report.summary.failed} gagal atau dibatalkan · {report.summary.interrupted} terputus</p>
      <dl><dt>Token input tercatat</dt><dd>{amount(report.summary.input_tokens)} ({report.summary.unknown_input} panggilan tanpa angka)</dd><dt>Token output tercatat</dt><dd>{amount(report.summary.output_tokens)} ({report.summary.unknown_output} panggilan tanpa angka)</dd><dt>Total token tercatat</dt><dd>{amount(report.summary.total_tokens)} ({report.summary.unknown_total} panggilan tanpa angka)</dd></dl>
      <p className="muted">Jumlah tercatat bisa belum lengkap. Panggilan gagal atau terputus mungkin tetap ditagih provider. Respons tool dihitung per panggilan, bukan per pesan pengguna.</p>
      <h2>Transkripsi file</h2><p>{report.transcription.calls} panggilan · {report.transcription.pending} menunggu · {report.transcription.uncertain} hasil belum pasti · {report.transcription.unknown} tanpa laporan pemakaian</p><dl><dt>Token input tercatat</dt><dd>{amount(report.transcription.input_tokens)}</dd><dt>Token output tercatat</dt><dd>{amount(report.transcription.output_tokens)}</dd><dt>Total token tercatat</dt><dd>{amount(report.transcription.total_tokens)}</dd><dt>Durasi tercatat</dt><dd>{report.transcription.seconds === null ? 'Tidak diketahui' : `${report.transcription.seconds.toLocaleString('id-ID')} detik`}</dd></dl><p className="muted">Terpisah dari panggilan chat dan gambar. Durasi dan token mengikuti laporan provider; angka yang hilang tidak dihitung sebagai nol. Biaya belum diketahui. Detail percobaan terakhir ada pada file sumber.</p><h2>Riwayat panggilan chat dan gambar</h2>{!report.calls.length ? <p>Belum ada panggilan pada halaman ini.</p> : <ul className="routine-list">{report.calls.map(call => <li key={call.seq}><h3>{call.agent_name} · {call.model}</h3><p>{call.family === 'openai-images' ? 'OpenAI Images-compatible' : call.family === 'gemini' ? 'Gemini GenerateContent' : call.family === 'anthropic' ? 'Anthropic Messages' : 'OpenAI-compatible'} · {call.origin}</p><p>Akun: {call.phase === 'image' ? 'Provider gambar terpisah' : call.account || 'Default server'}</p><p>{new Date(call.created).toLocaleString('id-ID')} · {call.phase === 'image' ? 'Generasi gambar' : call.phase === 'compaction' ? 'Ringkasan riwayat' : call.purpose === 'routing' ? 'Pemilihan penerima channel' : 'Jawaban agent atau workflow'}</p><p>{statuses[call.status]}</p><p>Input: {amount(call.input_tokens)} · Output: {amount(call.output_tokens)} · Total: {amount(call.total_tokens)}</p></li>)}</ul>}
      <div className="form-actions routine-actions"><button className="secondary" disabled={!cursors.length} onClick={() => setCursors(value => value.slice(0, -1))}>Panggilan lebih baru</button><button className="secondary" disabled={!report.next_before} onClick={() => setCursors(value => [...value, report.next_before!])}>Panggilan lebih lama</button></div>
    </>}
  </section>;
}
