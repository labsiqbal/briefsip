import { useEffect, useState, useSyncExternalStore } from 'react';
import { Square, Volume2 } from 'lucide-react';
import { Button, Card, Row, Section, Select, Switch, Tooltip } from './ui/kit';
import { createSpeechPlayer, voiceKey } from '../speech';
import { speechPreferenceStore } from '../speech-preference';
import './SpeechPlayback.css';

const engine = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window ? window.speechSynthesis : null;
const player = engine ? createSpeechPlayer(engine, text => new SpeechSynthesisUtterance(text)) : null;
const idle = { owner: '', playing: false, error: '' };
const subscribeIdle = () => () => {};
const getIdle = () => idle;
// Stop immediately on opt-out or a voice change, including changes from another tab.
speechPreferenceStore.subscribe(() => player?.stop());

function usePlayback(owner: string) {
  const state = useSyncExternalStore(player?.subscribe ?? subscribeIdle, player?.getSnapshot ?? getIdle);
  useEffect(() => {
    const stop = () => { player?.stop(owner); };
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); stop(); };
  }, [owner]);
  return { playing: state.owner === owner && state.playing, error: state.owner === owner ? state.error : '' };
}

export function SpeechPlayback({ owner, text }: { owner: string; text: string }) {
  const preference = useSyncExternalStore(speechPreferenceStore.subscribe, speechPreferenceStore.getSnapshot);
  return preference.enabled && player ? <SpeechButton owner={owner} text={text} voice={preference.voice} /> : null;
}

function SpeechButton({ owner, text, voice }: { owner: string; text: string; voice: string }) {
  const { playing, error } = usePlayback(owner);
  const [notice, setNotice] = useState('');
  useEffect(() => setNotice(''), [voice]);
  function listen() {
    setNotice('');
    if (playing) { player!.stop(owner); return; }
    try {
      if (!engine!.getVoices().some(item => item.localService === true && voiceKey(item) === voice)) {
        setNotice('Pick a voice in Settings > Appearance.'); return;
      }
      player!.play(owner, text, voice);
    } catch { setNotice('Voice unavailable. Pick a voice in Settings > Appearance.'); }
  }
  const label = playing ? 'Stop' : 'Listen';
  return <span className="speech-playback"><Tooltip content={playing ? 'Stop reading' : 'Listen to answer'}><Button size="sm" variant="ghost" aria-label={label} icon={playing ? <Square size={14} aria-hidden /> : <Volume2 size={14} aria-hidden />} onClick={listen}>{label}</Button></Tooltip>{(notice || error) && <span className="k-field__error" role="status">{notice || error}</span>}</span>;
}

export function VoiceSettings() {
  const preference = useSyncExternalStore(speechPreferenceStore.subscribe, speechPreferenceStore.getSnapshot);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const { playing, error } = usePlayback('settings-voice-test');
  useEffect(() => {
    if (!engine) return;
    const refresh = () => {
      try { setVoices(engine.getVoices().filter(voice => voice.localService === true)); }
      catch { setVoices([]); }
    };
    refresh(); engine.addEventListener('voiceschanged', refresh);
    return () => engine.removeEventListener('voiceschanged', refresh);
  }, []);
  const voice = voices.find(item => voiceKey(item) === preference.voice);
  const unavailable = !engine ? 'This browser does not support speech playback.' : !voices.length ? 'No local voices available. Install a device voice or use a supported browser.' : '';
  return <Section title="Voice" id="voice-settings"><Card>
    <Row title="Read answers aloud" meta={<>Adds a Listen button to agent replies. Uses voices installed on this device; nothing is sent to the cloud.{unavailable && <span className="voice-settings__notice">{unavailable}</span>}</>} trailing={<Switch label="Read answers aloud" checked={preference.enabled} disabled={!!unavailable} onChange={speechPreferenceStore.setEnabled} />} />
    {preference.enabled && <Row title="Local voice" meta={preference.voice && !voice ? 'Saved voice unavailable. Choose another local voice.' : undefined} trailing={<span className="k-row-actions"><Select size="sm" label="Local voice" value={voice ? preference.voice : ''} onChange={speechPreferenceStore.setVoice} disabled={!voices.length} placeholder="Choose local voice" options={voices.map(item => ({ value: voiceKey(item), label: `${item.name} (${item.lang})` }))} /><Button size="sm" variant="ghost" disabled={!voice} icon={<Volume2 size={14} aria-hidden />} onClick={() => playing ? player?.stop('settings-voice-test') : player?.play('settings-voice-test', 'This is your selected voice in Briefsip.', preference.voice)}>{playing ? 'Stop test' : 'Test voice'}</Button></span>} />}
  </Card>{(preference.error || error) && <p className="k-field__error" role="status">{preference.error || error}</p>}</Section>;
}
