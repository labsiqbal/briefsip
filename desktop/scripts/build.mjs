// Adapted from T3 scripts/build-desktop-artifact.ts. See ../provenance.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'electron-builder';
import { updateFeedUrl } from '../src/updates.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.ELECTRON_CACHE ??= path.join(root, '.cache/electron');
process.env.ELECTRON_BUILDER_CACHE ??= path.join(root, '.cache/builder');
process.env.TMPDIR ??= path.join(root, '.cache/tmp');
fs.mkdirSync(process.env.TMPDIR, { recursive: true });
const feed = updateFeedUrl(process.env.BRIEFSIP_UPDATE_URL);
const config = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build;
const feedFile = path.join(root, 'update-feed.json');
fs.writeFileSync(feedFile, JSON.stringify({ url: feed }) + '\n');
try {
  await build({ projectDir: root, publish: 'never', config: { ...config,
    // Metadata remains buildable offline; runtime checks stay disabled until a real URL is supplied.
    publish: [{ provider: 'generic', url: feed ?? 'https://updates.invalid/desktop/' }],
  } });
} finally { fs.rmSync(feedFile, { force: true }); }
