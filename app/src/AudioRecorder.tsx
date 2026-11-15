// Inline capture pattern adapted from T3 VoiceInputPill (MIT, see app/t3/NOTICE).
import { Mic, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from './ui/kit';
import { startAudioRecording, type RecordingState } from './audio-recording';

export function AudioRecorder({ disabled, onReady, onRecording }: { disabled: boolean; onReady: (file: File) => void; onRecording: (value: boolean) => void }) {
  const [state, setState] = useState<RecordingState>('idle'), [seconds, setSeconds] = useState(0), [error, setError] = useState('');
  const session = useRef<ReturnType<typeof startAudioRecording> | null>(null), active = useRef(true), capturing = useRef(false);
  const callbacks = useRef({ onReady, onRecording });
  callbacks.current = { onReady, onRecording };
  useEffect(() => {
    active.current = true;
    const cancel = () => session.current?.cancel();
    window.addEventListener('pagehide', cancel);
    return () => { active.current = false; cancel(); callbacks.current.onRecording(false); window.removeEventListener('pagehide', cancel); };
  }, []);
  useEffect(() => { if (disabled) session.current?.cancel(); }, [disabled]);
  useEffect(() => {
    if (state !== 'recording') return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, [state]);
  function start() {
    if (disabled || capturing.current) return;
    capturing.current = true; setError(''); setSeconds(0);
    session.current = startAudioRecording(value => {
      capturing.current = value !== 'idle';
      if (active.current) { setState(value); callbacks.current.onRecording(value !== 'idle'); }
    }, file => { if (active.current) callbacks.current.onReady(file); }, value => { if (active.current) setError(value); });
  }
  return <span className="voice-input">
    {state === 'idle' ? !disabled && <IconButton label="Record audio" onClick={start}><Mic size={14} aria-hidden /></IconButton> : <span className="voice-input__pill" role="group" aria-label="Audio recording">
      {state === 'recording' && <span className="voice-input__dot" aria-hidden />}
      <span className="voice-input__timer" role="timer" aria-label={state === 'requesting' ? 'Waiting for microphone' : state === 'stopping' ? 'Finishing recording' : 'Recording duration'}>{state === 'recording' ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : state === 'requesting' ? 'Connecting…' : 'Finishing…'}</span>
      {state === 'recording' && <IconButton label="Stop recording" onClick={() => session.current?.stop()}><Square size={14} aria-hidden /></IconButton>}
      <IconButton label="Cancel recording" onClick={() => session.current?.cancel()}><X size={14} aria-hidden /></IconButton>
    </span>}
    {error && <span className="voice-input__error message-error" role="alert">{error}<IconButton label="Dismiss recording error" onClick={() => setError('')}><X size={14} aria-hidden /></IconButton></span>}
  </span>;
}
