import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require('../ui-smoke/node_modules/playwright-core');
const [origin, phase = 'after'] = process.argv.slice(2);
assert(['before', 'after'].includes(phase), 'Use before or after');
assert(origin?.startsWith('http://127.0.0.1:'), 'Disposable loopback fixture required');
const projectName = `UX Launch ${phase} ${crypto.randomUUID().slice(0, 4)}`;
const output = new URL(`../ui-smoke/artifacts/ux-navigation/${phase}/`, import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
await page.route('**/api/updates', async route => {
  const response = await route.fetch();
  const status = await response.json();
  await route.fulfill({ response, json: { ...status, launcherAvailable: true, available: { version: '0.11.0' } } });
});
page.setDefaultTimeout(10000);
const shot = async name => { await page.mouse.move(0, 0); await page.evaluate(() => { if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur(); }); await page.waitForTimeout(220); await page.screenshot({ path: `${output}${name}.png` }); };
const api = (path, body) => page.evaluate(async ({ path, body }) => {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!response.ok) throw Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}, { path, body });
const verify = phase === 'after';
try {
  await page.goto(origin);
  const agents = [];
  for (const name of ['UX Iris', 'UX Theo', 'UX Mara']) agents.push(await api('/api/agents', { runtime: 'api', id: crypto.randomUUID(), name, model: 'audit-model', instructions: 'Synthetic UX navigation fixture.' }));
  await page.reload();
  await page.locator('.bot-row').filter({ hasText: 'UX Iris' }).first().waitFor();
  assert.equal(await page.locator('.bot-row').filter({ hasText: 'UX Iris' }).last().locator('time').count(), 0);
  await shot('UX-35-times');
  await page.keyboard.press('Control+k');
  if (verify) {
    const palette=page.getByRole('dialog', { name: 'Quick switcher' });
    await palette.waitFor();
    const groups=await palette.locator('.quick-switcher__group').allTextContents();
    assert.equal(groups.length, new Set(groups).size);
  }
  await shot('UX-11');
  if (verify) await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 900, height: 900 });
  if (await page.locator('.right-panel-sheet').isVisible()) await page.keyboard.press('Escape');
  await shot('UX-31');
  if (verify) {
    assert.equal(await page.locator('.sidebar-settings__update').count(), 1);
    assert.equal(await page.locator('.provider-status').innerText(), '');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: /Agents/ }).click();
  const search = page.getByRole('textbox', { name: 'Search agents', exact: true });
  await search.fill('no-such-synthetic-agent');
  await shot('UX-35');
  if (verify) assert.equal(await page.getByText('No matching agents.', { exact: true }).count(), 1);
  await search.fill('');
  await page.getByRole('tab', { name: /Projects/ }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Project name' }).fill(projectName);
  await shot('UX-34');
  if (verify) assert.equal(await dialog.locator('.k-card').count(), 0);
  for (const agent of agents) {
    await dialog.getByRole('combobox', { name: 'Add project member' }).click();
    await page.getByRole('option', { name: agent.name, exact: true }).last().click();
  }
  await shot('UX-21-members');
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForTimeout(800);
  await shot('UX-21');
  const project = (await api('/api/projects')).projects.findLast(project => project.name === projectName);
  if (verify) {
    assert.deepEqual(project.members.map(member => member.agent), agents.map(agent => agent.id));
    await page.getByRole('textbox', { name: `Message ${projectName} / # general`, exact: true }).waitFor();
  } else await page.getByRole('button', { name: `# general in ${projectName}`, exact: true }).click();
  const composer = page.locator('textarea').first();
  await composer.fill('Team, what is the biggest risk for the launch?');
  await composer.press('Enter');
  await page.getByText('Team, what is the biggest risk for the launch?', { exact: true }).waitFor();
  await page.waitForTimeout(1200);
  await shot('UX-20');
  if (!verify) await page.waitForTimeout(1700);
  await shot('UX-19');
  if (verify) {
    assert.equal(await page.getByRole('button', { name: 'Mark as read', exact: true }).count(), 0);
    await page.locator('.composer-area').getByRole('button', { name: 'Stop', exact: true }).click();
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    await page.waitForTimeout(1300);
    await page.waitForFunction(async id => { const channels=await (await fetch('/api/channels')).json(); const channel=channels.find(row=>row.id===id); return channel.activity === channel.read_position; }, project.channel);
    assert.equal((await api(`/api/channels/${project.channel}/turns`)).filter(turn => turn.room?.active).length, 0);
  }
  await page.getByRole('button', { name: /^Settings(?: - Update available)?$/ }).click();
  await page.getByRole('button', { name: 'briefsip.com', exact: true }).click();
  await page.waitForTimeout(300);
  await shot('UX-40');
  if (verify) {
    assert.equal(await page.getByRole('button', { name: 'Link machine', exact: true }).count(), 0);
    assert.equal(await page.getByRole('alert').count(), 0);
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    const openPalette = async (query, key = 'Control+k') => {
      await page.keyboard.press(key);
      const palette = page.getByRole('dialog', { name: 'Quick switcher', exact: true });
      await palette.getByRole('combobox', { name: 'Jump to', exact: true }).fill(query);
      return palette;
    };
    const pick = async query => { const palette = await openPalette(query); await palette.getByRole('option').first().waitFor(); await page.keyboard.press('Enter'); await palette.waitFor({ state: 'hidden' }); };
    await pick('UX Theo Agents');
    await page.getByRole('main', { name: 'Conversation UX Theo', exact: true }).waitFor();
    const box = page.locator('textarea').first(); await box.focus();
    const palette = await openPalette('no such destination', 'Meta+k');
    await palette.getByText('No results', { exact: true }).waitFor();
    await shot('UX-11-empty');
    await page.keyboard.press('Escape');
    assert.equal(await box.evaluate(element => element === document.activeElement), true);
    await pick('Appearance Settings');
    await page.getByRole('heading', { name: 'Appearance', exact: true }).waitFor();
    await pick('New agent');
    await page.getByRole('dialog', { name: 'New agent', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await pick('New project');
    await page.getByRole('dialog', { name: 'New project', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await pick(`${projectName} Projects`);
    await page.getByRole('heading', { name: projectName, exact: true }).waitFor();
    const card = page.locator('.project-home .k-section').filter({ has: page.getByRole('heading', { name: 'Members', exact: true }) });
    assert.deepEqual(await card.locator('.k-row__title').allTextContents(), agents.map(agent=>agent.name));
    assert.equal(await card.getByText('Read only', { exact: true }).count(), 3);
    await shot('UX-21-home');
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(), agents.map(agent=>agent.name));
    await page.getByRole('menuitem', { name: agents[1].name, exact: true }).click();
    await page.getByRole('main', { name: 'Conversation Project conversation', exact: true }).waitFor();
    await pick('Project conversation Conversations');
    await page.getByRole('main', { name: 'Conversation Project conversation', exact: true }).waitFor();
    await api(`/api/agents/${agents[0].id}/threads`, { id: crypto.randomUUID(), name: 'UX side conversation' });
    await pick('Appearance Settings');
    await page.getByRole('heading', { name: 'Appearance', exact: true }).waitFor();
    await pick('UX side conversation Conversations');
    await page.getByRole('main', { name: 'Conversation UX side conversation', exact: true }).waitFor();
    const conversations = await openPalette('Conversations');
    await conversations.getByRole('option', { name: /UX side conversation/ }).waitFor();
    assert.equal(await conversations.locator('.quick-switcher__group').count(), 1);
    await conversations.getByRole('option', { name: /Project conversation/ }).waitFor();
    await shot('UX-11-conversations');
    await page.keyboard.press('Escape');
    await pick(`${projectName} general Sections`);
    await page.getByRole('main', { name: `Conversation ${projectName} / # general`, exact: true }).waitFor();
    const longText = 'Team, review synthetic notes:\n' + Array.from({ length: 50 }, (_, index) => `Synthetic line ${index}`).join('\n');
    const roomBox = page.locator('textarea').first();
    await roomBox.fill(longText); await roomBox.press('Enter');
    await page.getByText(longText, { exact: true }).waitFor();
    await page.waitForFunction(() => { const element=document.querySelector('.transcript');return element.scrollHeight > element.clientHeight + 300; });
    await page.locator('.transcript').hover();
    await page.mouse.wheel(0, -5000);
    await page.getByRole('button', { name: 'Jump to latest', exact: true }).waitFor();
    await api(`/api/channels/${project.channel}/turns`, { id: crypto.randomUUID(), text: 'Team, incoming activity while reading earlier notes.' });
    await page.waitForTimeout(5500);
    const unread = (await api('/api/channels')).find(channel => channel.id === project.channel);
    assert(unread.activity > unread.read_position, 'Scrolled-up room must stay unread');
    await shot('UX-19-scrolled-up');
    await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
    await page.waitForFunction(async id => { const channels = await (await fetch('/api/channels')).json(); const channel = channels.find(row => row.id === id); return channel.activity === channel.read_position; }, project.channel);
    for (const theme of ['light', 'dark']) for (const width of [1024, 900]) {
      await page.setViewportSize({ width, height: 768 });
      if (await page.locator('.right-panel-sheet').isVisible()) await page.keyboard.press('Escape');
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.textSize = 'larger'; }, theme);
      await shot(`room-${theme}-${width}`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page overflow');
    }
    assert.equal(errors.length, 0, errors.join('\n'));
  }
  console.log(`${phase}: navigation evidence captured; ${verify ? 'assertions passed' : 'baseline reproduced'}`);
} catch (error) { await shot('error'); throw error; } finally { await browser.close(); }
