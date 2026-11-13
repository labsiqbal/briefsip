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
  const css = readFileSync(new URL('./src/ui/tokens.css', import.meta.url), 'utf8');
  const tokens = (selector: string) => {
    const block = css.slice(css.indexOf(selector));
    return Object.fromEntries([...block.slice(0, block.indexOf('}')).matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?);/g)].map(match => [match[1], match[2]]));
  };
  const light = tokens(':root {'), dark = { ...light, ...tokens(":root[data-theme='dark'] {") };
  const rgba = (color: string) => { const [r, g, b, a = 255] = color.slice(1).match(/../g)!.map(value => parseInt(value, 16)); return [r, g, b, a / 255]; };
  const over = (color: string, base: number[]) => { const [r, g, b, a] = rgba(color); return [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)]; };
  const luminance = (rgb: number[]) => rgb.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const ratio = (foreground: string, background: string) => {
    const base = over(background, [255, 255, 255]), a = luminance(over(foreground, base)), b = luminance(base);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  };
  const surfaces = ['color-bg-chrome', 'color-bg-pane', 'color-bg-sidebar', 'color-bg-elevated'];
  for (const [name, palette] of [['light', light], ['dark', dark]] as const) {
    for (const text of ['color-text-primary', 'color-text-secondary', 'color-text-tertiary', 'color-danger-text', 'color-warn-text', 'color-success-text', 'color-brand-text'])
      for (const surface of surfaces) assert(ratio(palette[text], palette[surface]) >= 4.5, `${name}: ${text} on ${surface}`);
    assert(ratio(palette['color-on-primary'], palette['color-primary']) >= 4.5, `${name}: on-primary on primary`);
    assert(ratio('#FFFFFF', palette['bot-bubble'] ?? palette['color-brand']) >= 4.5, `${name}: user bubble text`);
    for (const surface of surfaces) assert(ratio(palette['color-border-focus'], palette[surface]) >= 3, `${name}: focus ring on ${surface}`);
  }
});
