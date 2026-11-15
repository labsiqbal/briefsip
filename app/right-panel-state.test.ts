import test from 'node:test';
import assert from 'node:assert/strict';
import { parseComputerView } from './src/computer-view.ts';
import { createRightPanelStore, parseRightPanelState, rightPanelWidthKey } from './src/right-panel-state.ts';
test('panel preferences parse defensively and constrain widths', () => {
  for (const raw of [null, 'null', '{}', '[]', 'true', '"../files"', 'broken']) assert.equal(parseRightPanelState(raw, null).tab, 'details');
  assert.deepEqual(parseRightPanelState('"diff"', '401.6'), { tab: 'diff', width: 402 });
  assert.deepEqual(parseRightPanelState('"browser"', 'Infinity'), { tab: 'computer', width: 360 });
  assert.equal(parseRightPanelState(null, '-1').width, 280); assert.equal(parseRightPanelState(null, '99999').width, 560); assert.equal(parseRightPanelState(null, '  ').width, 360);
});
test('panel state stays isolated across conversations and recreated stores', () => {
  const values = new Map<string,string>(), storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key,value); } }, store = createRightPanelStore(storage);
  store.select('thread:a', 'diff'); store.select('channel:a', 'files'); storage.setItem(rightPanelWidthKey('thread:a'), '480'); storage.setItem(rightPanelWidthKey('channel:a'), '320');
  assert.deepEqual(createRightPanelStore(storage).read('thread:a'), { tab: 'diff', width: 480 }); assert.deepEqual(createRightPanelStore(storage).read('channel:a'), { tab: 'files', width: 320 }); assert.deepEqual(store.read('agent:a'), { tab: 'details', width: 360 });
});
test('unavailable browser storage leaves panel usable', () => { const store = createRightPanelStore({ getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Full'); } }); assert.deepEqual(store.read('a'), { tab: 'details', width: 360 }); assert.doesNotThrow(() => store.select('a','files')); });

test('computer view preferences accept only explicit browser or desktop choices', () => {
  for (const raw of [null, 'broken', '{}', '[]', 'true', '"Browser"', '"off"']) assert.equal(parseComputerView(raw), null);
  assert.equal(parseComputerView('"browser"'), 'browser'); assert.equal(parseComputerView('"desktop"'), 'desktop');
});
