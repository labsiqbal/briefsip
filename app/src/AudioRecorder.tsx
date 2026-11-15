import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from './ui/kit';
import { startAudioRecording, type RecordingState } from './audio-recording';

export function AudioRecorder({ disabled, onReady, onRecording }: { disabled: boolean; onReady: (file: File) => void; onRecording: (value: boolean) => void }) {
  const [state, setState] = useState<RecordingState>('idle'), [file, setFile] = useState<File | null>(null), [error, setError] = useState(''), [url, setUrl] = useState('');
  const session = useRef<ReturnType<typeof startAudioRecording> | null>(null);
  const active = useRef(true);
  const capturing = useRef(false);
  useEffect(() => {
    active.current = true;
    const cancel = () => session.current?.cancel();
    window.addEventListener('pagehide', cancel);
    return () => { active.current = false; cancel(); onRecording(false); window.removeEventListener('pagehide', cancel); };
  }, []);
  useEffect(() => { if (disabled) session.current?.cancel(); }, [disabled]);
  useEffect(() => { if (!file) { setUrl(''); return; } const value = URL.createObjectURL(file); setUrl(value); return () => URL.revokeObjectURL(value); }, [file]);
  function start() {
    if (disabled || capturing.current || state !== 'idle' || file) return;
    capturing.current = true;
    setError('');
    session.current = startAudioRecording(value => { capturing.current = value !== 'idle'; if (active.current) { setState(value); onRecording(value !== 'idle'); } }, value => { if (active.current) setFile(value); }, value => { if (active.current) setError(value); });
  }
  // ponytail: active CSP blocks blob media; add in-panel playback after an approved media policy.
  return <section className="k-stack bs-root" aria-label="Record audio">
    {error && <Alert tone="error">{error}</Alert>}
    <p className={state === 'idle' && !file ? 'sr-only' : undefined} role="status">{state === 'requesting' ? 'Waiting for microphone permission...' : state === 'recording' ? 'Microphone is recording.' : state === 'stopping' ? 'Finishing recording...' : file ? 'Recording ready.' : 'Microphone inactive.'}</p>
    <Button size="sm" disabled={disabled || state !== 'idle' || !!file} onClick={start}>Start recording</Button>
    {state === 'recording' && <Button size="sm" onClick={() => session.current?.stop()}>Finish recording</Button>}
    {state !== 'idle' && <Button size="sm" onClick={() => session.current?.cancel()}>Cancel recording</Button>}
    {file && <><a className="k-link" href={url} download={file.name}>Download recording</a><Button size="sm" disabled={disabled} onClick={() => { onReady(file); setFile(null); }}>Choose for upload</Button><Button size="sm" onClick={() => setFile(null)}>Discard recording</Button></>}
  </section>;
}
