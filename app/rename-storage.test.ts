import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readProductStorage, removeProductStorage } from './src/rename-storage.ts';

test('browser recovery moves legacy keys on read and holds them when writes fail', () => {
  const entries = new Map([['briefsip:focus:agent', 'turn'], ['briefsip:routine-command:agent', 'command'], ['briefsip:routine-test:routine', 'test']]);
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
  assert.equal(readProductStorage(storage, 'minarbot:focus:agent'), 'turn');
  assert.equal(storage.getItem('briefsip:focus:agent'), null);
  assert.equal(storage.getItem('minarbot:focus:agent'), 'turn');
  removeProductStorage(storage, 'minarbot:routine-command:agent');
  assert.equal(storage.getItem('briefsip:routine-command:agent'), null);
  const full = { ...storage, setItem() { throw new Error('Storage quota exceeded'); } };
  assert.equal(readProductStorage(full, 'minarbot:routine-test:routine'), 'test');
  assert.equal(storage.getItem('briefsip:routine-test:routine'), 'test');
});
