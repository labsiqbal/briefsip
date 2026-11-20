import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const desktop = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'));
export const githubRepository = new URL(desktop.build.publish[0].url).pathname.split('/').slice(1, 3).join('/');

export function bridgeArchiveName(version) {
  // The 0.13.x updater validates this basename after verifying the manifest signature.
  return `briefsip-${version}-linux-x86_64.tar.gz`;
}

export function stageBridgeAliases(bin) {
  // Old archive readers reject symlinks and hard-link records.
  for (const component of ['server', 'launcher']) {
    cpSync(join(bin, `minarbot-${component}`), join(bin, `briefsip-${component}`));
  }
}
