export type RecordingState = 'requesting' | 'recording' | 'stopping' | 'idle';
export function startAudioRecording(onState: (state: RecordingState) => void, onFile: (file: File) => void, onError: (message: string) => void) {
  let cancelled = false, recorder: MediaRecorder | undefined, stream: MediaStream | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, size = 0;
  const chunks: Blob[] = [];
  const release = () => { clearTimeout(timer); stream?.getTracks().forEach(track => track.stop()); };
  const cancel = () => { cancelled = true; release(); if (recorder?.state === 'recording') { try { recorder.stop(); } catch { /* Tracks already stopped. */ } } chunks.length = 0; onState('idle'); };
  const fail = (message: string) => { if (cancelled) return; cancel(); onError(message); };
  const stop = () => {
    if (cancelled || !recorder || recorder.state !== 'recording') return;
    onState('stopping');
    try { recorder.stop(); } catch { fail('Recording could not be completed. Try recording again.'); }
    finally { release(); }
  };
  onState('requesting');
  void (async () => {
    try {
      if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Unavailable');
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('Unsupported');
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (cancelled) { release(); return; }
      recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
      recorder.ondataavailable = event => {
        if (cancelled) return;
        size += event.data.size;
        if (size > 10 * 1024 * 1024) { fail('Recording exceeds 10 MiB. Record again for a shorter duration.'); return; }
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => fail('Microphone or recorder disconnected. Record again.');
      recorder.onstop = () => {
        release(); if (cancelled) return;
        cancelled = true; onState('idle');
        if (!size) { onError('Recording is empty. Check the microphone and try again.'); return; }
        const type = recorder!.mimeType || mimeType, extension = type.includes('webm') ? 'webm' : type.includes('ogg') ? 'ogg' : 'm4a';
        onFile(new File(chunks, `recording-${crypto.randomUUID()}.${extension}`, { type })); chunks.length = 0;
      };
      recorder.start(1000); onState('recording');
      // ponytail: five-minute capture; longer sessions need streamed durable storage.
      timer = setTimeout(stop, 5 * 60 * 1000);
    } catch { fail('Microphone unavailable or permission denied. Use HTTPS/localhost and check browser microphone permissions.'); }
  })();
  return { stop, cancel };
}
