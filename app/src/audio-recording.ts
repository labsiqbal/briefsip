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
    try { recorder.stop(); } catch { fail('Rekaman tidak dapat diselesaikan. Coba rekam lagi.'); }
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
        if (size > 10 * 1024 * 1024) { fail('Rekaman melebihi 10 MiB. Rekam ulang dengan durasi lebih singkat.'); return; }
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => fail('Mikrofon atau perekam terputus. Coba rekam lagi.');
      recorder.onstop = () => {
        release(); if (cancelled) return;
        cancelled = true; onState('idle');
        if (!size) { onError('Rekaman kosong. Periksa mikrofon lalu coba lagi.'); return; }
        const type = recorder!.mimeType || mimeType, extension = type.includes('webm') ? 'webm' : type.includes('ogg') ? 'ogg' : 'm4a';
        onFile(new File(chunks, `rekaman-${crypto.randomUUID()}.${extension}`, { type })); chunks.length = 0;
      };
      recorder.start(1000); onState('recording');
      // ponytail: five-minute capture; longer sessions need streamed durable storage.
      timer = setTimeout(stop, 5 * 60 * 1000);
    } catch { fail('Mikrofon tidak tersedia atau izin ditolak. Gunakan HTTPS/localhost dan periksa izin mikrofon browser.'); }
  })();
  return { stop, cancel };
}
