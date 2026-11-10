import { parseQuestionAnswer, type QuestionAnswer } from '../question-answer.ts';
import { useEffect, useRef, useState } from 'react';
export type Question = { id: string; prompt: string; choices: string[]; answer: string | null };
type Answer = QuestionAnswer;
export function QuestionCard({ question, path, status, archived, request }: { question: Question; path: string; status: string; archived: boolean; request: <T>(path: string, data?: unknown) => Promise<T> }) {
  const key = `briefsip:answer:${question.id}`, draftKey = `${key}:draft`;
  const [recovery] = useState(() => {
    try {
      const raw = sessionStorage.getItem(key), saved = raw === null ? null : parseQuestionAnswer(JSON.parse(raw), question.choices);
      return { pending: saved as Answer | null, draft: sessionStorage.getItem(draftKey) ?? '', blocked: false };
    } catch { return { pending: null, draft: '', blocked: true }; }
  });
  const [pending, setPending] = useState<Answer | null>(recovery.pending), [text, setText] = useState(recovery.draft), [blocked, setBlocked] = useState(recovery.blocked);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmed, setConfirmed] = useState(false);
  const mounted = useRef(false), sending = useRef(false), heading = useRef<HTMLHeadingElement>(null), focused = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (question.answer !== null) { try { sessionStorage.removeItem(key); sessionStorage.removeItem(draftKey); } catch { /* Saved server answer remains authoritative. */ } setPending(null); if (focused.current && document.activeElement === document.body) heading.current?.focus(); } }, [question.answer]);
  function change(value: string) { setText(value); try { sessionStorage.setItem(draftKey, value); } catch { setError('Draft jawaban belum tersimpan. Jangan tutup percakapan sebelum menyalin teks.'); } }
  async function send() {
    if (sending.current || blocked || archived || !['queued', 'interrupted'].includes(status)) return;
    const command = pending ?? { id: crypto.randomUUID(), text: text.trim(), acknowledgeUncertain: confirmed };
    if (!command.text || command.text.length > 4000 || question.choices.length && !question.choices.includes(command.text) || status === 'interrupted' && !command.acknowledgeUncertain) return;
    try { sessionStorage.setItem(key, JSON.stringify(command)); } catch { setError('Jawaban belum bisa disimpan di browser. Periksa penyimpanan lalu coba lagi.'); return; }
    sending.current = true; setBusy(true); setPending(command); setError('');
    try { await request(`${path}/questions/${question.id}/answer`, command); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Hasil belum diketahui. Coba kirim lagi.'); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  const unavailable = archived || !['queued', 'interrupted'].includes(status);
  return <section className="question-card" onFocusCapture={() => { focused.current = true; }} onBlurCapture={event => { if (event.relatedTarget) focused.current = event.currentTarget.contains(event.relatedTarget as Node); }}><h3 ref={heading} tabIndex={-1}>{question.prompt}</h3>{question.answer !== null ? <p className="message-text">Jawaban: {question.answer}</p> : <form onSubmit={event => { event.preventDefault(); void send(); }}>
    {question.choices.length ? <fieldset disabled={busy || !!pending || blocked || unavailable}><legend>Jawaban</legend>{question.choices.map(choice => <label className="member-option" key={choice}><input type="radio" name={`answer-${question.id}`} checked={(pending?.text ?? text) === choice} onChange={() => change(choice)} /><span className="message-text">{choice}</span></label>)}</fieldset> : <label>Jawaban<textarea maxLength={4000} value={pending?.text ?? text} disabled={busy || !!pending || blocked || unavailable} onChange={event => change(event.target.value)} required /></label>}
    {status === 'interrupted' && <label className="member-option"><input type="checkbox" checked={pending?.acknowledgeUncertain ?? confirmed} disabled={busy || !!pending} onChange={event => setConfirmed(event.target.checked)} />Saya sudah memeriksa efek tugas sebelum melanjutkan</label>}
    {blocked && <p role="alert">Data pemulihan jawaban tidak valid. Buang pemulihan sebelum melanjutkan.</p>}{error && <p className="error" role="alert">{error}</p>}
    {unavailable && <p>Pertanyaan tidak bisa dijawab saat tugas berhenti atau percakapan diarsipkan.</p>}
    <div className="form-actions routine-actions"><button disabled={busy || blocked || unavailable || !(pending?.text ?? text).trim() || status === 'interrupted' && !(pending?.acknowledgeUncertain ?? confirmed)}>{busy ? 'Mengirim...' : pending ? 'Coba kirim jawaban lagi' : 'Kirim jawaban'}</button>
    {(pending || blocked) && <button type="button" className="secondary" disabled={busy} onClick={() => { if (!window.confirm('Buang data pemulihan? Jawaban mungkin sudah tersimpan. Periksa riwayat sebelum mengirim jawaban lain.')) return; try { sessionStorage.removeItem(key); setPending(null); setBlocked(false); setError(''); } catch { setError('Data pemulihan belum bisa dihapus.'); } }}>Buang pemulihan</button>}</div>
  </form>}</section>;
}
