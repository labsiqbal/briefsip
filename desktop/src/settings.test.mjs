import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addServer, readSettings, removeServer, resolveWindowBounds, writeSettings } from './settings.mjs';

test('atomic settings persist server selection and bounds; removal switches to remaining server', (t) => {
  const root = path.resolve('.cache/tests'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'settings-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let value = addServer(readSettings(dir), 'https://nuc.example.test:4317');
  value = addServer(value, 'https://other.test/'); value.window = { width: 900, height: 700, x: 4, y: 8 };
  writeSettings(dir, value); assert.deepEqual(readSettings(dir), value);
  assert.equal(fs.statSync(path.join(dir, 'settings.json')).mode & 0o777, 0o600);
  value = removeServer(value, 'https://other.test/'); assert.equal(value.activeServer, 'https://nuc.example.test:4317/');
  assert.equal(removeServer(value, value.activeServer).activeServer, null);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{broken'); assert.throws(() => readSettings(dir), /Preserve/);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{broken');
});
test('window bounds restore only when valid and still visible on a display', () => {
  const display = [{ x: 0, y: 0, width: 1920, height: 1080 }];
  const bounds = { x: 5, y: 5, width: 900, height: 700 };
  assert.deepEqual(resolveWindowBounds(bounds, display), bounds);
  assert.deepEqual(resolveWindowBounds({ ...bounds, x: 3000 }, display), { width: 1200, height: 800 });
  assert.deepEqual(resolveWindowBounds({ width: 'invalid' }, display), { width: 1200, height: 800 });
});
