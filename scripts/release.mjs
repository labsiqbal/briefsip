#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { durableWrite, fileManifest, parseRelease, syncDirectory } from '../app/update-release.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function buildRelease({ source = join(root, 'app'), releases = join(homedir(), '.local/share/briefsip/releases'), allowDirty = false, notes, build = true, install = true, repository = root } = {}) {
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  if (!allowDirty && git(['status', '--porcelain'])) throw new Error('Refusing dirty worktree. Use --allow-dirty for a development release.');
  const { version } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')), commit = git(['rev-parse', 'HEAD']);
  const id = `${version}-${commit.slice(0, 8)}`;
  const target = join(releases, id);
  if (existsSync(target)) throw new Error(`Release already exists: ${id}`);
  if (build) execFileSync('npm', ['run', 'build'], { cwd: source, stdio: 'inherit' });
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(releases, '.staging-'));
  try {
    // Runtime source only. Never include workspace data, .env, test fixtures or development bundles.
    for (const name of readdirSync(source)) if (/\.(ts|mjs)$/.test(name) && !/\.(test\.ts|d\.ts)$/.test(name) || ['package.json', 'package-lock.json', 'dist', 't3'].includes(name)) cpSync(join(source, name), join(stage, name), { recursive: true, filter: p => !p.endsWith('.test.ts') && !p.endsWith('.d.ts') });
    if (install) execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });
    // No executable .bin links needed: server runs Node source. Remaining links are rejected by manifest.
    rmSync(join(stage, 'node_modules/.bin'), { recursive: true, force: true });
    const info = parseRelease({ id, version, commit, created: new Date().toISOString(), node: process.version, notes: notes ?? git(['log', '-5', '--pretty=%s']), files: fileManifest(stage) });
    durableWrite(join(stage, 'release.json'), JSON.stringify(info, null, 2) + '\n', 0o644);
    renameSync(stage, target); syncDirectory(releases);
    mkdirSync(join(releases, 'feed'), { recursive: true, mode: 0o700 });
    // Immutable directory first; replace feed metadata only after complete runtime publication.
    durableWrite(join(releases, 'feed/latest.json'), JSON.stringify(info, null, 2) + '\n', 0o644);
    return info;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), allowed = new Set(['--releases', '--notes', '--allow-dirty', '--desktop', '--desktop-feed']);
  const options = {};
  for (let i = 0; i < args.length; i++) { const flag = args[i]; if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}`); if (!['--allow-dirty', '--desktop'].includes(flag) && (!args[i + 1] || args[i + 1].startsWith('--'))) throw new Error(`Missing value: ${flag}`); if (flag === '--releases') options.releases = resolve(args[++i]); else if (flag === '--notes') options.notes = args[++i]; else if (flag === '--allow-dirty') options.allowDirty = true; else if (flag === '--desktop-feed') options.desktopFeed = resolve(args[++i]); }
  if (!options.allowDirty && execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Refusing dirty worktree. Use --allow-dirty for a development release.');
  if (args.includes('--desktop')) {
    const pkgPath = join(root, 'desktop/package.json'), lockPath = join(root, 'desktop/package-lock.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')), lock = JSON.parse(readFileSync(lockPath, 'utf8')), version = JSON.parse(readFileSync(join(root, 'app/package.json'), 'utf8')).version;
    if (pkg.version !== version) { pkg.version = version; lock.version = version; lock.packages[''].version = version; durableWrite(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 0o644); durableWrite(lockPath, JSON.stringify(lock, null, 2) + '\n', 0o644); }
  }
  // Desktop version sync is an intentional mutation after the clean-tree check.
  const info = buildRelease({ ...options, allowDirty: options.allowDirty || args.includes('--desktop') });
  if (args.includes('--desktop')) execFileSync(process.execPath, [join(root, 'desktop/scripts/publish-local.mjs'), options.desktopFeed ?? join(homedir(), '.local/share/briefsip/desktop-feed/desktop')], { cwd: root, stdio: 'inherit' });
  console.log(`Published ${info.id}`);
}
