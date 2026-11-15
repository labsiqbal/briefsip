import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRelease } from './update-release.mjs';
const { buildRelease } = await import(new URL('../scripts/release.mjs', import.meta.url).href);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'release-gates-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'release');
  writeFileSync(join(dir, '.gitignore'), 'releases/\n');
  mkdirSync(join(dir, 'app'));
  writeFileSync(join(dir, 'app/package.json'), JSON.stringify({ version: '1.0.0', type: 'module' }));
  writeFileSync(join(dir, 'app/server.ts'), '// Fixture runtime\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture');
  git('branch', 't3/shipped');
  return { dir, git, options: { source: join(dir, 'app'), releases: join(dir, 'releases'), repository: dir, build: false, install: false } };
}

test('release refuses claimed branch tip omitted from release, then records merged issue numbers', () => {
  const f = fixture();
  try {
    f.git('switch', 't3/shipped');
    writeFileSync(join(f.dir, 'feature'), 'feature');
    f.git('add', '.');
    f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Feature');
    f.git('switch', 'release');
    const options = { ...f.options, issues: [30], readIssueComments: (issue: number) => {
      assert.equal(issue, 30);
      return [{ body: 'Claimed by AT1 (Codex), branch t3/shipped' }];
    } };
    assert.throws(() => buildRelease(options), /#30.*t3\/shipped.*merge/i);
    assert.equal(existsSync(f.options.releases), false);
    f.git('merge', '--ff-only', 't3/shipped');
    const info = buildRelease(options);
    assert.deepEqual(info.issues, [30]);
    assert.equal(info.commit, f.git('rev-parse', 'HEAD'));
    assert.deepEqual(JSON.parse(readFileSync(join(f.options.releases, info.id, 'release.json'), 'utf8')).issues, [30]);
    assert.deepEqual(JSON.parse(readFileSync(join(f.options.releases, 'feed/latest.json'), 'utf8')).issues, [30]);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const [name, comments, message] of [
  ['missing claim', [{ body: 'Ready for release' }], /#31.*no claim.*Add/],
  ['missing local branch', [{ body: 'Claimed by RG1, branch t3/missing' }], /#31.*t3\/missing.*missing.*Restore/],
  ['conflicting claims', [{ body: 'Claimed by RG1, branch t3/shipped' }, { body: 'Claimed by RG2, branch t3/other' }], /#31.*conflicting.*Resolve/],
] as const) test(`release fails before publication on ${name}`, () => {
  const f = fixture();
  try {
    assert.throws(() => buildRelease({ ...f.options, issues: [31], readIssueComments: () => comments }), message);
    assert.equal(existsSync(f.options.releases), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('repeated same-branch claims pass; every issue is checked; invalid issues fail closed', () => {
  const f = fixture();
  try {
    const readIssueComments = () => [{ body: 'Claimed by RG1, branch t3/shipped' }, { body: 'Claimed by RG1, branch t3/shipped' }];
    const info = buildRelease({ ...f.options, issues: [30, 31, 30], readIssueComments });
    assert.deepEqual(info.issues, [30, 31]);
    for (const issues of [null, ['30'], [0], [30, 30]]) assert.throws(() => parseRelease({ ...info, issues }), /Invalid release issues/);
    const { issues: _issues, ...legacy } = info;
    assert.doesNotThrow(() => parseRelease(legacy));
    for (const issues of [[0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]]) assert.throws(() => buildRelease({ ...f.options, issues }), /Invalid issues/);
    assert.throws(() => buildRelease({ ...f.options, issues: [30, 31], readIssueComments: (issue: number) => issue === 30 ? readIssueComments() : [] }), /#31.*no claim/);
    assert.throws(() => buildRelease({ ...f.options, issues: [30], readIssueComments: () => { throw new Error('offline'); } }), /#30.*cannot read.*gh authentication/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('release without issues warns loudly', t => {
  const f = fixture();
  const warn = t.mock.method(console, 'warn', () => {});
  try {
    assert.deepEqual(buildRelease(f.options).issues, []);
    assert.match(warn.mock.calls[0].arguments[0], /WARNING: RELEASE ANCESTRY GATE SKIPPED.*--issues/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('release CLI demonstrates passing and failing --issues using a fixture gh reader', t => {
  const f = fixture(), bin = mkdtempSync(join(tmpdir(), 'release-gh-'));
  try {
    mkdirSync(join(f.dir, 'scripts'));
    for (const name of ['release.mjs', 'install-machine.sh', 'uninstall-machine.sh', 'briefsip-launcher.mjs']) cpSync(new URL(`../scripts/${name}`, import.meta.url), join(f.dir, 'scripts', name));
    cpSync(new URL('./update-release.mjs', import.meta.url), join(f.dir, 'app/update-release.mjs'));
    const pkg = { name: 'release-gate-fixture', version: '1.0.0', type: 'module', scripts: { lint: 'node -e "0"', test: 'node -e "0"', build: 'node -e "0"' } };
    writeFileSync(join(f.dir, 'app/package.json'), JSON.stringify(pkg));
    writeFileSync(join(f.dir, 'app/package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg } }));
    f.git('add', '.');
    f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'CLI fixture');
    f.git('switch', '-c', 't3/unmerged');
    writeFileSync(join(f.dir, 'unmerged-feature'), 'not shipped');
    f.git('add', '.');
    f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Unmerged feature');
    f.git('switch', 'release');
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
assert.deepEqual(args, ['issue', 'view', args[2], '-R', 'labsiqbal/briefsip', '--json', 'comments']);
assert(['30', '31'].includes(args[2]));
console.log(JSON.stringify({comments: [{body: 'Claimed by Fixture, branch ' + (args[2] === '30' ? 't3/shipped' : 't3/unmerged')}]}));
`, { mode: 0o700 });
    const run = (issues: string) => spawnSync(process.execPath, [join(f.dir, 'scripts/release.mjs'), '--issues', issues, '--releases', f.options.releases], { cwd: f.dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, npm_config_update_notifier: 'false' } });
    const failed = run('30,31');
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /#31.*t3\/unmerged.*Merge the branch tip/);
    assert.equal(existsSync(f.options.releases), false);
    t.diagnostic(`FAIL DEMO --issues 30,31 (exit ${failed.status}): ${failed.stderr.split('\n').find(line => line.startsWith('Error:'))}`);
    const passed = run('30');
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /Published 1\.0\.0-/);
    const info = JSON.parse(readFileSync(join(f.options.releases, 'feed/latest.json'), 'utf8'));
    assert.deepEqual(info.issues, [30]);
    t.diagnostic(`PASS DEMO --issues 30 (exit ${passed.status}): ${passed.stdout.trim().split('\n').at(-1)}; metadata issues=${JSON.stringify(info.issues)}`);
  } finally { rmSync(f.dir, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
});
