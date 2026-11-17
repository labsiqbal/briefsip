import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const crates = { 'briefsip-server': ['briefsip-server', 'briefsip-launcher'], 'briefsip-launcher': ['briefsip-launcher'] };

function newestSource(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'target') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSource(path));
    else if (/\.(rs|toml|sql)$/.test(entry.name) || entry.name === 'build.rs') newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

// Rejects a target/debug binary older than the crate sources.
export function rustBinary(name: 'briefsip-server' | 'briefsip-launcher', override?: string): string {
  if (override) return override;
  const binary = resolve(root, 'target/debug', name);
  if (!existsSync(binary)) throw new Error(`Missing Rust binary ${binary}: run cargo build`);
  const sources = Math.max(...crates[name].map(crate => newestSource(resolve(root, 'crates', crate))), ...['Cargo.toml', 'Cargo.lock'].map(file => statSync(resolve(root, file)).mtimeMs));
  if (statSync(binary).mtimeMs < sources) throw new Error(`Stale Rust binary ${binary}: run cargo build`);
  return binary;
}
