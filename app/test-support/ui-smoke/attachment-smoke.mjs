import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function attachmentSmoke({ check, page, context, origin, agentChat, screenshot, viewport }) {
  const name = 'AT1 Attachments';
  const response = await page.request.post(origin + '/api/agents', { headers: { Origin: origin }, data: { runtime: 'api', id: randomUUID(), name, instructions: 'Synthetic attachment fixture.', model: 'smoke-primary' } });
  assert(response.ok(), await response.text());
  const agent = await response.json(), filesPath = `/api/agents/${agent.id}/files`;
  const input = page.getByRole('textbox', { name: `Message ${name}`, exact: true });
  const chips = page.locator('.composer-area .attachment');
  const details = page.getByRole('complementary', { name: 'Conversation details', exact: true });
  const image = { name: 'thumbnail-original', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') };
  async function selectAgent() {
    await page.getByRole('tab', { name: /^Agents/ }).click();
    await page.getByRole('navigation', { name: 'Choose agent', exact: true }).getByRole('button', { name: /^AT1 Attachments / }).click();
    await input.waitFor();
  }
  async function countChips(count) { await page.waitForFunction(count => document.querySelectorAll('.composer-area .attachment').length === count, count); }
  async function pick(files) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Attach conversation file', exact: true }).click();
    await (await chooser).setFiles(files);
  }
  async function paste(files, drop = false) {
    await input.evaluate((el, { files, drop }) => {
      const data = new DataTransfer();
      for (const file of files) data.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
      el.dispatchEvent(drop ? new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }) : new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, { files, drop });
  }
  async function openLibrary() {
    const show = page.getByRole('button', { name: 'Show details', exact: true }); if (await show.isVisible()) await show.click();
    await details.getByRole('tab', { name: 'Files', exact: true }).click();
  }
  async function matrix(label) {
    for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(size);
      for (const [palette, theme, textSize] of [['minarbot', 'dark', 'standard'], ['minarbot', 'light', 'standard'], ['catppuccin', 'dark', 'standard'], ['minarbot', 'dark', 'compact']]) {
        await page.evaluate(({ palette, theme, textSize }) => Object.assign(document.documentElement.dataset, { colorTheme: palette, theme, textSize }), { palette, theme, textSize });
        await screenshot(`at1-${label}-${size.width}-${palette}-${theme}-${textSize}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.equal(overflow, false, `Horizontal overflow: ${label}/${size.width}/${palette}/${theme}/${textSize}`);
        for (const img of await page.locator('.attachment__image img:visible').all()) assert(await img.evaluate(el => el.complete && el.naturalWidth > 0), 'Thumbnail failed to load');
      }
    }
    await page.setViewportSize(viewport);
    await page.evaluate(() => Object.assign(document.documentElement.dataset, { colorTheme: 'minarbot', theme: 'dark', textSize: 'standard' }));
  }
  try {
    await page.reload();
    await page.getByRole('tab', { name: /^Agents/ }).click();
    await page.getByRole('navigation', { name: 'Choose agent', exact: true }).getByRole('button', { name: /^AT1 Attachments / }).waitFor();
    await page.getByRole('navigation', { name: 'Choose agent', exact: true }).getByRole('button', { name: /^AT1 Attachments / }).click();
    await input.waitFor();
    await check('AT1 attach button uploads image without opening side panel', async () => {
      if (await details.isVisible()) await details.getByRole('button', { name: 'Close details', exact: true }).click();
      await input.fill('Attachment preview test'); await pick(image); await countChips(1);
      assert.equal(await details.isVisible(), false);
      const thumb = chips.locator('img'); await thumb.waitFor(); await page.waitForFunction(img => img.complete && img.naturalWidth > 0, await thumb.elementHandle());
      const strip = await page.locator('.composer-attachments').boundingBox(), composer = await page.locator('.composer').boundingBox();
      assert(strip.x >= composer.x && strip.x + strip.width <= composer.x + composer.width && strip.y >= composer.y, 'Attachment strip must sit inside composer');
      assert(await page.locator('.composer-attachments').evaluate(element => !!element.closest('.composer')));
      const bounds = await chips.boundingBox(); assert(bounds.width <= 240); assert(bounds.height <= 44); assert.match(await chips.innerText(), /thumbnail-original/);
      const remove = chips.getByRole('button', { name: 'Remove thumbnail-original', exact: true });
      await remove.focus(); assert.equal(await remove.evaluate(el => getComputedStyle(el).opacity), '1');
      await screenshot('at1-remove-focus');
      await remove.click(); await countChips(0); assert.equal(await input.inputValue(), 'Attachment preview test');
    });
    await check('AT1 pasted image and dropped file share removable strip', async () => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.evaluate(async () => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 24; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#7c79dd'; ctx.fillRect(0, 0, 24, 24); const blob = await new Promise(resolve => canvas.toBlob(resolve)); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); });
      await input.focus(); await input.press('Control+v'); await countChips(1);
      await paste([{ name: 'notes-long-enough-to-truncate-in-the-file-chip.txt', type: 'text/plain', bytes: [...Buffer.from('Attachment file contents')] }], true); await countChips(2);
      await chips.locator('.attachment__file svg').waitFor(); assert.equal(await chips.locator('.attachment__file svg').count(), 1);
      await chips.getByRole('button', { name: /Remove notes/ }).waitFor();
      assert.match(await chips.locator('.attachment__file .attachment__size').innerText(), /B$/);
      assert.equal(await details.isVisible(), false);
    });
    await check('AT1 multiple attachments wrap and count limit stays short', async () => {
      await pick([{ name: 'third.txt', mimeType: 'text/plain', buffer: Buffer.from('third') }, { name: 'fourth.txt', mimeType: 'text/plain', buffer: Buffer.from('fourth') }]); await countChips(4);
      await paste([{ name: 'extra.txt', type: 'text/plain', bytes: [65] }]);
      await page.getByRole('alert').filter({ hasText: 'Up to four attachments per message.' }).waitFor();
      assert.equal(await chips.count(), 4); await page.getByRole('button', { name: 'Dismiss attachment error' }).click();
      await openLibrary(); await matrix('composer-library');
      await chips.getByRole('button', { name: 'Remove third.txt' }).click(); await countChips(3);
      await chips.getByRole('button', { name: 'Remove fourth.txt' }).click(); await countChips(2);
    });
    await check('AT1 upload size violation keeps draft and existing attachments', async () => {
      await pick({ name: 'too-large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
      await page.getByRole('alert').filter({ hasText: 'Maximum file size is 10 MiB.' }).waitFor();
      assert.equal(await chips.count(), 2); assert.equal(await input.inputValue(), 'Attachment preview test');
      await page.getByRole('button', { name: 'Dismiss attachment error' }).click();
    });
    await check('AT1 upload response loss recovers original ID after reload', async () => {
      const requests = [];
      const capture = request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith(filesPath + '/')) requests.push(request.url()); };
      page.on('request', capture);
      await page.evaluate(filesPath => {
        const original = window.fetch; let lose = true;
        window.fetch = async (...args) => {
          const response = await original(...args);
          if (lose && String(args[0]).startsWith(filesPath + '/') && args[1]?.method === 'POST') { lose = false; throw new TypeError('Synthetic upload response loss'); }
          return response;
        };
      }, filesPath);
      try {
        await paste([{ name: 'recover.txt', type: 'text/plain', bytes: [65] }]);
        await page.getByRole('button', { name: 'Retry upload', exact: true }).waitFor();
        await page.reload(); await selectAgent();
        await page.getByRole('button', { name: 'Check upload status', exact: true }).click(); await countChips(3);
        assert.equal(requests.length, 1);
        assert.equal(await input.inputValue(), 'Attachment preview test');
        await chips.getByRole('button', { name: 'Remove recover.txt' }).click(); await countChips(2);
      } finally { page.off('request', capture); }
    });
    await check('AT1 sent message shows image preview and downloadable file chip', async () => {
      await input.press('Enter');
      const sent = page.getByRole('group', { name: 'Message attachments', exact: true }); await sent.waitFor();
      await countChips(0); assert.equal(await sent.locator('.attachment__image').count(), 1); assert.equal(await sent.locator('.attachment__file').count(), 1);
      const downloadEvent = page.waitForEvent('download'); await sent.locator('a.attachment__file').click();
      const download = await downloadEvent; assert.match(download.suggestedFilename(), /^notes/); await download.delete();
      await sent.getByRole('button', { name: /^Preview/ }).click(); const dialog = page.getByRole('dialog'); await dialog.waitFor();
      await dialog.locator('.attachment__preview').evaluate(el => el.decode()); assert(await dialog.locator('.attachment__preview').evaluate(el => el.complete && el.naturalWidth > 0));
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      await openLibrary(); await matrix('sent-library');
    });
    await check('AT1 one file list, row attach action and inline image preview', async () => {
      const files = details.getByRole('tabpanel', { name: 'Files', exact: true });
      assert.equal(await details.getByRole('tab', { name: 'Library', exact: true }).count(), 0);
      assert.equal(await files.getByRole('checkbox').count(), 0);
      assert.equal(await files.getByRole('button', { name: /^Preview (thumbnail-original|.*\.png)$/ }).count(), 2);
      await files.getByRole('button', { name: 'File actions: third.txt', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Attach to message', exact: true }).click(); await countChips(1);
      await chips.getByRole('button', { name: 'Remove third.txt' }).click(); await countChips(0);
      await details.locator('.right-panel__file').first().waitFor();
      await details.getByRole('button', { name: /^Preview (thumbnail-original|.*\.png)$/ }).first().click(); await details.getByRole('button', { name: 'Close file', exact: true }).waitFor();
      await details.locator('.right-panel__image').evaluate(el => el.decode()); assert(await details.locator('.right-panel__image').evaluate(el => el.complete && el.naturalWidth > 0));
      assert.equal(await page.getByText(/will be sent to the provider/).count(), 0);
    });
  } finally {
    await page.setViewportSize(viewport);
    await page.evaluate(() => Object.assign(document.documentElement.dataset, { colorTheme: 'minarbot', theme: 'dark', textSize: 'standard' }));
    await agentChat();
  }
}
