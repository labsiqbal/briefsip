import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('../ui-smoke/node_modules/playwright-core');
const [origin, phase = 'after'] = process.argv.slice(2);
assert(['before', 'after'].includes(phase), 'Use before or after');
assert(origin && new URL(origin).hostname === '127.0.0.1', 'Disposable loopback fixture required');
const before = phase === 'before', evidence = new URL(`../ui-smoke/artifacts/ux-r6/${phase}/`, import.meta.url).pathname;
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
page.setDefaultTimeout(10000);
const results = { status: 'fail', assertions: 0 };
const check = (ok, message) => { if (!before) { assert(ok, message); results.assertions++; } };
const shot = name => page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' });
const api = async (path, body) => {
  const r = await page.request[body ? 'post' : 'get'](origin + path, body ? { headers: { Origin: origin }, data: body } : {});
  assert(r.ok(), `${path}: ${r.status()} ${await r.text()}`); return r.json();
};
try {
  const { agents } = await api('/api/agents'), iris = agents.find(a => a.name === 'Iris');
  assert(iris, 'Seed Iris, Theo, Mara, Coder and a long Iris chat with the R5 fixture');
  if (!before) {
    const popout = await browser.newPage(); await popout.goto(origin + '/?computer=' + iris.id);
    await popout.waitForFunction(() => document.title === 'Computer · Iris - Briefsip'); await popout.close();
  }
  await page.goto(origin + `/agents/${iris.id}`);
  const box = () => page.getByRole('textbox', { name: 'Message Iris', exact: true });
  await box().waitFor();
  const details = page.getByRole('complementary', { name: 'Conversation details', exact: true });
  if (!await details.isVisible()) await page.getByRole('button', { name: 'Show details', exact: true }).click();
  const thread = await api(`/api/agents/${iris.id}/threads`, { id: crypto.randomUUID(), name: 'R6 checklist' });
  await page.goto(origin + `/agents/${iris.id}/conversations/${thread.id}`); await box().waitFor();
  await page.locator('.chat__pill').click();
  const menu = page.getByRole('menu');
  results.menu = await menu.evaluate(el => ({ labels: [...el.querySelectorAll('[role=menuitem]')].map(x => x.textContent), icons: [...el.querySelectorAll('[role=menuitem]')].map(x => x.querySelectorAll('svg').length), separators: el.querySelectorAll('[role=separator], .menu__item--separated').length, top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, height: el.clientHeight, scroll: el.scrollHeight }));
  if (!before) assert.deepEqual(results.menu.labels, ['New conversation', 'Rename', 'Archive', 'Routines', 'Workflows', 'Workspace files', 'Conversation settings', 'Hide panel', 'Export template', 'Delete']);
  check(results.menu.labels[0] === 'New conversation' && results.menu.labels.at(-1) === 'Delete', 'New first, Delete last');
  check(await menu.getByRole('menuitem', { name: 'Delete', exact: true }).evaluate(el => el.classList.contains('is-danger') && el.classList.contains('menu__item--separated')), 'Delete alone and danger');
  check(results.menu.icons.every(n => n === 1) && results.menu.separators >= 3, 'All icons and distinct action groups');
  check(results.menu.top >= 0 && results.menu.bottom <= 900 && results.menu.height >= results.menu.scroll - 1, 'Whole menu fits 900px');
  await shot('02-header-menu'); await page.keyboard.press('Escape');
  if (!before) {
    await page.setViewportSize({ width: 1440, height: 360 }); await page.locator('.chat__pill').click();
    results.shortMenu = await menu.evaluate(el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, client: el.clientHeight, scroll: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
    check(results.shortMenu.top >= 0 && results.shortMenu.bottom <= 360 && results.shortMenu.scroll > results.shortMenu.client && results.shortMenu.overflow === 'auto', 'Short menu scrolls inside viewport');
    await menu.getByRole('menuitem', { name: 'Delete', exact: true }).scrollIntoViewIfNeeded(); await shot('02-header-menu-short');
    await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1440, height: 900 });
  }
  await details.locator(`[data-conversation-id="${thread.id}"]`).getByRole('button', { name: 'Menu conversation R6 checklist', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.waitForTimeout(100);
  results.renameFocused = await page.getByRole('textbox', { name: 'Conversation name', exact: true }).evaluate(el => document.activeElement === el);
  check(results.renameFocused, 'Row Rename focuses input after menu closes');
  await shot('01-rename-focus');
  if (before) await page.getByRole('textbox', { name: 'Conversation name', exact: true }).click();
  await page.keyboard.type('Renamed immediately');
  if (!before) check(await page.getByRole('textbox', { name: 'Conversation name', exact: true }).inputValue() === 'Renamed immediately', 'Typing replaces selected name');
  await page.getByRole('textbox', { name: 'Conversation name', exact: true }).press('Escape');
  if (!before) {
    await page.waitForFunction(() => !document.querySelector('.conversation-rename') && document.activeElement?.matches('.conversation-row > .panel-row'));
    const trigger = details.locator(`[data-conversation-id="${thread.id}"]`).getByRole('button', { name: 'Menu conversation R6 checklist', exact: true });
    await trigger.focus(); await page.keyboard.press('Enter'); await page.getByRole('menuitem', { name: 'Rename', exact: true }).press('Enter');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Conversation name');
    await page.keyboard.type('Keyboard renamed'); await page.keyboard.press('Enter');
    await details.locator(`[data-conversation-id="${thread.id}"]`).getByRole('button', { name: 'Keyboard renamed', exact: true }).waitFor();
    await page.waitForFunction(() => document.title === 'Keyboard renamed · Iris - Briefsip');
    check(await api(`/api/threads/${thread.id}`).then(row => row.name === 'Keyboard renamed'), 'Keyboard rename saved');
    await page.locator('.chat__pill').click(); await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: 'Conversation name', exact: true }).fill('Header renamed');
    await page.getByRole('textbox', { name: 'Conversation name', exact: true }).press('Enter');
    const renamedTrigger = details.getByRole('button', { name: 'Menu conversation Header renamed', exact: true });
    await renamedTrigger.waitFor(); await renamedTrigger.focus(); await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor(); await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Menu conversation Header renamed');
    check(await renamedTrigger.evaluate(el => el === document.activeElement), 'Row menu restores focus after saved header rename');
  }
  await box().focus();
  results.composerOutline = await page.locator('.composer').evaluate(el => getComputedStyle(el).outlineStyle);
  check(results.composerOutline === 'none', 'Composer has no outline'); await shot('07-composer');
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Quick switcher', exact: true });
  await palette.waitFor();
  results.paletteOutline = await palette.evaluate(el => getComputedStyle(el).outlineStyle);
  check(results.paletteOutline === 'none', 'Palette has no outline'); await shot('07-palette');
  if (!before) {
    await palette.getByRole('combobox').fill('New conversation');
    const prior = page.url(); await palette.getByRole('option', { name: /New conversation Ctrl/ }).click();
    await page.waitForURL(url => url.href !== prior); await box().waitFor();
    check(await box().evaluate(el => el === document.activeElement), 'Palette creates conversation and focuses composer');
  } else await page.keyboard.press('Escape');
  if (!before) {
    const prior = page.url(); await box().focus(); await page.keyboard.press('Control+Shift+o');
    await page.waitForURL(url => url.href !== prior); await box().waitFor();
    check(await box().evaluate(el => el === document.activeElement), 'New conversation shortcut focuses composer');
    await details.getByLabel('New conversation', { exact: true }).hover();
    await page.getByRole('tooltip', { name: /Ctrl\/Cmd\+Shift\+O/ }).waitFor();
    await shot('11-new-conversation-shortcut');
    const priorMeta = page.url(); await box().focus(); await page.keyboard.press('Meta+Shift+o');
    await page.waitForURL(url => url.href !== priorMeta); await box().waitFor();
    check(await box().evaluate(el => el === document.activeElement), 'Meta shortcut creates conversation and focuses composer');
  }
  for (const path of ['/nonsense/path', '/settings/nope', '/agents/malformed', `/machines/${crypto.randomUUID()}/agents/${crypto.randomUUID()}`, `/agents/${crypto.randomUUID()}`, `/agents/${iris.id}/conversations/${crypto.randomUUID()}`, `/rooms/${crypto.randomUUID()}`, `/projects/${crypto.randomUUID()}`]) {
    const response = await page.goto(origin + path);
    if (!before && ['/nonsense/path', '/settings/nope', '/agents/malformed'].includes(path)) check(response.status() === 404, 'Invalid route syntax returns 404');
    if (path === '/nonsense/path') {
      results.unknownStatus = response.status(); results.unknownType = response.headers()['content-type'];
      check(response.status() === 404 && results.unknownType.includes('text/html'), 'Unknown non-API path serves HTML 404');
      await shot('03-unknown-path');
    }
    if (!before) { await page.getByText('Page not found', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Back to chats', exact: true }).click(); await box().waitFor(); }
  }
  await page.goto(origin + `/agents/${iris.id}`); await box().waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.setViewportSize({ width: 700, height: 900 });
  await shot('14-settings-700');
  results.settingsNavWidth = await page.locator('.app-settings__nav').evaluate(el => el.getBoundingClientRect().width);
  check(results.settingsNavWidth < 100, 'Settings nav collapses below 768px');
  check(before || await page.title() === 'Settings · Appearance - Briefsip', 'Settings route title');
  if (!before) {
    const rows = await page.locator('.app-settings__page--preferences .k-row').evaluateAll(rows => rows.map(el => ({ label: el.querySelector('.k-row__main').getBoundingClientRect().bottom, controls: el.querySelector('.k-row__trailing').getBoundingClientRect().top })));
    check(rows.every(row => row.controls >= row.label), 'Appearance rows stack consistently');
  }
  await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1440, height: 900 });
  if (!before) {
    const projectName = 'Launch plan ' + crypto.randomUUID().slice(0, 4);
    const project = await api('/api/projects', { id: crypto.randomUUID(), name: projectName, members: agents.slice(0, 3).map(a => ({ agent: a.id, write: false })) });
    const saved = (await api('/api/projects')).projects.find(p => p.id === project.id), room = saved.sections[0];
    await page.goto(origin + `/projects/${project.id}`);
    await page.getByRole('heading', { name: projectName, exact: true }).waitFor();
    check(await page.title() === projectName + ' - Briefsip', 'Project title');
    check(await page.locator('.project-home .k-row__leading:has(.bs-avatar)').evaluateAll(els => els.length === 3 && els.every(el => getComputedStyle(el).borderRadius === '50%')), 'Project avatars circular');
    await shot('13-project-avatars');
    await page.getByRole('button', { name: '# general in ' + projectName, exact: true }).click();
    await page.getByRole('textbox', { name: 'Message #general', exact: true }).waitFor();
    check(await page.title() === '#general · ' + projectName + ' - Briefsip', 'Room title');
    await page.getByRole('tab', { name: /^Agents/ }).first().click();
    await page.getByRole('button', { name: /^Theo/ }).first().click();
    await page.getByRole('textbox', { name: 'Message Theo', exact: true }).waitFor();
    await page.goBack();
    await page.getByRole('textbox', { name: 'Message #general', exact: true }).waitFor();
    check(await page.getByRole('tab', { name: /^Projects/ }).first().getAttribute('aria-selected') === 'true', 'Back to room selects Projects');
    check(await page.getByRole('button', { name: '# general in ' + projectName, exact: true }).getAttribute('aria-current') === 'page', 'Room marked current');
    await shot('04-back-room');
    await page.goto(origin + `/agents/${iris.id}`); await box().waitFor();
    await page.getByRole('tab', { name: /^Projects/ }).first().click(); await page.goto(origin); await box().waitFor();
    check(await page.getByRole('tab', { name: /^Projects/ }).first().getAttribute('aria-selected') === 'true', 'Manual sidebar tab survives root reload');
    await page.goto(origin + `/agents/${iris.id}/conversations/${thread.id}`); await box().waitFor();
    const latest = await api(`/api/threads/${thread.id}`);
    await api(`/api/threads/${thread.id}/delete`, { id: crypto.randomUUID(), revision: latest.revision });
    await page.getByText('Page not found', { exact: true }).waitFor();
    check(page.url().endsWith('/conversations/' + thread.id), 'Externally deleted conversation keeps its URL');
    await page.reload(); await page.getByText('Page not found', { exact: true }).waitFor(); await shot('03-deleted-conversation');
    await page.getByRole('button', { name: 'Back to chats', exact: true }).click(); await box().waitFor();
    await box().fill('long slow UXA stream'); await box().press('Enter');
    await page.locator('.live-answer').waitFor();
    const running = (await api(`/api/agents/${iris.id}/turns`)).at(-1);
    for (const text of ['First R6 queue', 'Second R6 queue']) { await box().fill(text); await box().press('Enter'); }
    await page.getByRole('region', { name: 'Queued messages', exact: true }).getByText('Second R6 queue', { exact: true }).waitFor();
    check(await details.getByRole('button', { name: /^Queue / }).count() === 0, 'No duplicate panel queue');
    await shot('10-queue');
    await api(`/api/agents/${iris.id}/turns/${running.id}/cancel`, { id: crypto.randomUUID() });
    await page.waitForFunction(async path => (await fetch(path).then(r => r.json())).every(t => !['queued','running'].includes(t.status)), `/api/agents/${iris.id}/turns`);
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await page.getByText('Ctrl/Cmd + Shift + O', { exact: true }).waitFor(); await shot('11-shortcuts');
    const helpURL = page.url(); await page.keyboard.press('Control+Shift+o');
    check(page.url() === helpURL && await page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true }).isVisible(), 'Shortcut leaves dialog keyboard ownership intact');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'MCP connections', exact: true }).click();
    check(await page.getByRole('button', { name: 'MCP connections', exact: true }).locator('svg.lucide-cable').count() === 1, 'Distinct MCP icon');
    await shot('12-mcp-icon'); await page.keyboard.press('Escape');
  }
  results.clsRuns = [];
  for (let run = 0; run < (before ? 1 : 6); run++) {
    await page.goto(origin + `/agents/${iris.id}`); await box().waitFor();
    await page.getByRole('tab', { name: /Agents/ }).first().click();
    for (const name of ['Iris', 'Theo', 'Mara', 'Coder', 'Iris']) {
      await page.getByRole('button', { name: new RegExp('^' + name) }).first().click();
      await page.getByRole('textbox', { name: `Message ${name}`, exact: true }).waitFor();
      await page.waitForLoadState('networkidle');
    }
    await box().fill('markdown again please');
    await page.evaluate(() => { window.__shifts = []; window.__trace = []; const start = performance.now(); const tick = () => { window.__trace.push({ time: performance.now(), rows: [...document.querySelectorAll('.turn-block')].map(el => ({ id: el.id, top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height, text: el.querySelector('.human-bubble')?.textContent })) }); if (performance.now() - start < 4000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); new PerformanceObserver(list => { for (const e of list.getEntries()) window.__shifts.push({ value: e.value, time: e.startTime, sources: e.sources.map(s => ({ node: s.node?.className, id: s.node?.id, from: s.previousRect.toJSON(), to: s.currentRect.toJSON() })) }); }).observe({ type: 'layout-shift' }); });
    await box().press('Enter');
    await page.waitForFunction(() => !!document.querySelector('.live-answer .stream-markdown .markdown'));
    await page.evaluate(() => { window.__streamed = document.querySelector('.live-answer .stream-markdown .markdown'); window.__streamedTurn = window.__streamed.closest('.turn-block'); });
    await shot('09-streaming');
    await page.waitForFunction(() => !document.querySelector('.live-answer'));
    await page.waitForTimeout(1400);
    results.cls = await page.evaluate(() => window.__shifts.reduce((sum, x) => sum + x.value, 0));
    results.shifts = await page.evaluate(() => window.__shifts);
    if (results.cls >= .05) results.trace = await page.evaluate(() => window.__trace);
    results.retainedDOM = await page.evaluate(() => window.__streamed.isConnected && window.__streamedTurn === document.querySelector('.turn-block:last-of-type'));
    check(results.retainedDOM, 'Final answer retains streamed Markdown DOM');
    check(results.cls < .05, `R4 switch-back/send CLS ${results.cls} exceeds .05`);
    await shot('09-complete');
    results.clsRuns.push({ cls: results.cls, retainedDOM: results.retainedDOM });
  }
  results.textOnlyDisclosure = await page.getByRole('button', { name: /^Worked for/ }).count();
  check(results.textOnlyDisclosure === 0, 'No empty work-log disclosures');
  await shot('06-duration');
  results.status = before ? 'baseline' : 'pass';
  console.log(JSON.stringify(results, null, 2));
} finally {
  await writeFile(join(evidence, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  await browser.close();
}
