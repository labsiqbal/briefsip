import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechPreferenceStore, parseSpeechPreference, speechPreferenceKey } from './speech-preference.ts';
import { speechVoiceKey } from './speech.ts';

function fixture(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial)), events = new EventTarget();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const store = createSpeechPreferenceStore(() => storage, events);
  const change = (key: string | null, source = storage) => events.dispatchEvent(Object.assign(new Event('storage'), { key, storageArea: source }));
  return { store, storage, values, change };
}

test('voice defaults off and accepts only stored booleans', () => {
  assert.equal(parseSpeechPreference(null), false);
  assert.equal(parseSpeechPreference('false'), false);
  assert.equal(parseSpeechPreference('true'), true);
  for (const raw of ['', 'garbage', 'null', '1', '"true"', '{}', '[]', '{"enabled":true}']) {
    assert.throws(() => parseSpeechPreference(raw));
    assert.equal(fixture({ [speechPreferenceKey]: raw }).store.getSnapshot().enabled, false);
  }
  assert.deepEqual(fixture().store.getSnapshot(), { enabled: false, voice: '', error: '' });
});

test('voice blocked storage reads and writes fail closed without throwing', () => {
  const store = createSpeechPreferenceStore(() => { throw new Error('blocked'); });
  assert.equal(store.getSnapshot().enabled, false);
  assert.equal(store.setEnabled(true), false);
  assert.equal(store.getSnapshot().enabled, false);
  const f = fixture({ [speechPreferenceKey]: 'true' });
  const off = f.store.subscribe(() => {});
  f.storage.setItem = () => { throw new Error('quota'); };
  assert.equal(f.store.setEnabled(true), false);
  assert.equal(f.store.getSnapshot().enabled, false);
  assert(f.store.getSnapshot().error);
  assert.equal(f.store.setVoice('voice'), false);
  const offSecond = f.store.subscribe(() => {});
  assert.equal(f.store.getSnapshot().enabled, false, 'New replies must not undo a failed write');
  offSecond(); off();
});

test('voice updates all same-tab subscribers, retains saved voice and unsubscribes', () => {
  const f = fixture({ [speechVoiceKey]: 'saved voice' });
  let first = 0, second = 0;
  const offFirst = f.store.subscribe(() => first++), offSecond = f.store.subscribe(() => second++);
  assert.equal(f.store.getSnapshot().voice, 'saved voice');
  assert.equal(f.store.setEnabled(true), true);
  assert.equal(f.values.get(speechPreferenceKey), 'true');
  assert.equal(first, 1); assert.equal(second, 1);
  f.store.setVoice('new voice'); assert.equal(f.values.get(speechVoiceKey), 'new voice');
  assert.equal(f.store.getSnapshot().voice, 'new voice');
  offFirst(); f.store.setEnabled(false);
  assert.equal(first, 2); assert.equal(second, 3);
  assert.equal(f.store.getSnapshot().voice, 'new voice'); offSecond();
});

test('voice cross-tab changes, clear, invalid values and subscription gap refresh live', () => {
  const f = fixture();
  f.values.set(speechPreferenceKey, 'true');
  let updates = 0;
  const off = f.store.subscribe(() => updates++);
  assert.equal(f.store.getSnapshot().enabled, true); assert.equal(updates, 1);
  f.values.set(speechPreferenceKey, 'false'); f.change('other-key');
  assert.equal(f.store.getSnapshot().enabled, true);
  f.change(speechPreferenceKey, { ...f.storage }); assert.equal(f.store.getSnapshot().enabled, true);
  f.change(speechPreferenceKey); assert.equal(f.store.getSnapshot().enabled, false);
  f.values.set(speechVoiceKey, 'cross-tab voice'); f.change(speechVoiceKey);
  assert.equal(f.store.getSnapshot().voice, 'cross-tab voice');
  f.values.set(speechPreferenceKey, 'broken'); f.change(speechPreferenceKey);
  assert.equal(f.store.getSnapshot().enabled, false); assert(f.store.getSnapshot().error);
  f.values.clear(); f.change(null);
  assert.deepEqual(f.store.getSnapshot(), { enabled: false, voice: '', error: '' });
  off(); const previous = updates;
  f.values.set(speechPreferenceKey, 'true'); f.change(speechPreferenceKey); assert.equal(updates, previous);
  const stop = f.store.subscribe(() => updates++); assert.equal(f.store.getSnapshot().enabled, true); stop();
});
