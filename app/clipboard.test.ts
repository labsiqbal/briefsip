import test from 'node:test';
import assert from 'node:assert/strict';
import { copyText } from './src/ui/clipboard.ts';

test('copy uses Clipboard API without fallback when it succeeds', async () => {
  let copied = '';
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (value: string) => { copied = value; } } } });
  try { await copyText('line one\nline two'); assert.equal(copied, 'line one\nline two'); }
  finally { delete (globalThis as any).navigator; }
});

for (const mode of ['missing', 'denied', 'failed'] as const) test(`copy fallback: ${mode}; restores focus, selection, removes temporary text`, async () => {
  let removed = false, restored = false, selectionRestored = false, selected = false;
  const range = {};
  const selection = { rangeCount: 1, getRangeAt: () => ({ cloneRange: () => range }), removeAllRanges() {}, addRange(value: unknown) { selectionRestored = value === range; } };
  const element = { value: '', className: '', tabIndex: 0, setAttribute() {}, focus() {}, select() { selected = true; }, remove() { removed = true; } };
  const active = { closest: () => null, focus: () => { restored = true; } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: active, getSelection: () => selection, body: { appendChild(value: unknown) { assert.equal(value, element); } }, createElement: () => element, execCommand(command: string) { assert.equal(command, 'copy'); assert(selected); assert.equal(element.value, 'fixture'); return mode !== 'failed'; } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: mode === 'missing' ? {} : { clipboard: { writeText: async () => { throw new Error('Permission denied'); } } } });
  try {
    if (mode === 'failed') await assert.rejects(copyText('fixture'), /could not be copied/);
    else await copyText('fixture');
    assert(removed); assert(restored); assert(selectionRestored);
  } finally { delete (globalThis as any).document; delete (globalThis as any).navigator; }
});

test('clipboard reads return text and expose an actionable denial without contents in errors', async () => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { readText: async () => 'remote fixture' } } });
  try {
    const { readClipboardText } = await import('./src/ui/clipboard.ts');
    assert.equal(await readClipboardText(), 'remote fixture');
    (globalThis as any).navigator.clipboard.readText = async () => { throw new Error('private clipboard contents'); };
    await assert.rejects(readClipboardText(), { message: 'Clipboard could not be read. Use Paste text to enter it manually.' });
  } finally { delete (globalThis as any).navigator; }
});


test('embedded views cannot use Clipboard API or the native editing fallback', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { top: {} } });
  try {
    const { readClipboardText } = await import('./src/ui/clipboard.ts');
    await assert.rejects(copyText('fixture'), /unavailable in embedded views/);
    await assert.rejects(readClipboardText(), /unavailable in embedded views/);
  } finally { delete (globalThis as any).window; }
});
