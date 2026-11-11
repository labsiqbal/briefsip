import { useEffect, useRef, useState } from 'react';
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
    return () => { active.current = false; cancel(); window.removeEventListener('pagehide', cancel); };
  }, []);
  useEffect(() => { if (disabled) session.current?.cancel(); }, [disabled]);
  useEffect(() => { if (!file) { setUrl(''); return; } const value = URL.createObjectURL(file); setUrl(value); return () => URL.revokeObjectURL(value); }, [file]);
  function start() {
    if (disabled || capturing.current || state !== 'idle' || file) return;
    capturing.current = true;
    setError('');
    session.current = startAudioRecording(value => { capturing.current = value !== 'idle'; if (active.current) { setState(value); onRecording(value !== 'idle'); } }, value => { if (active.current) setFile(value); }, value => { if (active.current) setError(value); });
  }
  return <section className="speech-controls" aria-label="Rekam audio">
    <p>Rekam mikrofon di browser, maksimum 5 menit dan 10 MiB. Rekaman belum diunggah atau dikirim ke provider. Unduh salinan sebelum menutup panel, pindah halaman, atau memuat ulang agar rekaman tidak hilang.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <p role="status">{state === 'requesting' ? 'Menunggu izin mikrofon...' : state === 'recording' ? 'Mikrofon sedang merekam.' : state === 'stopping' ? 'Menyelesaikan rekaman...' : file ? 'Rekaman siap.' : 'Mikrofon tidak aktif.'}</p>
    <button type="button" className="secondary" disabled={disabled || state !== 'idle' || !!file} onClick={start}>Mulai rekam</button>
    {state === 'recording' && <button type="button" onClick={() => session.current?.stop()}>Selesai merekam</button>}
    {state !== 'idle' && <button type="button" className="secondary" onClick={() => session.current?.cancel()}>Batalkan rekaman</button>}
    {file && <><audio controls src={url} /><a href={url} download={file.name}>Unduh rekaman</a><button type="button" disabled={disabled} onClick={() => { onReady(file); setFile(null); }}>Pilih untuk unggah</button><button type="button" className="secondary" onClick={() => setFile(null)}>Buang rekaman</button></>}
  </section>;
}
