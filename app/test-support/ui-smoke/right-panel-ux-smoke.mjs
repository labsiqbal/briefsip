import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function rightPanelUXSmoke({ check, page, origin, root, agentChat }) {
  const evidence = join(root, 'app/test-support/ui-smoke/artifacts/ux-right-panel');
  await mkdir(evidence, { recursive: true });
  const panel = page.getByRole('complementary', { name: 'Conversation details', exact: true });
  const shot = async name => {
    await page.mouse.move(0, 0); await panel.getByRole('tab', { selected: true }).focus();
    await page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' });
  };
  async function open() {
    const show = page.getByRole('button', { name: 'Show details', exact: true });
    if (await show.isVisible()) await show.click();
    await panel.waitFor();
  }
  await check('UXC unsupported Computer hidden; one labelled tab row', async () => {
    await agentChat(); await open();
    await panel.getByRole('tab', { name: 'Chats', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.right-panel .details__identity'));
    assert.equal(await panel.getByRole('tablist').count(), 1);
    assert.deepEqual(await panel.getByRole('tab').allTextContents(), ['Chats', 'Files']);
    assert.equal(await panel.getByRole('region', { name: 'Computer', exact: true }).count(), 0);
    assert.equal(await panel.getByRole('button', { name: /Reload|Refresh/ }).count(), 0);
    for (const label of await panel.locator('.right-panel__tab-label').all()) assert(await label.evaluate(el => el.getBoundingClientRect().width > 10));
    await shot('UX-04-after-unsupported'); await shot('UX-14-after'); await shot('UX-36-after');
    await shot('integration-right-panel');
  });
  await check('UXC one conversation search; keyboard find works after closing narrow sheet', async () => {
    const find = page.getByRole('search', { name: 'Find in conversation', exact: true });
    try {
      for (const width of [1440, 1024]) {
        await page.setViewportSize({ width, height: 900 }); await open();
        await panel.getByRole('tab', { name: 'Chats', exact: true }).click();
        assert.equal(await panel.getByRole('searchbox').count(), 0);
        const sheet = page.getByRole('dialog', { name: 'Conversation panel', exact: true });
        if (await sheet.isVisible()) await sheet.getByRole('button', { name: 'Close details', exact: true }).click();
        await page.keyboard.press('Control+f');
        await find.waitFor({ timeout: 3000 });
        await page.waitForFunction(() => document.activeElement?.matches('.message-find input'));
        await find.getByRole('searchbox').press('Escape');
        await find.waitFor({ state: 'hidden' });
        const close = panel.getByRole('button', { name: 'Close details', exact: true });
        if (await close.isVisible()) await close.click();
        await page.keyboard.press('Control+f'); await find.waitFor();
        await find.getByRole('searchbox').fill('Smoke');
        await find.getByRole('searchbox').press('Escape');
        await find.waitFor({ state: 'hidden' });
      }
    } finally {
      const sheet = page.getByRole('dialog', { name: 'Conversation panel', exact: true });
      if (await sheet.isVisible()) await sheet.getByRole('button', { name: 'Close details', exact: true }).click();
      if (await find.isVisible()) await find.getByRole('button', { name: 'Close search', exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 900 }); await open();
    }
  });
  await check('UXC returned file attaches through existing upload boundary', async () => {
    const id = randomUUID(), name = 'returned-task-file.txt';
    const list = /\/api\/agents\/[^/]+\/panel\/files$/;
    const source = new RegExp(`/panel/files/${id}(?:\\?(?:preview=text|metadata=1))?$`);
    let copied;
    const capture = req => { if (req.method() === 'POST' && /\/files\/[a-f0-9-]+$/.test(new URL(req.url()).pathname)) copied = new URL(req.url()).pathname.split('/').at(-1); };
    page.on('request', capture);
    await page.route(list, route => route.fulfill({ json: [{ seq: 999, id, name, size: 12 }] }));
    await page.route(source, route => route.fulfill(route.request().url().includes('metadata=1') ? { json: { id, name, size: 12, image: false } } : route.request().url().includes('?') ? { json: { text: 'Task output.' } } : { contentType: 'text/plain', body: 'Task output.' }));
    try {
      await panel.getByRole('tab', { name: 'Files', exact: true }).click();
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await panel.getByRole('button', { name: `File actions: ${name}`, exact: true }).click();
      await page.getByRole('menuitem', { name: 'Attach to message', exact: true }).click();
      await page.getByRole('button', { name: `Remove ${name}`, exact: true }).waitFor();
      assert(copied && copied !== id, 'Returned source ID crossed attachment scope');
      const result = await page.request.get(origin + `/api/agents/${(await page.request.get(origin + '/api/agents').then(r => r.json())).agents.find(a => a.name === 'Smoke Lead').id}/files/${copied}`);
      assert(result.ok()); assert.equal(await result.text(), 'Task output.');
      await panel.getByRole('button', { name: `File actions: ${name}`, exact: true }).click();
      await page.getByRole('menuitem', { name: 'Remove from message', exact: true }).click();
      await page.getByRole('button', { name: `Remove ${name}`, exact: true }).waitFor({ state: 'hidden' });
      await panel.getByRole('button', { name: `Preview ${name}`, exact: true }).click();
      for (const width of [900, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await panel.getByRole('region', { name: `Contents of ${name}`, exact: true }).getByText('Task output.', { exact: true }).waitFor();
      }
      await panel.getByRole('button', { name: 'Close file', exact: true }).click();
      await panel.getByRole('tab', { name: 'Chats', exact: true }).click();
    } finally { page.off('request', capture); await page.unroute(list); await page.unroute(source); }
  });
  await check('UXC 900 and 1024 panel sheet preserves chat; Escape returns focus', async () => {
    try { for (const width of [900, 1024]) {
      await page.setViewportSize({ width, height: 900 }); await open();
      const sheet = page.getByRole('dialog', { name: 'Conversation panel', exact: true }); await sheet.waitFor();
      assert(await sheet.evaluate(el => getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)'), 'Panel sheet must have an opaque surface');
      const chat = await page.locator('.chat-row > .chat').boundingBox();
      assert(chat.width >= width - 301, `Chat squeezed: ${chat.width}`);
      await page.waitForFunction(() => document.querySelector('.right-panel')?.getBoundingClientRect().right <= innerWidth + 1);
      await shot(`UX-13-after-${width}`);
      await page.keyboard.press('Escape'); await panel.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Show details');
    }
    } finally { await page.setViewportSize({ width: 1440, height: 900 }); }
    await open();
  });
  await check('UXC panel polling pauses hidden and refreshes on focus', async () => {
    await open();
    let reads = 0;
    const record = req => { if (/\/panel$/.test(new URL(req.url()).pathname)) reads++; };
    page.on('request', record);
    try {
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForTimeout(500); const before = reads;
      await page.waitForTimeout(5500); assert.equal(reads, before, 'Hidden window kept polling');
      const resumed = page.waitForRequest(req => /\/panel$/.test(new URL(req.url()).pathname));
      await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
      await resumed;
      await panel.getByRole('button', { name: 'Close details', exact: true }).click();
      await page.waitForTimeout(500); const closed = reads;
      await page.waitForTimeout(5500); assert.equal(reads, closed, 'Closed panel kept polling');
      await open(); await shot('UX-15-after');
    } finally { page.off('request', record); await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); }); }
  });
  await check('UXC Computer enable and start, recovery and server refusal', async () => {
    await open();
    const pattern = /\/api\/agents\/[^/]+\/computer(?:\/start)?$/;
    const status = { available: true, enabled: false, state: 'off', revision: 3, width: 1280, height: 800, requests: [], control: { mode: 'agent', revision: 0 } };
    const commands = []; let lose = false, refuse = false;
    await page.route(pattern, async route => {
      const req = route.request();
      if (req.method() === 'GET') return route.fulfill({ json: status });
      const body = req.postDataJSON(); commands.push({ path: new URL(req.url()).pathname, body });
      if (lose) return route.fulfill({ contentType: 'application/json', body: '{' });
      if (refuse) return route.fulfill({ status: 409, json: { error: 'Synthetic server refusal' } });
      if (!req.url().endsWith('/start')) { assert.equal(body.revision, status.revision); assert.equal(body.enabled, true); status.enabled = true; status.revision++; }
      return route.fulfill({ json: status });
    });
    try {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await panel.getByRole('tab', { name: 'Computer', exact: true }).waitFor();
      for (const label of await panel.locator('.right-panel__tab-label').all()) assert(await label.evaluate(el => el.getBoundingClientRect().width > 10));
      assert(await panel.getByRole('tablist').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Default tabs overflow');
      await shot('UX-36-after-supported');
      await panel.getByRole('tab', { name: 'Computer', exact: true }).click();
      const turnOn = panel.getByRole('button', { name: 'Turn on computer', exact: true }); await turnOn.waitFor();
      const width = await panel.boundingBox(); assert(width.width >= 280 && width.width <= 500);
      assert.equal(await page.locator('.right-panel-sheet').count(), 0);
      assert((await page.locator('.chat-row > .chat').boundingBox()).width >= 640);
      assert.equal(await panel.locator('.computer-viewer__empty p').count(), 0);
      await shot('UX-04-after');
      const started = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/computer/start'));
      await turnOn.click(); await started;
      assert.equal(commands.length, 2); assert(commands[1].path.endsWith('/start')); assert.deepEqual(commands[1].body, {});
      assert.deepEqual(Object.keys(commands[0].body).sort(), ['enabled', 'id', 'revision']);
      // Reset fixture only. Lose enable acknowledgement; no automatic start or replay.
      status.enabled = false; status.revision++; lose = true;
      await panel.getByRole('tab', { name: 'Chats', exact: true }).click(); await panel.getByRole('tab', { name: 'Computer', exact: true }).click();
      await turnOn.click(); await panel.getByRole('button', { name: 'Try again', exact: true }).waitFor();
      assert.equal(commands.length, 3); const original = commands[2];
      await shot('computer-enable-recovery');
      await page.reload(); await open();
      await panel.getByRole('button', { name: 'Try again', exact: true }).waitFor(); assert.equal(commands.length, 3);
      lose = false; await panel.getByRole('button', { name: 'Try again', exact: true }).click();
      await panel.getByRole('button', { name: 'Try again', exact: true }).waitFor({ state: 'hidden' });
      assert.deepEqual(commands[3], original); assert.equal(commands.length, 4);
      refuse = true; await turnOn.click(); await panel.getByRole('alert').filter({ hasText: 'Synthetic server refusal' }).waitFor();
      assert.equal(commands.length, 5); assert(commands[4].path.endsWith('/start'));
      await panel.getByRole('tab', { name: 'Chats', exact: true }).click();
    } finally { await page.unroute(pattern); }
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await panel.getByRole('tab', { name: 'Computer', exact: true }).waitFor({ state: 'hidden' });
  });
}
