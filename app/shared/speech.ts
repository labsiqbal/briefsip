export const speechVoiceKey = 'briefsip.speech.voice.v1';
export const voiceKey = (voice: Pick<SpeechSynthesisVoice, 'voiceURI' | 'name' | 'lang'>) => JSON.stringify([voice.voiceURI, voice.name, voice.lang]);

export function speechChunks(text: string) {
  if (!text.trim() || text.length > 64000) throw new Error('Answer must contain 1 to 64,000 characters.');
  const chars = Array.from(text), chunks: string[] = [];
  for (let start = 0; start < chars.length;) {
    let end = Math.min(start + 180, chars.length);
    if (end < chars.length) for (let split = end; split > start + 90; split--) {
      if (/\s/.test(chars[split - 1])) { end = split; break; }
    }
    chunks.push(chars.slice(start, end).join('')); start = end;
  }
  return chunks;
}

export function createSpeechPlayer(engine: Pick<SpeechSynthesis, 'getVoices' | 'speak' | 'cancel'>, makeUtterance: (text: string) => SpeechSynthesisUtterance) {
  let state = { owner: '', playing: false, error: '' }, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: typeof state) => { state = next; for (const listener of listeners) listener(); };
  function stop(owner?: string) {
    if (owner !== undefined && state.owner !== owner) return;
    generation++; clearTimeout(timer);
    // Invalidate callbacks before cancel: some engines dispatch cancellation synchronously.
    try { engine.cancel(); } catch {
      publish({ ...state, error: 'Voice could not be stopped. Try Stop again or close this tab.' }); return false;
    }
    publish({ owner: '', playing: false, error: '' });
    return true;
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    stop,
    play(owner: string, text: string, selected: string) {
      if (!stop()) return; const current = generation;
      function fail(message: string) { if (generation !== current || !stop()) return; publish({ owner, playing: false, error: message }); }
      let chunks: string[];
      try { chunks = speechChunks(text); } catch { fail('Answer is empty or too long to read.'); return; }
      let index = 0;
      function next() {
        if (generation !== current) return;
        clearTimeout(timer);
        if (index === chunks.length) { publish({ owner: '', playing: false, error: '' }); return; }
        try {
          const voice = engine.getVoices().find(item => item.localService === true && voiceKey(item) === selected);
          if (!voice) { fail('Local voice unavailable. Pick a voice in Settings > Appearance.'); return; }
          const utterance = makeUtterance(chunks[index++]);
          utterance.voice = voice; utterance.lang = voice.lang; utterance.rate = 1;
          let settled = false;
          utterance.onend = () => { if (!settled) { settled = true; next(); } };
          utterance.onerror = () => { if (!settled) { settled = true; fail('Reading stopped. Check device audio and try again.'); } };
          timer = setTimeout(() => fail('Voice did not respond. Check device audio and try again.'), 30000);
          publish({ owner, playing: true, error: '' }); engine.speak(utterance);
        } catch { fail('Speech playback unavailable. Check device audio and try again.'); }
      }
      next();
    },
  };
}
