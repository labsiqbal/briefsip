import { readProductStorage, removeProductStorage } from './rename-storage.ts';
import { parseQuestionAnswer, type QuestionAnswer } from './question-answer.ts';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Field, Textarea, useConfirm } from './ui/kit';
export type Question = { id: string; prompt: string; choices: string[]; answer: string | null };
type Answer = QuestionAnswer;
export function QuestionCard({ question, path, status, archived, request }: { question: Question; path: string; status: string; archived: boolean; request: <T>(path: string, data?: unknown) => Promise<T> }) {
  const confirm = useConfirm();
  const key = `minarbot:answer:${question.id}`, draftKey = `${key}:draft`;
  const [recovery] = useState(() => {
    try {
      const raw = readProductStorage(sessionStorage, key), saved = raw === null ? null : parseQuestionAnswer(JSON.parse(raw), question.choices);
      return { pending: saved as Answer | null, draft: readProductStorage(sessionStorage, draftKey) ?? '', blocked: false };
    } catch { return { pending: null, draft: '', blocked: true }; }
  });
  const [pending, setPending] = useState<Answer | null>(recovery.pending), [text, setText] = useState(recovery.draft), [blocked, setBlocked] = useState(recovery.blocked);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmed, setConfirmed] = useState(false);
  const mounted = useRef(false), sending = useRef(false), heading = useRef<HTMLHeadingElement>(null), focused = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (question.answer !== null) { try { removeProductStorage(sessionStorage, key); removeProductStorage(sessionStorage, draftKey); } catch { /* Saved server answer remains authoritative. */ } setPending(null); if (focused.current && document.activeElement === document.body) heading.current?.focus(); } }, [question.answer]);
  function change(value: string) { setText(value); try { sessionStorage.setItem(draftKey, value); } catch { setError('Answer draft has not been saved. Copy the text before closing the conversation.'); } }
  async function send() {
    if (sending.current || blocked || archived || !['queued', 'interrupted'].includes(status)) return;
    const command = pending ?? { id: crypto.randomUUID(), text: text.trim(), acknowledgeUncertain: confirmed };
    if (!command.text || command.text.length > 4000 || question.choices.length && !question.choices.includes(command.text) || status === 'interrupted' && !command.acknowledgeUncertain) return;
    try { sessionStorage.setItem(key, JSON.stringify(command)); } catch { setError('Answer could not be saved in the browser. Check storage and try again.'); return; }
    sending.current = true; setBusy(true); setPending(command); setError('');
    try { await request(`${path}/questions/${question.id}/answer`, command); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Result is unknown. Try sending again.'); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  const unavailable = archived || !['queued', 'interrupted'].includes(status);
  return <section className="k-stack bs-root" onFocusCapture={() => { focused.current = true; }} onBlurCapture={event => { if (event.relatedTarget) focused.current = event.currentTarget.contains(event.relatedTarget as Node); }}>
    <Card><div className="k-stack" style={{ padding: 12 }}>
      <h3 ref={heading} tabIndex={-1} className="k-section__title" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{question.prompt}</h3>
      {question.answer !== null ? <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>Answer: {question.answer}</p> : <form className="k-stack" onSubmit={event => { event.preventDefault(); void send(); }}>
        {/* Native radios preserve arrow-key selection, which kit Segmented does not support. */}
        {question.choices.length ? <fieldset className="k-fieldset" disabled={busy || !!pending || blocked || unavailable}><legend className="k-field__label">Answer</legend>{question.choices.map(choice => <label className="k-check" key={choice}><input type="radio" name={`answer-${question.id}`} checked={(pending?.text ?? text) === choice} onChange={() => change(choice)} /><span className="k-check__label" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{choice}</span></label>)}</fieldset>
          : <Field label="Answer"><Textarea maxLength={4000} value={pending?.text ?? text} disabled={busy || !!pending || blocked || unavailable} onChange={event => change(event.target.value)} required /></Field>}
        {status === 'interrupted' && <Checkbox checked={pending?.acknowledgeUncertain ?? confirmed} disabled={busy || !!pending} onChange={setConfirmed} label="I have checked the effects of the task before continuing" />}
        {blocked && <Alert tone="error">Answer recovery data is invalid. Discard recovery before continuing.</Alert>}{error && <Alert tone="error">{error}</Alert>}
        {unavailable && <Alert>Questions cannot be answered while the task is stopped or the conversation is archived.</Alert>}
        <div className="k-row-actions">
          <Button type="submit" size="sm" variant="primary" disabled={busy || blocked || unavailable || !(pending?.text ?? text).trim() || status === 'interrupted' && !(pending?.acknowledgeUncertain ?? confirmed)}>{busy ? 'Sending...' : pending ? 'Retry answer' : 'Answer'}</Button>
          {(pending || blocked) && <Button size="sm" disabled={busy} onClick={async () => { if (!await confirm({ title: 'Discard recovery data?', description: 'The answer may already be saved. Check history before sending another answer.', confirm: 'Discard recovery', danger: true })) return; try { removeProductStorage(sessionStorage, key); setPending(null); setBlocked(false); setError(''); } catch { setError('Recovery data could not be deleted.'); } }}>Discard recovery</Button>}
        </div>
      </form>}
    </div></Card>
  </section>;
}
