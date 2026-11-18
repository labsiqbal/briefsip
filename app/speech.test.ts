import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechPlayer, speechChunks, voiceKey } from './shared/speech.ts';

const local: SpeechSynthesisVoice = { voiceURI: 'local/id', name: 'Lokal', lang: 'id-ID', localService: true, default: false };
function fixture() {
  let voices = [local], cancelled = 0;
  const sent: SpeechSynthesisUtterance[] = [];
  const engine = { getVoices: () => voices, cancel: () => { cancelled++; }, speak: (utterance: SpeechSynthesisUtterance) => { sent.push(utterance); } };
  const player = createSpeechPlayer(engine, text => ({ text } as SpeechSynthesisUtterance));
  const end = (utterance: SpeechSynthesisUtterance) => utterance.onend?.call(utterance, {} as SpeechSynthesisEvent);
  const error = (utterance: SpeechSynthesisUtterance) => utterance.onerror?.call(utterance, {} as SpeechSynthesisErrorEvent);
  return { player, sent, engine, end, error, setVoices: (value: SpeechSynthesisVoice[]) => { voices = value; }, get cancelled() { return cancelled; } };
}

test('speech preserves all text and Unicode, bounds chunks and rejects invalid size', () => {
  const text = 'A '.repeat(170) + '\u{1f600}'.repeat(200) + '\nhttps://example.com/ ' + 'B'.repeat(250);
  const chunks = speechChunks(text);
  assert.equal(chunks.join(''), text);
  assert(chunks.every(chunk => Array.from(chunk).length <= 180 && !/[\uD800-\uDFFF]/u.test(chunk)));
  for (const bad of ['', ' \n ', 'x'.repeat(64001)]) assert.throws(() => speechChunks(bad));
  assert.equal(speechChunks('x'.repeat(64000)).join('').length, 64000);
});

test('speech is manual, local-only, sequential and refuses missing or changed voice', () => {
  const f = fixture();
  assert.equal(f.sent.length, 0);
  const remote = { ...local, localService: false };
  f.setVoices([remote]); f.player.play('a', 'private text', voiceKey(remote));
  assert.equal(f.sent.length, 0); assert(f.player.getSnapshot().error);
  f.setVoices([local]); f.player.play('a', 'private text', 'missing');
  assert.equal(f.sent.length, 0);
  const text = 'word '.repeat(100);
  f.player.play('a', text, voiceKey(local)); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].voice, local); assert.equal(f.sent[0].lang, 'id-ID');
  for (let i = 0; i < f.sent.length; i++) f.end(f.sent[i]);
  assert.equal(f.sent.map(item => item.text).join(''), text); assert.equal(f.player.getSnapshot().playing, false);
  f.player.play('a', text, voiceKey(local)); const count = f.sent.length;
  f.setVoices([remote]); f.end(f.sent.at(-1)!);
  assert.equal(f.sent.length, count); assert(f.player.getSnapshot().error);
  f.player.stop();
});

test('speech replacement, owner cleanup and stale events cannot stop or advance newer playback', () => {
  const f = fixture(); let updates = 0;
  const unsubscribe = f.player.subscribe(() => updates++);
  f.player.play('a', 'a '.repeat(200), voiceKey(local)); const a = f.sent[0];
  f.player.play('b', 'b '.repeat(200), voiceKey(local)); const b = f.sent[1];
  const cancelled = f.cancelled;
  f.player.stop('a'); assert.equal(f.cancelled, cancelled);
  f.end(a); f.error(a); assert.equal(f.sent.length, 2); assert.equal(f.player.getSnapshot().owner, 'b');
  f.end(b); const count = f.sent.length; f.end(b); assert.equal(f.sent.length, count);
  f.player.stop('b'); f.end(f.sent.at(-1)!); assert.equal(f.sent.length, count);
  assert.equal(f.player.getSnapshot().playing, false); assert(updates > 0);
  unsubscribe(); const previous = updates; f.player.stop(); assert.equal(updates, previous);
});

test('speech errors stop without replay; retry requires explicit play', () => {
  const f = fixture();
  f.player.play('a', 'text', voiceKey(local)); f.error(f.sent[0]);
  assert.equal(f.player.getSnapshot().playing, false); assert(f.player.getSnapshot().error); assert.equal(f.sent.length, 1);
  f.player.play('a', 'text', voiceKey(local)); assert.equal(f.sent.length, 2); f.end(f.sent[1]);
  f.engine.speak = () => { throw new Error('native private error'); };
  f.player.play('a', 'private text', voiceKey(local));
  assert(f.player.getSnapshot().error); assert(!f.player.getSnapshot().error.includes('native private'));
  f.player.stop();
});

test('speech without a completion callback times out and cannot replay from a late callback', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.player.play('a', 'text '.repeat(100), voiceKey(local));
  t.mock.timers.tick(30000);
  assert.equal(f.player.getSnapshot().playing, false); assert(f.player.getSnapshot().error);
  f.end(f.sent[0]); assert.equal(f.sent.length, 1);
  f.player.stop();
});

test('native cancel failure retains active status and blocks replacement until stop succeeds', () => {
  const f = fixture(); f.player.play('a', 'text', voiceKey(local));
  const cancel = f.engine.cancel;
  try {
    f.engine.cancel = () => { throw new Error('native cancel unavailable'); };
    f.player.stop('a'); assert.equal(f.player.getSnapshot().playing, true); assert(f.player.getSnapshot().error);
    f.player.play('b', 'new text', voiceKey(local)); assert.equal(f.sent.length, 1);
    assert.equal(f.player.getSnapshot().owner, 'a');
  } finally { f.engine.cancel = cancel; f.player.stop(); }
  assert.equal(f.player.getSnapshot().playing, false);
});
