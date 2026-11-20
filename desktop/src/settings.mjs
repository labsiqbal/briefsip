// Adapted from T3 DesktopAppSettings.ts: validated JSON and atomic replacement.
import fs from 'node:fs';
import path from 'node:path';
import { parseServerUrl } from './policy.mjs';

export const DEFAULT_WINDOW = { width: 1200, height: 800 };
export function resolveWindowBounds(bounds, displays) {
  // T3's display fit check retains one-pixel tolerance for snapped windows.
  if (bounds && ['x', 'y', 'width', 'height'].every((key) => Number.isSafeInteger(bounds[key])) &&
      bounds.width >= 640 && bounds.height >= 480 && displays.some((display) =>
        bounds.x >= display.x - 1 && bounds.y >= display.y - 1 &&
        bounds.x + bounds.width <= display.x + display.width + 1 &&
        bounds.y + bounds.height <= display.y + display.height + 1)) return bounds;
  return { ...DEFAULT_WINDOW };
}
export function legacyUserData(userData) {
  if (fs.existsSync(path.join(userData, 'settings.json'))) return userData;
  const parent = path.dirname(userData);
  if (!['Minarbot', 'minarbot', 'minarbot-desktop'].includes(path.basename(userData))) return userData;
  for (const name of ['Briefsip', 'briefsip', 'briefsip-desktop']) {
    const legacy = path.join(parent, name);
    if (fs.existsSync(path.join(legacy, 'settings.json'))) return legacy;
  }
  return userData;
}
export function readSettings(userData) {
  let value;
  try { value = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { servers: [], activeServer: null, window: { ...DEFAULT_WINDOW } }; throw new Error('Cannot read settings.json. Preserve it and repair its JSON before restarting.', { cause: error }); }
  if (!value || !Array.isArray(value.servers) || !value.servers.every((server) => { try { return parseServerUrl(server).href === server; } catch { return false; } }) ||
      !(value.activeServer === null || value.servers.includes(value.activeServer))) throw new Error('Invalid settings.json. Preserve it and repair server settings before restarting.');
  return { servers: value.servers, activeServer: value.activeServer, window: value.window };
}
export function writeSettings(userData, settings) {
  fs.mkdirSync(userData, { recursive: true });
  const target = path.join(userData, 'settings.json');
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
}
export function addServer(settings, url) {
  const normalized = parseServerUrl(url).href;
  return { ...settings, servers: [...new Set([...settings.servers, normalized])], activeServer: normalized };
}
export function removeServer(settings, url) {
  const servers = settings.servers.filter((server) => server !== url);
  return { ...settings, servers, activeServer: settings.activeServer === url ? servers[0] ?? null : settings.activeServer };
}
