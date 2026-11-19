import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../ui-smoke/node_modules/playwright-core/index.mjs';

const [scratch, phase = 'after'] = process.argv.slice(2);
assert(['before', 'after'].includes(phase), 'Use before or after');
const { origin } = JSON.parse(await readFile(`${scratch}/fixture.out`, 'utf8'));
const output = new URL(`../ui-smoke/artifacts/ux-r3-composer/${phase}/`, import.meta.url); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const post = async (path, body) => { const res = await page.request.post(origin + path, { headers: { Origin: origin }, data: body }); assert(res.ok(), await res.text()); return res.json(); };
const shot = name => page.screenshot({ path: new URL(`${name}.png`, output).pathname });
const result = { phase, latency: [] };
try {
  const agent = await post('/api/agents', { runtime: 'api', id: randomUUID(), name: `Composer ${phase} ${randomUUID().slice(0, 6)}`, model: 'audit-model', instructions: 'Synthetic only.' });
  const path = `/api/agents/${agent.id}/turns`;
  await page.goto(origin);
  await page.getByRole('navigation', { name: 'Choose agent', exact: true }).getByRole('button', { name: new RegExp(`^${agent.name}`) }).click();
  const box = page.getByRole('textbox', { name: `Message ${agent.name}`, exact: true });
  await box.waitFor();
  for (const text of ['Latency probe one', 'Please delay latency probe two']) {
    await box.fill(text);
    await page.evaluate(text => {
      window.__latency = { bubble: null, working: null, post: null };
      document.querySelector('#message').addEventListener('keydown', () => {
        const start = performance.now();
        const observer = new MutationObserver(() => {
          const row = [...document.querySelectorAll('main article')].find(row => row.querySelector('.human-bubble')?.textContent === text);
          if (row && window.__latency.bubble === null) window.__latency.bubble = performance.now() - start;
          if (row && /Working…/.test(row.textContent) && window.__latency.working === null) window.__latency.working = performance.now() - start;
          if (window.__latency.bubble !== null && window.__latency.working !== null) observer.disconnect();
        }); observer.observe(document.querySelector('main'), { subtree: true, childList: true, characterData: true });
        const original = window.fetch;
        window.fetch = async (...args) => { const res = await original(...args); if (String(args[0]).endsWith('/turns') && args[1]?.method === 'POST') { window.__latency.post = performance.now() - start; window.fetch = original; } return res; };
      }, { once: true });
    }, text);
    await box.press('Enter');
    if (text.includes('delay')) { await page.waitForTimeout(300); await shot('send-300ms'); }
    await page.waitForFunction(() => window.__latency.bubble !== null);
    await page.waitForTimeout(100);
    result.latency.push({ text, ...await page.evaluate(() => window.__latency) });
    await page.waitForFunction(async path => (await fetch(path).then(r => r.json())).at(-1)?.status === 'done', path);
    await page.locator('main article').filter({ hasText: text }).getByRole('button', { name: /^Worked/ }).waitFor();
    await page.locator('.composer').getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden' });
  }
  await page.locator('.composer').getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden' });
  await box.fill('long slow UXA stream'); await box.press('Enter');
  await page.waitForFunction(async path => (await fetch(path).then(r => r.json())).at(-1)?.status === 'running', path);
  await page.locator('.composer').getByRole('button', { name: 'Stop', exact: true }).waitFor();
  await box.fill('Original queued text'); await box.press('Enter');
  const queue = page.getByRole('region', { name: 'Queued messages', exact: true });
  await queue.getByText('Original queued text', { exact: true }).waitFor(); await shot('queue');
  await queue.getByRole('listitem', { name: 'Queued message: Original queued text', exact: true }).getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = queue.getByRole('textbox', { name: 'Replacement message', exact: true });
  await edit.fill('Edited queued text'); await shot('queue-edit');
  const savedAt = Date.now();
  await queue.getByRole('button', { name: 'Save message', exact: true }).click();
  await queue.getByText('Edited queued text', { exact: true }).waitFor();
  if (phase === 'after') {
    await page.getByRole('navigation', { name: 'Choose agent', exact: true }).getByText('Edited queued text', { exact: true }).waitFor();
    result.sidebarRefreshMs = Date.now() - savedAt;
    assert(result.sidebarRefreshMs < 1000, `Sidebar edit refresh took ${result.sidebarRefreshMs}ms`);
  } else await page.waitForTimeout(1500);
  await shot('sidebar-preview');
  result.sidebarEdited = (await page.getByRole('navigation', { name: 'Choose agent', exact: true }).innerText()).includes('Edited queued text');
  if (phase === 'after') {
    const row = queue.getByRole('listitem', { name: 'Queued message: Edited queued text', exact: true });
    await row.getByRole('button', { name: 'Edit', exact: true }).click(); await edit.waitFor();
    const renewed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/edit') && response.request().postDataJSON()?.action === 'renew');
    const response = await renewed; assert.equal(response.status(), 200);
    assert(await edit.isEditable()); result.leaseRenewed = true;
    await edit.fill('Abandoned inline draft'); await edit.press('Escape'); await edit.waitFor({ state: 'hidden' });
    assert.equal(await queue.getByText('Discard draft copy', { exact: true }).count(), 0);
    await row.getByRole('button', { name: 'Edit', exact: true }).click(); await edit.waitFor();
    const released = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/edit') && response.request().postDataJSON()?.action === 'cancel');
    await page.evaluate(() => window.dispatchEvent(new Event('online'))); assert.equal((await released).status(), 200);
    await edit.waitFor({ state: 'hidden' }); result.reconnectReleased = true;
  }
  await queue.getByRole('listitem', { name: 'Queued message: Edited queued text', exact: true }).getByRole('button', { name: 'Edit', exact: true }).click(); await edit.waitFor();
  await page.reload(); await page.getByRole('navigation', { name: 'Choose agent', exact: true }).getByRole('button', { name: new RegExp(`^${agent.name}`) }).click(); await box.waitFor(); await page.locator('.composer').getByRole('button', { name: 'Stop', exact: true }).click();
  await page.waitForTimeout(2000); await shot('after-reload');
  result.abandoned = await page.request.get(origin + path).then(r => r.json()).then(rows => { const row = rows.find(row => row.text === 'Edited queued text'); return { id: row.id, status: row.status, editing: row.editing, revision: row.revision }; });
  if (phase === 'before') await post(`${path}/${result.abandoned.id}/cancel`, { id: randomUUID() });
  else {
    await page.waitForFunction(async path => (await fetch(path).then(r => r.json())).find(row => row.text === 'Edited queued text')?.status === 'done', path);
    await page.locator('.composer').getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden' });
    await box.fill('long slow UXA stream'); await box.press('Enter');
    await page.waitForFunction(async path => (await fetch(path).then(r => r.json())).at(-1)?.status === 'running', path);
    await page.locator('.composer').getByRole('button', { name: 'Stop', exact: true }).waitFor();
    const root = await page.request.get(origin + path).then(r => r.json()).then(rows => rows.at(-1).id);
    await box.fill('Send now synthetic'); await box.press('Enter');
    await queue.getByText('Send now synthetic', { exact: true }).waitFor();
    await queue.getByRole('listitem', { name: 'Queued message: Send now synthetic', exact: true }).getByRole('button', { name: 'Send now', exact: true }).click();
    await page.waitForFunction(async ({ path, root }) => { const rows = await fetch(path).then(r => r.json()); return rows.find(row => row.id === root)?.status === 'cancelled' && rows.at(-1)?.status === 'done'; }, { path, root });
    await shot('send-now');
  }
  if (phase === 'after') {
    await box.fill('long slow UXA stream'); await box.press('Enter');
    await page.waitForFunction(async path => (await fetch(path).then(r => r.json())).at(-1)?.status === 'running', path);
    const queued = await post(path, { id: randomUUID(), text: 'Close-tab queued message' });
    const tab = await page.context().newPage(); await tab.goto(origin);
    await tab.getByRole('navigation', { name: 'Choose agent', exact: true }).getByRole('button', { name: new RegExp(`^${agent.name}`) }).click();
    const row = tab.getByRole('listitem', { name: 'Queued message: Close-tab queued message', exact: true });
    await row.getByRole('button', { name: 'Edit', exact: true }).click(); await row.getByRole('textbox').waitFor();
    await tab.close();
    await page.waitForFunction(async ({ path, id }) => !(await fetch(path).then(r => r.json())).find(row => row.id === id)?.editing, { path, id: queued.id });
    result.closedTabReleased = true;
  }
  for (const turn of await page.request.get(origin + path).then(r => r.json())) if (turn.status === 'running') await post(`${path}/${turn.id}/cancel`, { id: randomUUID() });
  await page.waitForTimeout(1600);
  await box.evaluate(element => {
    const data = new DataTransfer(); data.items.add(new File(['Synthetic only.'], 'notes.txt', { type: 'text/plain' }));
    element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
  }); await shot('drop-target');
  await box.evaluate(element => {
    const data = new DataTransfer(); data.items.add(new File(['Synthetic only.'], 'notes.txt', { type: 'text/plain' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  const chips = page.getByRole('group', { name: 'Composer attachments', exact: true }); await chips.waitFor();
  await page.waitForTimeout(300); await shot('attachment-only');
  result.attachmentInside = await chips.evaluate(element => !!element.closest('.composer'));
  result.attachmentSendEnabled = await page.locator('.composer button[type=submit]').count() > 0 && await page.locator('.composer button[type=submit]').isEnabled();
  if (phase === 'after') {
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(async path => (await fetch(path).then(r => r.json())).at(-1)?.status === 'done', path);
    await chips.waitFor({ state: 'hidden' });
  } else await chips.getByRole('button', { name: 'Remove notes.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Record audio', exact: true }).click();
  const pill = page.getByRole('group', { name: 'Audio recording', exact: true }); await pill.waitFor();
  await page.waitForTimeout(1100); await shot('recording');
  result.recordingIndicator = await pill.locator('.voice-input__dot').count() > 0;
  await pill.getByRole('button', { name: 'Stop recording', exact: true }).click(); await chips.waitFor(); await page.waitForTimeout(200); await shot('voice-note');
  result.voiceName = await chips.innerText();
  if (phase === 'after') {
    assert(result.latency.every(sample => sample.bubble < 150 && sample.working < 150), JSON.stringify(result.latency));
    assert.equal(result.sidebarEdited, true); assert.equal(result.abandoned.editing, false);
    assert.equal(result.attachmentInside, true); assert.equal(result.attachmentSendEnabled, true);
    assert.equal(result.recordingIndicator, true); assert.match(result.voiceName, /Voice note \d+:\d{2}/);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await chips.waitFor({ state: 'hidden' });
  }
} catch (error) { await shot('failure'); result.error = error.message; result.main = await page.getByRole('main').innerText().catch(() => ''); throw error; } finally {
  await writeFile(new URL('measurements.json', output), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2)); await browser.close();
}
