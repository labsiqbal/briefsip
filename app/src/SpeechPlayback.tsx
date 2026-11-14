import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Button, Collapsible, Field, Select } from './ui/kit';
import { createSpeechPlayer, speechVoiceKey, voiceKey } from '../speech';

const engine = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window ? window.speechSynthesis : null;
const player = engine ? createSpeechPlayer(engine, text => new SpeechSynthesisUtterance(text)) : null;

export function SpeechPlayback({ owner, text }: { owner: string; text: string }) {
  const [open, setOpen] = useState(false);
  return <Collapsible title="Listen to answer" open={open} onOpenChange={setOpen}>
    {open && (engine && player ? <SpeechControls owner={owner} text={text} /> : <p className="k-field__hint">This browser does not support speech playback. The answer remains available as text.</p>)}
  </Collapsible>;
}

function SpeechControls({ owner, text }: { owner: string; text: string }) {
  const state = useSyncExternalStore(player!.subscribe, player!.getSnapshot);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]), [selected, setSelected] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    const refresh = () => {
      try { setVoices(engine!.getVoices().filter(voice => voice.localService === true)); }
      catch { setVoices([]); setError('Voice list could not be loaded. Close and reopen voice controls.'); }
    };
    refresh(); engine!.addEventListener('voiceschanged', refresh);
    try { const saved = localStorage.getItem(speechVoiceKey); if (saved && saved.length <= 2000) setSelected(saved); }
    catch { setError('Voice choice could not be loaded. Choose a voice for this session.'); }
    const stop = () => player!.stop(owner);
    window.addEventListener('pagehide', stop);
    return () => { engine!.removeEventListener('voiceschanged', refresh); window.removeEventListener('pagehide', stop); stop(); };
  }, [owner]);
  const voice = voices.find(item => voiceKey(item) === selected), playing = state.owner === owner && state.playing;
  function choose(value: string) {
    player!.stop(owner); setSelected(value); setError('');
    try { localStorage.setItem(speechVoiceKey, value); }
    catch { setError('Choice applies to this session but is not saved. Allow browser storage to remember it.'); }
  }
  return <div className="k-stack bs-root">
    <p className="k-field__hint">Play manually with a voice marked local by the browser. Cloud voices are unavailable here. Text is read as-is, including code and links.</p>
    <Field label="Local voice"><Select value={voice ? selected : ''} onChange={choose} placeholder="Choose local voice" options={voices.map(item => ({ value: voiceKey(item), label: `${item.name} (${item.lang})` }))} /></Field>
    {voice && <p className="k-field__hint">{voice.name} ({voice.lang})</p>}
    {!voices.length && <p className="k-field__hint">No local voices yet. Enable voices in device settings or use a supported browser.</p>}
    {selected && !voice && !!voices.length && <Alert tone="warn">Saved voice unavailable. Choose another local voice.</Alert>}
    <div className="k-row-actions"><Button size="sm" disabled={!voice || playing} onClick={() => player!.play(owner, text, selected)}>Play answer</Button><Button size="sm" disabled={!state.playing && !state.error} onClick={() => player!.stop()}>Stop</Button></div>
    <p role="status">{playing ? 'Reading answer.' : ''}</p>
    {(error || state.error) && <Alert tone="error">{error || state.error}</Alert>}
  </div>;
}
