#!/bin/sh
# Bootstrap needs only Node.js. No provider credentials are included.
set -eu
command -v node >/dev/null 2>&1 || { echo 'Node.js >= 22.23.4 is required.' >&2; exit 1; }
exec node --input-type=module - "$@" <<'JS'
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
const args = process.argv.slice(2), opt = { port: 4317, name: hostname(), serve: false, dry: false };
const say = text => process.stdout.write(text + '\n');
function fail(text) { throw new Error(text); }
function command(name, argv, required = true) {
  const result = spawnSync(name, argv, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore','pipe','pipe'] });
  if (required && (result.error || result.status !== 0)) fail(`${name} failed. Check user permissions and try again.`);
  return result;
}
function has(name) { return command('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', name], false).status === 0; }
const limit = 1024 * 1024 * 1024;
const releasePattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?-[a-f0-9]{8,40}$/;
function origin(value) {
  let url; try { url = new URL(value); } catch { fail('Source must be an exact HTTPS origin.'); }
  if (url.origin !== value || url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname))) fail('Source must be HTTPS (HTTP allowed only on loopback).');
  return value;
}
function privateDirectory(path, managed = false) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid())) fail('Installation directory must be owned by this user and must not be a symlink.');
  mkdirSync(path, { recursive: true, mode: 0o700 }); if (managed) chmodSync(path, 0o700);
}
function privateFile(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077)) fail('Existing installation files must be private, regular files owned by this user.');
  return !!stat;
}
function write(path, bytes, mode = 0o600) {
  privateFile(path);
  const tmp = path + '.tmp-' + randomUUID();
  const fd = openSync(tmp, 'wx', mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}
async function json(url, body, token) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type':'application/json', ...(!token ? { Origin: new URL(url).origin } : {}) }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) { await response.body?.cancel(); fail(`Briefsip request failed (HTTP ${response.status}). Create a fresh install command if its token expired or was used.`); }
  let size = 0; const chunks = [];
  for await (const chunk of response.body ?? []) { size += chunk.length; if (size > 128 * 1024) fail('Briefsip response exceeds limit.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
// ponytail: standalone bootstrap repeats update-archive.ts ustar rules; share only when bootstrap has a trusted runtime.
async function unpack(response, stage, expected, size) {
  let received = 0, expanded = 0, pending = Buffer.alloc(0), left = 0, padding = 0, fd, ended = false, entries = 0;
  const hash = createHash('sha256'), seen = new Set();
  async function* compressed() { for await (const chunk of response.body) { received += chunk.length; if (received > size || received > limit) fail('Release exceeds download limit.'); hash.update(chunk); yield chunk; } }
  const input = Readable.from(compressed()), gunzip = createGunzip();
  input.on('error', error => gunzip.destroy(error)); const stream = input.pipe(gunzip);
  try {
    for await (const chunk of stream) {
      expanded += chunk.length; if (expanded > 2 * limit) fail('Expanded release exceeds limit.');
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (left) { const n = Math.min(left, pending.length); if (!n) break; writeSync(fd, pending.subarray(0,n)); pending = pending.subarray(n); left -= n; if (left) break; closeSync(fd); fd = undefined; }
        if (padding) { const n = Math.min(padding, pending.length); pending = pending.subarray(n); padding -= n; if (padding) break; }
        if (pending.length < 512) break;
        const header = pending.subarray(0,512); pending = pending.subarray(512);
        if (header.every(byte => byte === 0)) { ended = true; continue; }
        if (ended || ++entries > 100000) fail('Invalid archive trailer or file count.');
        const str = (a,b) => header.subarray(a,b).toString('utf8').replace(/\0.*$/s,'');
        const number = (a,b) => { const s = str(a,b).trim(); if (!/^[0-7]+$/.test(s)) fail('Invalid archive number.'); return parseInt(s,8); };
        if (header.reduce((sum,b,i) => sum + (i >= 148 && i < 156 ? 32 : b),0) !== number(148,156)) fail('Invalid archive checksum.');
        const prefix = str(345,500), raw = (prefix ? prefix + '/' : '') + str(0,100), name = raw.replace(/^\.\//,'').replace(/\/$/,''), type = str(156,157), bytes = number(124,136), mode = number(100,108);
        if (raw === './' && type === '5') continue;
        if (!name || name.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..') || seen.has(name) || !['','0','5'].includes(type) || type === '5' && bytes !== 0 || bytes > 2 * limit) fail('Unsafe archive entry.');
        seen.add(name); const path = join(stage,name);
        if (type === '5') mkdirSync(path, { recursive:true, mode:0o700 });
        else { mkdirSync(dirname(path), { recursive:true, mode:0o700 }); fd = openSync(path,'wx', mode & 0o111 ? 0o700 : 0o600); left = bytes; padding = (512 - bytes % 512) % 512; if (!left) { closeSync(fd); fd = undefined; } }
      }
    }
    if (left || padding || !ended || pending.some(b => b !== 0) || received !== size || hash.digest('hex') !== expected) fail('Release integrity or size check failed.');
  } finally { if (fd !== undefined) closeSync(fd); input.destroy(); stream.destroy(); }
}
function verify(stage, id) {
  const info = JSON.parse(readFileSync(join(stage,'release.json'),'utf8')), files = {};
  function walk(path, prefix = '') { for (const name of readdirSync(path).sort()) { const full = join(path,name), key = prefix + name, stat = lstatSync(full); if (stat.isDirectory()) walk(full,key+'/'); else if (stat.isFile()) { if (key !== 'release.json') files[key] = createHash('sha256').update(readFileSync(full)).digest('hex'); } else fail('Unsupported release entry.'); } }
  walk(stage);
  if (info.id !== id || !info.files || JSON.stringify(Object.entries(files).sort()) !== JSON.stringify(Object.entries(info.files).sort()) || JSON.parse(readFileSync(join(stage,'package.json'),'utf8')).version !== info.version) fail('Release manifest verification failed.');
}
try {
  for (let i=0; i<args.length; i++) {
    const flag = args[i];
    if (flag === '--serve') opt.serve = true;
    else if (flag === '--dry-run') opt.dry = true;
    else if (['--source','--token','--port','--name'].includes(flag) && args[i+1] && !args[i+1].startsWith('--')) opt[flag.slice(2)] = args[++i];
    else fail('Usage: install-machine.sh --source ORIGIN --token TOKEN [--port 4317] [--name NAME] [--serve] [--dry-run]');
  }
  const [major,minor,patch] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && (minor < 23 || minor === 23 && patch < 4)) fail('Node.js >= 22.23.4 is required.');
  if (process.platform !== 'linux') fail('Linux is required.');
  origin(opt.source);
  if (!/^bsi_[A-Za-z0-9_-]{43}$/.test(opt.token ?? '')) fail('Install token is invalid.');
  opt.port = Number(opt.port);
  if (!Number.isInteger(opt.port) || opt.port < 1 || opt.port > 65535 || typeof opt.name !== 'string' || !opt.name.trim() || opt.name.length > 120 || /[\x00-\x1f\x7f]/.test(opt.name)) fail('Invalid port or display name.');
  const home = process.env.HOME;
  if (!home || !home.startsWith('/') || /[\r\n\x00]/.test(home)) fail('HOME must be an absolute path.');
  const root = join(home,'.local/share/briefsip'), releases = join(root,'releases'), scripts = join(root,'scripts'), data = join(root,'data'), configDir = join(home,'.config/briefsip'), units = join(home,'.config/systemd/user'), configPath = join(configDir,'launcher.json'), envPath = join(configDir,'providers.env'), statePath = join(configDir,'machine-install.json');
  const local = `http://127.0.0.1:${opt.port}`, target = local;
  if (opt.dry) {
    for (const action of [
      'Check Linux, Node.js >= 22.23.4, bwrap, git, user systemd and optional Tailscale.',
      'Detect tailnet DNS name with tailscale status --json when available.',
      'Create private ~/.local/share/briefsip/{releases,scripts,data} and ~/.config/briefsip (0700).',
      `Download ${opt.source}/api/install/release with Bearer [redacted]; limit 1 GiB, SHA-256 and manifest verification; unpack releases/<id>; select current.`,
      'Install launcher, start.sh and uninstall-machine.sh; preserve provider configuration (no credentials supplied).',
      'Write ~/.config/briefsip/launcher.json and providers.env (0600); install ~/.config/systemd/user/briefsip.service.',
      'systemctl --user daemon-reload', 'systemctl --user enable --now briefsip.service',
      'loginctl enable-linger <user> (warn if not permitted)',
      `${opt.serve ? 'Run' : 'Print'}: tailscale serve --bg --https=${opt.port} ${target}`,
      `Wait for ${local}/api/environment and advertised origin; preserve existing pairing.`,
      `POST ${opt.source}/api/install/pairing-code with Bearer [redacted] (consumes token); print one-time code.`,
      `POST ${local}/api/environment to set display name; POST ${local}/api/machines to pair both ways; print summary.`
    ]) say(action);
    process.exit(0);
  }
  for (const name of ['bwrap','git']) if (!has(name)) say(`Warning: ${name} missing; its optional features stay unavailable.`);
  if (!has('systemctl')) fail('A systemd user manager is required.');
  command('systemctl',['--user','show-environment']);
  // Reject symlink ancestors before any installer-owned writes.
  for (const path of [home, join(home,'.local'), join(home,'.local/share'), root, releases, scripts, data, join(home,'.config'), configDir, join(home,'.config/systemd'), units]) privateDirectory(path, [root,releases,scripts,data,configDir].includes(path));
  for (const path of [configPath,envPath,statePath,join(scripts,'start.sh'),join(scripts,'briefsip-launcher.mjs'),join(scripts,'uninstall-machine.sh'),join(units,'briefsip.service')]) privateFile(path);
  const prior = existsSync(statePath) ? JSON.parse(readFileSync(statePath,'utf8')) : undefined;
  if (prior && (!releasePattern.test(prior.release ?? '') || typeof prior.serve !== 'boolean' || prior.source !== opt.source || prior.port !== opt.port)) fail('Existing installation uses another source or port. Preserve it; uninstall explicitly before replacing it.');
  if (!prior && (existsSync(configPath) || existsSync(join(units,'briefsip.service')))) fail('Existing launcher configuration or user unit was not created by this installer.');
  const tailscale = has('tailscale'); let advertised = local, dns;
  if (tailscale) {
    const result = command('tailscale',['status','--json'],false);
    try { dns = JSON.parse(result.stdout).Self.DNSName.replace(/\.$/,''); } catch {}
    if (dns && /^[a-z0-9.-]+\.ts\.net$/i.test(dns)) advertised = `https://${dns}:${opt.port}`;
    else dns = undefined;
  }
  if (!dns && !new URL(opt.source).hostname.match(/^(127\.0\.0\.1|\[::1\])$/)) fail('Join Tailscale and enable MagicDNS before installing from a remote source.');
  let id = prior?.release;
  if (!prior) {
    const response = await fetch(opt.source+'/api/install/release', { redirect:'error', headers:{ Authorization:`Bearer ${opt.token}` }, signal:AbortSignal.timeout(120_000) });
    if (!response.ok) { await response.body?.cancel(); fail(`Release download failed (HTTP ${response.status}). Create a fresh install command.`); }
    id = response.headers.get('x-briefsip-release'); const sha = response.headers.get('x-briefsip-sha256'), sizeText = response.headers.get('x-briefsip-size'), size = Number(sizeText);
    if (!releasePattern.test(id ?? '') || !/^[a-f0-9]{64}$/.test(sha ?? '') || !/^[1-9][0-9]*$/.test(sizeText ?? '') || !Number.isSafeInteger(size) || size > limit || response.headers.get('content-length') !== sizeText || response.headers.get('content-type') !== 'application/gzip' || !response.body) { await response.body?.cancel(); fail('Invalid release metadata.'); }
    const stage = mkdtempSync(join(releases,'.install-'));
    try {
      await unpack(response,stage,sha,size); verify(stage,id);
      if (existsSync(join(releases,id))) { verify(join(releases,id),id); }
      else renameSync(stage,join(releases,id));
    } finally { rmSync(stage,{recursive:true,force:true}); }
    if (lstatSync(join(releases,'current'),{throwIfNoEntry:false})) fail('Release selection already exists.');
    write(statePath,JSON.stringify({source:opt.source,port:opt.port,release:id,serve:false})+'\n');
  }
  verify(join(releases,id),id);
  if (!lstatSync(join(releases,'current'),{throwIfNoEntry:false})) symlinkSync(id,join(releases,'current'));
  for (const name of ['briefsip-launcher.mjs','uninstall-machine.sh']) if (!existsSync(join(scripts,name))) write(join(scripts,name),readFileSync(join(releases,id,'machine',name)),0o700);
  if (!existsSync(envPath)) write(envPath, `# Add provider accounts in Settings > Provider accounts.\n# Headless fallback: fill these values, then restart briefsip.service.\n# BRIEFSIP_PROVIDER=openai-compatible\n# OPENAI_BASE_URL=\n# OPENAI_API_KEY=\n# OPENAI_MODEL=\n${dns ? `BRIEFSIP_ALLOWED_ORIGINS=${advertised}\n` : ''}`);
  if (!existsSync(configPath)) write(configPath,JSON.stringify({dataDir:data,releasesDir:releases,envFile:envPath,port:opt.port},null,2)+'\n');
  const quote = value => "'"+value.replaceAll("'","'\\''")+"'";
  if (!existsSync(join(scripts,'start.sh'))) write(join(scripts,'start.sh'),`#!/bin/sh\nset -eu\n# No provider credentials here. Use Settings > Provider accounts, or ${envPath}.\nexec ${quote(process.execPath)} ${quote(join(scripts,'briefsip-launcher.mjs'))} --config ${quote(configPath)}\n`,0o700);
  // systemd specifiers expand even inside quotes; escape percent in an Owner's HOME.
  const executable = join(scripts,'start.sh').replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%');
  if (!existsSync(join(units,'briefsip.service'))) write(join(units,'briefsip.service'),`[Unit]\nDescription=Briefsip server launcher\nAfter=network.target\n\n[Service]\nType=simple\nExecStart="${executable}"\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`);
  const state = JSON.parse(readFileSync(statePath,'utf8'));
  command('systemctl',['--user','daemon-reload']); command('systemctl',['--user','enable','--now','briefsip.service']);
  if (!has('loginctl') || command('loginctl',['enable-linger',userInfo().username],false).status !== 0) say('Warning: linger unavailable. Briefsip may stop after logout; ask an administrator to enable it.');
  const serveArgs = ['serve','--bg',`--https=${opt.port}`,target];
  if (opt.serve) {
    if (!dns) fail('Tailscale DNS name unavailable. Join the tailnet before using --serve.');
    const status = command('tailscale',['serve','status','--json']);
    let settings; try { settings = JSON.parse(status.stdout); } catch { fail('Could not inspect Tailscale Serve; existing mappings are preserved.'); }
    const mapping = settings.Web?.[`${dns}:${opt.port}`], tcp = settings.TCP?.[String(opt.port)];
    if (!state.serve && (mapping || tcp)) fail('Tailscale Serve port already configured. Existing mappings are preserved.');
    if (state.serve && mapping?.Handlers?.['/']?.Proxy !== target && (mapping || tcp)) fail('Tailscale Serve mapping changed. Existing mapping is preserved.');
    // Record ownership before command, so an interrupted successful Serve remains removable.
    state.serve = true; state.dns = dns; write(statePath,JSON.stringify(state)+'\n');
    command('tailscale',serveArgs);
  } else say('To serve on tailnet: tailscale '+serveArgs.join(' '));
  let environment; const deadline = Date.now()+120_000;
  while (Date.now()<deadline) { try { environment = await json(local+'/api/environment'); break; } catch { await new Promise(r=>setTimeout(r,250)); } }
  if (!environment) fail('Briefsip did not become healthy. Check systemctl --user status briefsip.service.');
  const existing = await json(local+'/api/machines');
  if (!existing.machines.some(machine=>machine.origin===opt.source && machine.pairingState==='paired')) {
    // Test advertised HTTPS before consuming the source token.
    const visible = await json(advertised+'/api/environment');
    if (visible.id !== environment.id || visible.origin !== advertised) fail('Advertised origin does not reach this machine. Check Tailscale Serve and BRIEFSIP_ALLOWED_ORIGINS.');
    await json(local+'/api/environment',{id:randomUUID(),name:opt.name.trim()});
    const pairing = await json(opt.source+'/api/install/pairing-code',{},opt.token);
    if (!/^[A-Z0-9]{12}$/.test(pairing.code ?? '')) fail('Source returned an invalid pairing code.');
    say('Source pairing code: '+pairing.code+' (single use; expires in 10 minutes)');
    try { await json(local+'/api/machines',{id:randomUUID(),origin:opt.source,code:pairing.code}); }
    catch { fail('Pairing is unconfirmed. Check both Machines panels before creating a fresh install command.'); }
  }
  say(`Briefsip ready: ${advertised}\nData: ${data}\nMachines are paired in both directions.\nAdd provider accounts in Settings > Provider accounts.\nUninstall: sh ${join(scripts,'uninstall-machine.sh')} (data kept; --purge deletes it).`);
} catch (error) {
  // Never include request headers, response bodies or argv in errors.
  const message = error instanceof Error && !String(error.message).includes(opt.token) ? error.message : 'Installation failed.';
  process.stderr.write(message+'\n'); process.exitCode=1;
}
JS
