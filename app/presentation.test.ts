import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultPresentation, parsePresentation, presentationKey, readPresentation } from './presentation.ts';

test('presentation settings validate persisted values and fail safely without overwriting storage', () => {
  assert.deepEqual(parsePresentation(null), defaultPresentation);
  for (const theme of ['dark', 'light', 'system']) for (const textSize of ['standard', 'large', 'larger']) {
    const value = { version: 1, theme, textSize }, raw = JSON.stringify(value);
    assert.deepEqual(parsePresentation(raw), value);
    assert.deepEqual(readPresentation({ getItem(key) { assert.equal(key, presentationKey); return raw; } }), { value, error: '' });
  }
  for (const raw of ['{', 'null', '[]', 'true', '{}', JSON.stringify({ ...defaultPresentation, version: 2 }), JSON.stringify({ ...defaultPresentation, theme: 'url(secret)' }), JSON.stringify({ ...defaultPresentation, textSize: 100 }), JSON.stringify({ ...defaultPresentation, extra: true })]) {
    assert.throws(() => parsePresentation(raw));
    const result = readPresentation({ getItem: () => raw });
    assert.deepEqual(result.value, defaultPresentation); assert(result.error);
  }
  const blocked = readPresentation({ getItem() { throw new Error('Storage blocked'); } });
  assert.deepEqual(blocked.value, defaultPresentation); assert(blocked.error);
  const copy = parsePresentation(null); copy.theme = 'light'; assert.equal(defaultPresentation.theme, 'dark');
});

test('both appearance palettes keep text and control contrast', () => {
  const css = readFileSync(new URL('./src/style.css', import.meta.url), 'utf8');
  const luminance = (color: string) => {
    const rgb = color.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  for (const selector of [':root', ':root[data-theme="light"]']) {
    const block = css.slice(css.indexOf(selector));
    const palette = Object.fromEntries([...block.slice(0, block.indexOf('}')).matchAll(/--([a-z-]+): (#[a-f0-9]{6});/g)].map(match => [match[1], match[2]]));
    const pairs = [['text', 'background'], ['text', 'surface'], ['text', 'sidebar'], ['text', 'secondary'], ['text', 'secondary-hover'], ['text', 'selected'], ['row-muted', 'selected'], ['row-muted', 'sidebar'], ['muted', 'background'], ['muted', 'surface'], ['muted', 'sidebar'], ['button-text', 'accent'], ['button-text', 'accent-hover'], ['accent', 'background'], ['accent', 'surface'], ['avatar-text', 'avatar'], ['error', 'surface'], ['error', 'sidebar'], ['notice', 'background'], ['answer-title', 'surface']];
    for (const [foreground, background] of pairs) {
      const a = luminance(palette[foreground]), b = luminance(palette[background]);
      assert((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${selector}: ${foreground} on ${background}`);
    }
    for (const [foreground, background] of [['focus', 'background'], ['input-line', 'surface'], ['online', 'sidebar'], ['offline', 'sidebar']]) {
      const a = luminance(palette[foreground]), b = luminance(palette[background]);
      assert((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 3, `${selector}: ${foreground} on ${background}`);
    }
  }
});
