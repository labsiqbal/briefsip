import { speechVoiceKey } from './speech.ts';

export const speechPreferenceKey = 'minarbot.speech.enabled.v1';
type SpeechPreference = { enabled: boolean; voice: string; error: string };

export function parseSpeechPreference(raw: string | null): boolean {
  if (raw === null) return false;
  const value = JSON.parse(raw);
  if (typeof value !== 'boolean') throw new Error('Saved voice preference is invalid.');
  return value;
}

export function createSpeechPreferenceStore(storage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage, events?: EventTarget) {
  function read(): SpeechPreference {
    try {
      const source = storage(), enabled = parseSpeechPreference(source.getItem(speechPreferenceKey)), voice = source.getItem(speechVoiceKey);
      return { enabled, voice: voice && voice.length <= 2000 ? voice : '', error: '' };
    } catch { return { enabled: false, voice: '', error: 'Voice settings could not be read. Allow browser storage and try again.' }; }
  }
  let state = read();
  const listeners = new Set<() => void>();
  function publish(next: SpeechPreference) {
    if (state.enabled === next.enabled && state.voice === next.voice && state.error === next.error) return;
    state = next; for (const listener of listeners) listener();
  }
  function sync(event: Event) {
    const { key, storageArea } = event as StorageEvent;
    if (key !== null && key !== speechPreferenceKey && key !== speechVoiceKey) return;
    try { if (storageArea !== storage()) return; } catch { publish(read()); return; }
    publish(read());
  }
  function write(key: string, value: string) {
    try { storage().setItem(key, value); publish(read()); return true; }
    catch { publish({ enabled: false, voice: '', error: 'Voice settings could not be saved. Allow browser storage and try again.' }); return false; }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      const first = !listeners.size;
      if (first) events?.addEventListener('storage', sync);
      listeners.add(listener); if (first) publish(read());
      return () => { listeners.delete(listener); if (!listeners.size) events?.removeEventListener('storage', sync); };
    },
    setEnabled(value: boolean) { return write(speechPreferenceKey, JSON.stringify(value)); },
    setVoice(value: string) { return write(speechVoiceKey, value); },
  };
}

export const speechPreferenceStore = createSpeechPreferenceStore(() => localStorage, typeof window === 'undefined' ? undefined : window);
