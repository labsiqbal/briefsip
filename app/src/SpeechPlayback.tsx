import { useEffect, useState, useSyncExternalStore } from 'react';
import { createSpeechPlayer, speechVoiceKey, voiceKey } from '../speech';

const engine = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window ? window.speechSynthesis : null;
const player = engine ? createSpeechPlayer(engine, text => new SpeechSynthesisUtterance(text)) : null;

export function SpeechPlayback({ owner, text }: { owner: string; text: string }) {
  const [open, setOpen] = useState(false);
  return <details className="speech-playback" onToggle={event => setOpen(event.currentTarget.open)}><summary>Dengarkan jawaban</summary>
    {open && (engine && player ? <SpeechControls owner={owner} text={text} /> : <p className="muted">Browser ini belum mendukung pembacaan suara. Jawaban tetap tersedia sebagai teks.</p>)}
  </details>;
}

function SpeechControls({ owner, text }: { owner: string; text: string }) {
  const state = useSyncExternalStore(player!.subscribe, player!.getSnapshot);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]), [selected, setSelected] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    const refresh = () => {
      try { setVoices(engine!.getVoices().filter(voice => voice.localService === true)); }
      catch { setVoices([]); setError('Daftar suara belum dapat dimuat. Tutup lalu buka kembali kontrol suara.'); }
    };
    refresh(); engine!.addEventListener('voiceschanged', refresh);
    try { const saved = localStorage.getItem(speechVoiceKey); if (saved && saved.length <= 2000) setSelected(saved); }
    catch { setError('Pilihan suara tidak dapat dimuat. Pilih suara untuk sesi ini.'); }
    const stop = () => player!.stop(owner);
    window.addEventListener('pagehide', stop);
    return () => { engine!.removeEventListener('voiceschanged', refresh); window.removeEventListener('pagehide', stop); stop(); };
  }, [owner]);
  const voice = voices.find(item => voiceKey(item) === selected), playing = state.owner === owner && state.playing;
  function choose(value: string) {
    player!.stop(owner); setSelected(value); setError('');
    try { localStorage.setItem(speechVoiceKey, value); }
    catch { setError('Pilihan berlaku untuk sesi ini, tetapi belum tersimpan. Izinkan penyimpanan browser untuk mengingatnya.'); }
  }
  return <div className="speech-controls">
    <p className="muted">Putar secara manual dengan suara yang ditandai lokal oleh browser. Suara yang ditandai cloud tidak tersedia di sini. Teks dibaca apa adanya, termasuk kode dan tautan.</p>
    <label>Suara lokal<select value={voice ? selected : ''} onChange={event => choose(event.target.value)}><option value="">Pilih suara lokal</option>{voices.map(item => <option key={voiceKey(item)} value={voiceKey(item)}>{item.name} ({item.lang})</option>)}</select></label>
    {voice && <p className="muted">{voice.name} ({voice.lang})</p>}
    {!voices.length && <p className="muted">Belum ada suara lokal. Aktifkan suara di pengaturan perangkat atau gunakan browser yang mendukungnya.</p>}
    {selected && !voice && !!voices.length && <p className="notice">Suara tersimpan tidak tersedia. Pilih suara lokal lain.</p>}
    <div className="speech-actions"><button type="button" className="secondary" disabled={!voice || playing} onClick={() => player!.play(owner, text, selected)}>Putar jawaban</button><button type="button" className="secondary" disabled={!state.playing && !state.error} onClick={() => player!.stop()}>Hentikan</button></div>
    <p role="status">{playing ? 'Sedang membacakan jawaban.' : ''}</p>
    {(error || state.error) && <p className="error" role="alert">{error || state.error}</p>}
  </div>;
}
