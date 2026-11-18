#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { durableWrite, fileManifest, parseRelease, syncDirectory } from '../app/update-release.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function readIssueComments(issue) {
  return JSON.parse(execFileSync('gh', ['issue', 'view', String(issue), '-R', 'labsiqbal/briefsip', '--json', 'comments'], { encoding: 'utf8' })).comments;
}

export function assertNativeDependencies(binary) {
  const output = execFileSync('ldd', [binary], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (/not found/i.test(output)) throw new Error(`Native dependency missing for ${binary}: ${output}`);
  for (const line of output.split('\n')) {
    const match = line.match(/=>\s+(\/[^\s(]+)/) ?? line.match(/^\s*(\/[^\s(]+)/);
    let path; if (match) { try { path = realpathSync(match[1]); } catch { path = match[1]; } }
    if (path && !['/lib', '/usr/lib', '/lib64'].some(root => path === root || path.startsWith(`${root}/`))) {
      throw new Error(`Native dependency outside system loader paths for ${binary}: ${match[1]}`);
    }
  }
}

export function buildRelease({ source = join(root, 'app'), releases = join(homedir(), '.local/share/briefsip/releases'), allowDirty = false, notes, build = true, install = true, repository = root, issues = [], readIssueComments: readComments = readIssueComments } = {}) {
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  if (!Array.isArray(issues) || issues.some(issue => !Number.isSafeInteger(issue) || issue <= 0)) throw new Error('Invalid issues. Use --issues 30,31 with positive issue numbers.');
  issues = [...new Set(issues)];
  if (!issues.length) console.warn('WARNING: RELEASE ANCESTRY GATE SKIPPED. Supply --issues 30,31 for every shipped issue.');
  if (!allowDirty && git(['status', '--porcelain'])) throw new Error('Refusing dirty worktree. Use --allow-dirty for a development release.');
  const { version } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')), commit = git(['rev-parse', 'HEAD']);
  for (const issue of issues) {
    let comments;
    try { comments = readComments(issue); }
    catch { throw new Error(`Issue #${issue}: cannot read claim comments. Check gh authentication and access to labsiqbal/briefsip, then retry.`); }
    if (!Array.isArray(comments) || comments.some(comment => typeof comment?.body !== 'string')) throw new Error(`Issue #${issue}: invalid comments. Fix the issue reader and retry.`);
    const branches = [...new Set(comments.flatMap(comment => [...comment.body.matchAll(/^Claimed by [^\r\n]+, branch (t3\/\S+)[ \t]*\r?$/gm)].map(match => match[1])))];
    if (!branches.length) throw new Error(`Issue #${issue}: no claim comment. Add "Claimed by <agent>, branch t3/<slug>" and retry.`);
    for (const branch of branches) {
      const ref = `refs/heads/${branch}`;
      try { git(['show-ref', '--verify', '--quiet', ref]); }
      catch { throw new Error(`Issue #${issue}: local branch ${branch} is missing. Restore the task branch locally and retry.`); }
      try { git(['merge-base', '--is-ancestor', ref, commit]); }
      catch { throw new Error(`Issue #${issue}: ${branch} is not an ancestor of ${commit}. Merge the branch tip and retry.`); }
    }
  }
  const id = `${version}-${commit.slice(0, 8)}`;
  const target = join(releases, id);
  if (existsSync(target)) throw new Error(`Release already exists: ${id}`);
  if (build) for (const script of ['lint', 'build', 'test']) execFileSync('npm', ['run', script], { cwd: source, stdio: 'inherit' });
  const rust = existsSync(join(repository, 'Cargo.toml'));
  if (build && rust) {
    for (const args of [['fmt', '--check'], ['clippy', '--all-targets', '--', '-D', 'warnings'], ['test'], ['build', '--release', '--locked']]) execFileSync('cargo', args, { cwd: repository, stdio: 'inherit' });
    execFileSync(process.execPath, [join(repository, 'scripts/resource-gate.mjs'), join(repository, 'target/release/briefsip-server'), join(repository, 'scripts/budgets.json'), join(repository, 'target/release/briefsip-launcher')], { cwd: repository, stdio: 'inherit', env: { ...process.env, TMPDIR: '/dev/shm' } });
    const gate = repository === root
      ? ['systemd-run', '--user', '--scope', '-q', '-p', 'MemoryMax=4G', '-p', 'MemorySwapMax=0', 'env', 'NODE_OPTIONS=--max-old-space-size=2048', 'TMPDIR=/dev/shm', process.execPath]
      : [process.execPath];
    execFileSync(gate[0], [...gate.slice(1), join(repository, 'scripts/production-env-gate.mjs'), join(repository, 'target/release/briefsip-server'), join(repository, 'target/release/briefsip-launcher')], { cwd: repository, stdio: 'inherit' });
  }
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(releases, '.staging-'));
  try {
    // Runtime source only. Never include workspace data, .env, test fixtures or development bundles.
    stageRuntime(source, stage);
    if (build && rust) {
      mkdirSync(join(stage, 'bin'), { mode: 0o700 }); cpSync(join(repository, 'target/release/briefsip-server'), join(stage, 'bin/briefsip-server'));
      cpSync(join(repository, 'target/release/briefsip-launcher'), join(stage, 'bin/briefsip-launcher'));
      for (const name of ['briefsip-server', 'briefsip-launcher']) assertNativeDependencies(join(stage, 'bin', name));
      cpSync(join(repository, 'crates/briefsip-launcher/provenance.json'), join(stage, 'bin/launcher-provenance.json'));
      cpSync(join(repository, 'crates/briefsip-launcher/NOTICE'), join(stage, 'bin/launcher.NOTICE'));
      cpSync(join(repository, 'crates/briefsip-server/provenance.json'), join(stage, 'bin/provenance.json'));
      for (const name of ['LICENSE', 'agent-delegation.LICENSE']) cpSync(join(repository, 'app', name), join(stage, 'bin', name));
    }
    // A missing runtime module crashes the candidate after apply; fail the release here instead.
    assertRelativeImports(stage);
    mkdirSync(join(stage, 'machine'), { mode: 0o700 });
    for (const name of ['install-machine.sh', 'uninstall-machine.sh', 'briefsip-launcher.mjs']) cpSync(join(root, 'scripts', name), join(stage, 'machine', name));
    if (install) execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });
    // No executable .bin links needed: server runs Node source. Remaining links are rejected by manifest.
    rmSync(join(stage, 'node_modules/.bin'), { recursive: true, force: true });
    const info = parseRelease({ id, version, commit, issues, created: new Date().toISOString(), node: process.version, notes: notes ?? git(['log', '-5', '--pretty=%s']), files: fileManifest(stage) });
    durableWrite(join(stage, 'release.json'), JSON.stringify(info, null, 2) + '\n', 0o644);
    renameSync(stage, target); syncDirectory(releases);
    mkdirSync(join(releases, 'feed'), { recursive: true, mode: 0o700 });
    // Immutable directory first; replace feed metadata only after complete runtime publication.
    durableWrite(join(releases, 'feed/latest.json'), JSON.stringify(info, null, 2) + '\n', 0o644);
    return info;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
// Copies the runtime selection a release ships; tests stage the same selection to run the import guard.
export function stageRuntime(source, stage) {
  for (const name of readdirSync(source)) if (/\.(ts|mjs)$/.test(name) && !/(?:\.test\.ts|-it\.ts|\.d\.ts)$/.test(name) || ['package.json', 'package-lock.json', 'dist', 't3', 'hub'].includes(name)) cpSync(join(source, name), join(stage, name), { recursive: true, filter: p => !p.endsWith('.test.ts') && !p.endsWith('-it.ts') && !p.endsWith('.d.ts') });
}
// Every relative import reachable from a runtime entry point must resolve to a staged file.
export function assertRelativeImports(stage, entries = ['server.ts', 'cli.ts', 'hub/server.ts', 'update-release.mjs', 'agent-desktop-host.mjs']) {
  const missing = [], seen = new Set();
  const pattern = /(?:^|\n)\s*(?:import|export)\b[^'"`;]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  const visit = path => {
    if (seen.has(path)) return; seen.add(path);
    for (const match of readFileSync(path, 'utf8').matchAll(pattern)) {
      const spec = match[1] ?? match[2], target = resolve(dirname(path), spec);
      if (!existsSync(target)) missing.push(`${path.slice(stage.length + 1)} -> ${spec}`);
      else if (/\.(ts|mjs|js)$/.test(target)) visit(target);
    }
  };
  for (const entry of entries) if (existsSync(join(stage, entry))) visit(join(stage, entry));
  if (missing.length) throw new Error(`Release is missing runtime modules:\n${missing.join('\n')}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), allowed = new Set(['--releases', '--notes', '--allow-dirty', '--desktop', '--desktop-feed', '--issues']);
  const options = {};
  for (let i = 0; i < args.length; i++) { const flag = args[i]; if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}`); if (!['--allow-dirty', '--desktop'].includes(flag) && (!args[i + 1] || args[i + 1].startsWith('--'))) throw new Error(`Missing value: ${flag}`); if (flag === '--releases') options.releases = resolve(args[++i]); else if (flag === '--notes') options.notes = args[++i]; else if (flag === '--allow-dirty') options.allowDirty = true; else if (flag === '--desktop-feed') options.desktopFeed = resolve(args[++i]); else if (flag === '--issues') { const value = args[++i]; if (!/^\d+(,\d+)*$/.test(value)) throw new Error('Invalid issues. Use --issues 30,31 with positive issue numbers.'); options.issues = value.split(',').map(Number); } }
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
