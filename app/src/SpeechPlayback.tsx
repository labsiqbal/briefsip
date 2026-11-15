import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Info, Square, Volume2 } from 'lucide-react';
import { Button, Card, Row, Section, Select, Switch, IconButton, Badge, Tooltip } from './ui/kit';
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
        setNotice('Pick a voice in Settings > General.'); return;
      }
      player!.play(owner, text, voice);
    } catch { setNotice('Voice unavailable. Pick a voice in Settings > General.'); }
  }
  const label = playing ? 'Stop' : 'Listen';
  return <span className="speech-playback"><IconButton label={playing ? 'Stop reading' : 'Listen to answer'} aria-label={label} onClick={listen}>{playing ? <Square size={14} aria-hidden /> : <Volume2 size={14} aria-hidden />}</IconButton>{(notice || error) && <span className="k-field__error" role="status">{notice || error}</span>}</span>;
}

export function VoiceSettings({ scope }: { scope?: ReactNode }) {
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
    <Row title="Read aloud" trailing={<>{unavailable && <Tooltip content={unavailable}><span tabIndex={0}><Badge>{!engine ? 'Unavailable' : 'No local voices'}</Badge></span></Tooltip>}<IconButton label="Adds Listen to replies. Local voices only." aria-label="About read aloud"><Info size={14} aria-hidden /></IconButton>{scope}<Switch label="Read aloud" checked={preference.enabled} disabled={!!unavailable} onChange={speechPreferenceStore.setEnabled} /></>} />
    {preference.enabled && <Row title="Voice" meta={preference.voice && !voice ? 'Saved voice unavailable.' : undefined} trailing={<span className="k-row-actions"><Select size="sm" label="Voice" value={voice ? preference.voice : ''} onChange={speechPreferenceStore.setVoice} disabled={!voices.length} placeholder="Choose voice" options={voices.map(item => ({ value: voiceKey(item), label: `${item.name} (${item.lang})` }))} /><Button size="sm" variant="ghost" aria-label={playing ? 'Stop voice test' : 'Test voice'} disabled={!voice} icon={<Volume2 size={14} aria-hidden />} onClick={() => playing ? player?.stop('settings-voice-test') : player?.play('settings-voice-test', 'This is your selected voice in Briefsip.', preference.voice)}>{playing ? 'Stop' : 'Test'}</Button></span>} />}
  </Card>{(preference.error || error) && <p className="k-field__error" role="status">{preference.error || error}</p>}</Section>;
}
