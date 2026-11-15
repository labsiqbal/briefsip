import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPolling } from './src/hooks/polling.ts';
import { downloadBlob } from './src/hooks/downloadBlob.ts';

class Visibility extends EventTarget {
  hidden = false;
  change(hidden: boolean) { this.hidden = hidden; this.dispatchEvent(new Event('visibilitychange')); }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('polling serializes slow runs, pauses hidden tabs, resumes and aborts late writes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new Visibility();
  let calls = 0, writes = 0, finish!: () => void, signal!: AbortSignal;
  const stop = startPolling(async current => {
    calls++; signal = current;
    await new Promise<void>(resolve => { finish = resolve; });
    if (!current.aborted) writes++;
  }, { interval: 100 }, document);
  await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(10000); await flush(); assert.equal(calls, 1);
  document.change(true); finish(); await flush(); assert.equal(writes, 1);
  t.mock.timers.tick(10000); await flush(); assert.equal(calls, 1);
  document.change(false); await flush(); assert.equal(calls, 2);
  document.change(true); document.change(false); await flush(); assert.equal(calls, 2);
  finish(); await flush();
  t.mock.timers.tick(99); await flush(); assert.equal(calls, 2);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 3);
  stop(); assert.equal(signal.aborted, true); finish(); await flush(); assert.equal(writes, 2);
  document.change(true); document.change(false); t.mock.timers.tick(10000); await flush(); assert.equal(calls, 3);
});

test('disabled, initially hidden and delayed polling do not run early', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new Visibility(); let calls = 0;
  const disabled = startPolling(() => { calls++; }, { interval: 100, enabled: false }, document);
  document.change(true); document.change(false); t.mock.timers.tick(1000); await flush(); assert.equal(calls, 0); disabled();
  const cancelledBeforeStart = startPolling(() => { calls++; }, { interval: 100 }, document);
  document.change(true); await flush(); assert.equal(calls, 0); cancelledBeforeStart();
  const hidden = startPolling(() => { calls++; }, { interval: 100 }, document);
  t.mock.timers.tick(1000); await flush(); assert.equal(calls, 0);
  document.change(false); await flush(); assert.equal(calls, 1); hidden();
  const delayed = startPolling(() => { calls++; }, { interval: 100, immediate: false }, document);
  await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(100); await flush(); assert.equal(calls, 2); delayed();
});

test('dependency restart waits for prior uncooperative request and drops its writes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new Visibility(), flight = { current: null as Promise<void | number> | null };
  let finish!: () => void, oldWrites = 0, newCalls = 0;
  const old = startPolling(async signal => { await new Promise<void>(resolve => { finish = resolve; }); if (!signal.aborted) oldWrites++; }, { interval: 100 }, document, flight);
  await flush(); old();
  const next = startPolling(() => { newCalls++; }, { interval: 100 }, document, flight);
  await flush(); assert.equal(newCalls, 0);
  finish(); await flush(); assert.equal(newCalls, 1); assert.equal(oldWrites, 0);
  t.mock.timers.tick(100); await flush(); assert.equal(newCalls, 2); next();
});

test('errors back off to cap, success resets delay and dynamic chat intervals survive', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new Visibility(); let calls = 0;
  const stop = startPolling(() => { calls++; if (calls <= 6) throw new Error('offline'); return calls === 7 ? 250 : undefined; }, { interval: 1000, backoff: true }, document);
  await flush();
  for (const delay of [2000, 4000, 8000, 16000, 32000, 32000]) {
    const before = calls; t.mock.timers.tick(delay - 1); await flush(); assert.equal(calls, before);
    t.mock.timers.tick(1); await flush(); assert.equal(calls, before + 1);
  }
  t.mock.timers.tick(249); await flush(); assert.equal(calls, 7);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 8);
  t.mock.timers.tick(999); await flush(); assert.equal(calls, 8);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 9); stop();
  for (const interval of [0, -1, NaN, Infinity]) assert.throws(() => startPolling(() => {}, { interval }, document), RangeError);
});

test('existing fixed error cadence remains unchanged without backoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stop = startPolling(async () => { calls++; throw new Error('offline'); }, { interval: 100 }, new Visibility());
  await flush(); t.mock.timers.tick(100); await flush(); assert.equal(calls, 2); stop();
});

test('download attaches, clicks and removes link, then revokes URL after one second, including failed clicks', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const events: string[] = [], blob = new Blob(['data']); let fail = false;
  const link = { href: '', download: '', click() { events.push('click'); if (fail) throw new Error('click failed'); }, remove() { events.push('remove'); } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement(tag: string) { assert.equal(tag, 'a'); return link; }, body: { append(node: unknown) { assert.equal(node, link); events.push('append'); } } } });
  t.mock.method(URL, 'createObjectURL', (value: Blob) => { assert.equal(value, blob); return 'blob:download'; });
  t.mock.method(URL, 'revokeObjectURL', (url: string) => { assert.equal(url, 'blob:download'); events.push('revoke'); });
  try {
    downloadBlob(blob, 'file.zip'); assert.equal(link.href, 'blob:download'); assert.equal(link.download, 'file.zip');
    assert.deepEqual(events, ['append', 'click', 'remove']);
    t.mock.timers.tick(999); assert.equal(events.length, 3); t.mock.timers.tick(1); assert.equal(events.at(-1), 'revoke');
    events.length = 0; fail = true; assert.throws(() => downloadBlob(blob, 'file.zip'), /click failed/);
    t.mock.timers.tick(1000); assert.deepEqual(events, ['append', 'click', 'remove', 'revoke']);
  } finally { if (saved) Object.defineProperty(globalThis, 'document', saved); else Reflect.deleteProperty(globalThis, 'document'); }
});

test('polling refreshes on window focus and removes focus listener on stop', async t => {
  const focus = new EventTarget();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: focus });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  const document = new Visibility();
  let calls = 0;
  const stop = startPolling(() => { calls++; }, { interval: 60000 }, document);
  await flush(); assert.equal(calls, 1);
  focus.dispatchEvent(new Event('focus')); await flush(); assert.equal(calls, 2);
  document.change(true); focus.dispatchEvent(new Event('focus')); await flush(); assert.equal(calls, 2);
  stop(); focus.dispatchEvent(new Event('focus')); await flush(); assert.equal(calls, 2);
});
