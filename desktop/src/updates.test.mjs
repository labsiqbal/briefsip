import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { configureUpdates, UPDATE_INTERVAL_MS, updateFeedUrl } from './updates.mjs';

test('update feed requires clean HTTPS directory URL', () => {
  assert.equal(updateFeedUrl('https://nuc.test:4318/desktop'), 'https://nuc.test:4318/desktop/');
  assert.equal(updateFeedUrl(undefined), null);
  for (const url of ['http://nuc.test', 'https://user:pass@nuc.test', 'https://nuc.test/?token=secret', 'file:///tmp/feed']) assert.throws(() => updateFeedUrl(url));
});
test('updates check on launch and each six hours; download in background, restart only on consent', async () => {
  const updater = new EventEmitter(); let checks = 0; let installs = 0; let tick; let cleared = false; let answer = 1;
  updater.setFeedURL = (options) => assert.deepEqual(options, { provider: 'generic', url: 'https://nuc.test/feed/' });
  updater.checkForUpdates = async () => { checks++; return {}; };
  updater.quitAndInstall = (silent, restart) => { assert.equal(silent, false); assert.equal(restart, true); installs++; };
  const updates = configureUpdates({ updater, feed: 'https://nuc.test/feed/', enabled: true, prompt: async () => answer, timers: {
    setInterval(callback, ms) { assert.equal(ms, UPDATE_INTERVAL_MS); tick = callback; return 7; },
    clearInterval(id) { assert.equal(id, 7); cleared = true; },
  } });
  await new Promise(setImmediate); assert.equal(checks, 1); assert.equal(updater.autoDownload, true); assert.equal(updater.autoInstallOnAppQuit, false);
  tick(); await new Promise(setImmediate); assert.equal(checks, 2);
  updater.emit('update-downloaded'); await new Promise(setImmediate); assert.equal(installs, 0);
  answer = 0; await updates.check(true); assert.equal(installs, 1);
  updates.stop(); assert.equal(cleared, true);
});
test('disabled updates do no network work; errors and concurrent checks remain handled', async () => {
  const updater = new EventEmitter(); let checks = 0; let resolve; let prompts = 0;
  updater.setFeedURL = () => {};
  updater.checkForUpdates = () => { checks++; return new Promise((done) => { resolve = done; }); };
  let updates = configureUpdates({ updater, feed: null, enabled: false, prompt: async () => { prompts++; }, timers: { setInterval() { throw new Error('Unexpected timer'); } } });
  await updates.check(true); assert.equal(checks, 0); assert.equal(prompts, 1); updates.stop();
  updates = configureUpdates({ updater, feed: 'https://nuc.test/', enabled: false, prompt: async () => {} }); updates.stop();
  updates = configureUpdates({ updater, feed: 'https://nuc.test/', enabled: true, prompt: async () => {}, timers: { setInterval() {}, clearInterval() {} }, log() {} });
  const a = updates.check(); const b = updates.check(); assert.equal(checks, 1); resolve({}); await Promise.all([a, b]);
  updater.emit('error', new Error('network unavailable')); updates.stop();
});
