#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export async function checkServed(origin, { present = [], absent = [], expectVersion } = {}) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Expected an HTTP(S) origin, e.g. https://minarbot.example.');
  if ([present, absent].some(markers => !Array.isArray(markers) || markers.some(text => typeof text !== 'string' || !text.length)) || expectVersion !== undefined && (typeof expectVersion !== 'string' || !expectVersion.length)) throw new Error('Markers and expected version must be non-empty text.');
  const files = [], report = [];
  async function get(target, type) {
    if (target.origin !== url.origin || target.username || target.password) throw new Error(`Refusing asset outside origin: ${target.href}`);
    let response;
    try { response = await fetch(target, { method: 'GET', headers: { Origin: url.origin, 'Sec-Fetch-Site': 'same-origin', 'Cache-Control': 'no-cache' }, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch (error) { throw new Error(`GET ${target.href} failed: ${error.message}`); }
    if (!response.ok) throw new Error(`GET ${target.href}: HTTP ${response.status}`);
    if (!type.test(response.headers.get('content-type') ?? '')) throw new Error(`GET ${target.href}: unexpected Content-Type ${response.headers.get('content-type')}`);
    const text = await response.text();
    report.push(`GET ${target.pathname}${target.search}: ${response.status}`);
    return text;
  }
  const html = await get(url, /text\/html/i);
  files.push({ path: '/', text: html });
  const assets = new Map();
  // ponytail: Vite emits static script/link tags; use an HTML parser if entry markup becomes dynamic.
  for (const [tag] of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const attrs = Object.fromEntries([...tag.matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)].map(m => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4]]));
    const ref = /^<script\b/i.test(tag) ? attrs.src : attrs.href;
    if (!ref) continue;
    const asset = new URL(ref.replaceAll('&amp;', '&'), url);
    if (/\.(?:m?js|css)$/i.test(asset.pathname)) assets.set(asset.href, asset);
  }
  for (const [name, extension] of [['JS', /\.m?js$/i], ['CSS', /\.css$/i]]) if (![...assets.values()].some(asset => extension.test(asset.pathname))) throw new Error(`index.html references no ${name} assets; check served build.`);
  for (const asset of assets.values()) files.push({ path: asset.pathname, text: await get(asset, /\.css$/i.test(asset.pathname) ? /text\/css/i : /(?:text|application)\/(?:javascript|ecmascript|x-javascript)/i) });
  let ok = true;
  for (const [markers, wanted] of [[present, true], [absent, false]]) for (const marker of markers) {
    const found = files.filter(file => file.text.includes(marker)).map(file => file.path);
    const pass = Boolean(found.length) === wanted;
    if (!pass) ok = false;
    report.push(`${pass ? 'PASS' : 'FAIL'} ${wanted ? 'present' : 'absent'} ${JSON.stringify(marker)}${found.length ? ` in ${found.join(', ')}` : ' (not found)'}`);
  }
  if (expectVersion !== undefined) {
    const state = JSON.parse(await get(new URL('/api/updates', url), /application\/json/i));
    const actual = state?.current?.version, pass = actual === expectVersion;
    if (!pass) ok = false;
    report.push(`${pass ? 'PASS' : 'FAIL'} version: expected ${expectVersion}, served ${actual ?? '(missing current.version)'}`);
  }
  return { ok, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { present: { type: 'string', multiple: true }, absent: { type: 'string', multiple: true }, 'expect-version': { type: 'string' } } });
    if (positionals.length !== 1) throw new Error('Usage: node scripts/check-served.mjs <origin> [--present <text>] [--absent <text>] [--expect-version <version>]');
    const result = await checkServed(positionals[0], { present: values.present, absent: values.absent, expectVersion: values['expect-version'] });
    console.log(result.report.join('\n'));
    console.log(`Served check ${result.ok ? 'passed' : 'FAILED'}.`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(`Served check FAILED: ${error.message}`); process.exitCode = 1; }
}
