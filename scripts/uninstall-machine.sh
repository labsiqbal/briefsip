#!/bin/sh
set -eu
command -v node >/dev/null 2>&1 || { echo 'Node.js is required.' >&2; exit 1; }
exec node --input-type=module - "$@" <<'JS'
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.some(a=>a!=='--purge')) throw new Error('Usage: uninstall-machine.sh [--purge]');
const home = process.env.HOME;
if (!home || !home.startsWith('/')) throw new Error('HOME must be absolute.');
const root = join(home,'.local/share/briefsip'), config = join(home,'.config/briefsip'), unit = join(home,'.config/systemd/user/briefsip.service'), statePath = join(config,'machine-install.json');
for (const path of [home,join(home,'.local'),join(home,'.local/share'),root,join(root,'scripts'),join(home,'.config'),config,join(home,'.config/systemd'),join(home,'.config/systemd/user')]) {
  const stat = lstatSync(path,{throwIfNoEntry:false}); if (stat && (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid())) throw new Error('Unsafe installation path.');
}
const stat = lstatSync(statePath,{throwIfNoEntry:false});
if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('Installer ownership record missing. Nothing removed.');
const state = JSON.parse(readFileSync(statePath,'utf8'));
if (!Number.isInteger(state.port) || state.port<1 || state.port>65535) throw new Error('Invalid installer ownership record.');
function run(name,argv) { const result=spawnSync(name,argv,{stdio:'pipe',encoding:'utf8',timeout:30000}); if(result.error||result.status!==0) throw new Error(`${name} failed; installation preserved for retry.`); return result; }
if (existsSync(unit)) run('systemctl',['--user','disable','--now','briefsip.service']);
if (state.serve) {
  const status=JSON.parse(run('tailscale',['serve','status','--json']).stdout), mapping=status.Web?.[`${state.dns}:${state.port}`];
  if (mapping?.Handlers?.['/']?.Proxy === `http://127.0.0.1:${state.port}` && Object.keys(mapping.Handlers).length===1) run('tailscale',['serve',`--https=${state.port}`,'off']);
  else if(mapping || status.TCP?.[String(state.port)]) throw new Error('Tailscale Serve mapping changed; remove it manually. Other mappings preserved.');
}
rmSync(unit,{force:true}); run('systemctl',['--user','daemon-reload']);
for (const name of ['start.sh','briefsip-launcher.mjs','uninstall-machine.sh']) rmSync(join(root,'scripts',name),{force:true});
try { rmdirSync(join(root,'scripts')); } catch (error) { if (!['ENOENT','ENOTEMPTY'].includes(error.code)) throw error; }
if(args.includes('--purge')) { rmSync(root,{recursive:true,force:true}); rmSync(config,{recursive:true,force:true}); console.log('Briefsip installation and data removed.'); }
else console.log(`Briefsip stopped and launcher removed. Data, releases and provider configuration kept at ${root} and ${config}. Pairing access remains until unpaired in Settings > Machines. Linger unchanged.`);
JS
