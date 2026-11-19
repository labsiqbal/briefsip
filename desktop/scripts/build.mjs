// Adapted from T3 scripts/build-desktop-artifact.ts. See ../provenance.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'electron-builder';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.ELECTRON_CACHE ??= path.join(root, '.cache/electron');
process.env.ELECTRON_BUILDER_CACHE ??= path.join(root, '.cache/builder');
process.env.TMPDIR ??= path.join(root, '.cache/tmp');
fs.mkdirSync(process.env.TMPDIR, { recursive: true });
const [version, output] = process.argv.slice(2);
await build({
  projectDir: root,
  publish: 'never',
  config: {
    ...(version && { extraMetadata: { version } }),
    ...(output && { directories: { output } }),
  },
});
