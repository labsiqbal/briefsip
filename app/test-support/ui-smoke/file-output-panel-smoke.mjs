import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function fileOutputReply(body) {
  const input = body.messages.findLast(message => message.role === 'user')?.content;
  const task = typeof input === 'string' ? input.split('\n\nAttached files')[0] : input;
  if (typeof task === 'string' && task.startsWith('NC1 URL ')) return { choices: [{ finish_reason: 'stop', message: { content: `[Report](${task.slice(8)})` } }] };
  if (!['FP1 create', 'FP1 rewrite', 'FP1 open'].includes(task)) return null;
  const results = body.messages.filter(message => message.role === 'tool');
  let call;
  if (task === 'FP1 open' && !results.length) {
    const id = JSON.parse(body.messages.find(message => message.role === 'user' && message.content.includes('Attached files (reference data)'))?.content.split('Attached files (reference data):\n')[1] ?? '[]')[0]?.id;
    call = { name: 'open_file_in_panel', arguments: JSON.stringify({ id }) };
  } else if (!results.length) call = { name: 'create_text_file', arguments: JSON.stringify({ name: 'hello.html', text: `<h1>${task === 'FP1 rewrite' ? 'Updated' : 'Hello'} panel</h1>` }) };
  else await delay(1800);
  return { choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: call ? { tool_calls: [{ id: randomUUID(), type: 'function', function: call }] } : { content: task === 'FP1 rewrite' ? 'Updated hello.html for review.' : 'Ready for review.' } }] };
}

export async function fileOutputPanelSmoke({ page, origin, root, check, gitAgent, gitName, agentChat }) {
  const output = join(root, 'app/test-support/ui-smoke/artifacts/no-chips'); await mkdir(output, { recursive: true });
  const post = async (path, data) => { const response = await page.request.post(origin + path, { headers: { Origin: origin }, data }); assert(response.ok(), await response.text()); return response.json(); };
  const agent = await post('/api/agents', {runtime: 'api',  id: randomUUID(), name: 'FP1 Files', model: 'smoke-primary', instructions: 'Synthetic files.' });
  const base = `/api/agents/${agent.id}`, details = page.getByRole('complementary', { name: 'Conversation details', exact: true });
  async function select(id) { await page.goto(`${origin}/agents/${id}`); await page.getByRole('textbox', { name: `Message ${id === agent.id ? 'FP1 Files' : gitName}`, exact: true }).waitFor(); }
  async function showFiles() {
    const show = page.getByRole('button', { name: 'Show details', exact: true }); if (await show.isVisible()) await show.click();
    await details.getByRole('tab', { name: 'Files', exact: true }).click();
    const back = details.getByRole('button', { name: /^(Close file|Back to files)$/ }).first();
    if (await back.isVisible()) await back.click();
  }
  async function shot(name) { await page.screenshot({ path: join(output, `${name}.png`), fullPage: true, animations: 'disabled' }); }
  let file;
  try {
    await select(agent.id);
    await check('NC1 reply output is an inline anchor and opens HTML in Files', async () => {
      await post(`${base}/turns`, { id: randomUUID(), text: 'FP1 create' });
      await page.waitForFunction(async base => (await (await fetch(base + '/files')).json()).length === 1, base);
      const answer = page.getByLabel('Agent reply', { exact: true }); await answer.waitFor();
      const link = answer.locator('.markdown p a', { hasText: 'hello.html' }); await link.waitFor();
      assert.equal(await page.locator('.agent-message .attachment, .agent-message [class*="chip"], .room-agent .attachment').count(), 0);
      assert.equal(await page.getByRole('group', { name: 'Agent output files', exact: true }).count(), 0);
      await link.click();
      assert.equal(await details.getByRole('tab', { name: 'Files', exact: true }).getAttribute('aria-selected'), 'true');
      await details.frameLocator('iframe').getByRole('heading', { name: 'Hello panel', exact: true }).waitFor();
      assert.equal(await page.getByText(/The view is restricted for security/).count(), 0);
      await shot('inline-link-opens-html-dark');
      await page.reload();
      await details.frameLocator('iframe').getByRole('heading', { name: 'Hello panel', exact: true }).waitFor();
      assert(new URL(page.url()).searchParams.has('result'));
      file = (await (await page.request.get(origin + base + '/files')).json())[0];
      await details.getByRole('button', { name: 'Close file', exact: true }).click();
    });
    await check('NC1 empty queue clears stale order recovery and ignores unavailable storage', async () => {
      await page.evaluate(base => sessionStorage.setItem(`briefsip-queue-order:${base}/queue`, '{}'), base);
      await page.reload(); await page.getByLabel('Agent reply', { exact: true }).waitFor();
      await page.waitForFunction(base => !sessionStorage.getItem(`briefsip-queue-order:${base}/queue`), base);
      assert.equal(await page.getByRole('region', { name: 'Queued messages', exact: true }).count(), 0);
      await page.evaluate(() => {
        const original = Storage.prototype.getItem;
        Storage.prototype.getItem = function(key) { if (key.startsWith('briefsip-queue-order:')) throw new Error('Synthetic denied storage'); return original.call(this, key); };
      });
      await details.getByRole('tab', { name: 'Chats', exact: true }).click();
      assert.equal(await page.getByRole('region', { name: 'Queued messages', exact: true }).count(), 0);
      await shot('inline-reply-no-empty-queue');
      await page.reload(); await page.getByLabel('Agent reply', { exact: true }).waitFor();
    });
    await check('NC1 URL prose opens sandboxed Preview and survives reload', async () => {
      const site = await post(`${base}/sites`, { id: randomUUID(), name: 'NC1 Report', source: '<h1>Inline URL report</h1>' });
      await post(`${base}/turns`, { id: randomUUID(), text: `NC1 URL ${origin}/sites/${site.id}` });
      const link = page.locator('.agent-message .markdown p').getByRole('link', { name: 'Report', exact: true }); await link.waitFor();
      assert.equal(await page.locator('iframe[title="URL preview"]').count(), 0);
      await link.click();
      await details.frameLocator('iframe[title="URL preview"]').getByRole('heading', { name: 'Inline URL report', exact: true }).waitFor();
      assert.equal(await details.locator('iframe[title="URL preview"]').getAttribute('sandbox'), '');
      await page.reload();
      await details.frameLocator('iframe[title="URL preview"]').getByRole('heading', { name: 'Inline URL report', exact: true }).waitFor();
      await shot('inline-url-preview');
      await details.getByRole('button', { name: 'Back to files', exact: true }).click();
    });
    await check('NC1 unavailable result targets show not found', async () => {
      const route = new URL(page.url());
      route.searchParams.set('result', JSON.stringify({ view: 'file', path: `${base}/panel/files/${randomUUID()}`, name: 'missing.html' }));
      await page.goto(route.href);
      await details.getByRole('alert').filter({ hasText: 'File not found' }).first().waitFor();
      assert.equal(await details.getByRole('alert').filter({ hasText: 'File not found' }).count(), 1);
      await shot('missing-file');
      route.searchParams.set('result', JSON.stringify({ view: 'url', path: `${origin}/sites/${randomUUID()}`, name: 'Missing report' }));
      await page.goto(route.href);
      await details.getByText('Page not found', { exact: true }).waitFor();
      await shot('missing-url');
      await details.getByRole('button', { name: 'Back to files', exact: true }).click();
    });
    await check('FP1 rewrite keeps file ID and tool opens existing file live', async () => {
      await post(`${base}/turns`, { id: randomUUID(), text: 'FP1 rewrite' });
      await page.waitForFunction(async ({ base, id }) => { const rows = await (await fetch(base + '/turns')).json(); return rows.some(row => row.text === 'FP1 rewrite' && row.status === 'done' && row.generatedFiles[0]?.id === id); }, { base, id: file.id });
      await page.getByLabel('Agent reply', { exact: true }).filter({ hasText: 'Updated' }).getByRole('link', { name: 'hello.html', exact: true }).waitFor();
      const files = await (await page.request.get(origin + base + '/files')).json(); assert.equal(files.length, 1); assert.equal(files[0].id, file.id);
      await details.getByRole('button', { name: 'Close details', exact: true }).click();
      await post(`${base}/turns`, { id: randomUUID(), text: 'FP1 open', files: [file.id] });
      await details.frameLocator('iframe').getByRole('heading', { name: 'Updated panel', exact: true }).waitFor();
      assert.equal(await details.getByRole('tab', { name: 'Files', exact: true }).getAttribute('aria-selected'), 'true');
      await shot('tool-opens-existing-file');
      await details.getByRole('button', { name: 'Close file', exact: true }).click();
      await page.waitForFunction(async base => (await (await fetch(base + '/turns')).json()).some(turn => turn.text === 'FP1 open' && turn.status === 'done'), base);
      await details.getByRole('button', { name: 'Close details', exact: true }).click();
      await page.getByRole('button', { name: 'Show details', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('briefsip:details-open')), '0');
      await page.reload(); await page.getByRole('textbox', { name: 'Message FP1 Files', exact: true }).waitFor();
      await page.getByLabel('Agent reply', { exact: true }).first().waitFor();
      assert.equal(await details.isVisible(), false);
      await showFiles();
    });
    await check('NC1 row menu downloads, confirms delete and retains muted deleted text', async () => {
      await details.getByRole('button', { name: 'File actions: hello.html', exact: true }).click();
      for (const label of ['Open', 'Download', 'Delete']) await page.getByRole('menuitem', { name: label, exact: true }).waitFor();
      const download = page.waitForEvent('download'); await page.getByRole('menuitem', { name: 'Download', exact: true }).click(); assert.equal((await download).suggestedFilename(), 'hello.html'); await (await download).delete();
      await details.getByRole('button', { name: 'File actions: hello.html', exact: true }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
      const confirm = page.getByRole('alertdialog'); await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal((await page.request.get(origin + base + '/files/' + file.id)).status(), 200);
      await details.getByRole('button', { name: 'File actions: hello.html', exact: true }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
      await confirm.getByRole('button', { name: 'Delete file', exact: true }).click();
      await details.getByRole('button', { name: 'File actions: hello.html', exact: true }).waitFor({ state: 'hidden' });
      await page.locator('.agent-message .markdown .message-muted[aria-label="hello.html (deleted)"]').first().waitFor();
      assert.equal((await page.request.get(origin + base + '/files/' + file.id)).status(), 404);
      await shot('deleted-output-placeholder');
    });
    await check('NC1 room outputs use prose anchors and remote URL links open Preview', async () => {
      const member = await post('/api/agents', {runtime: 'api',  id: randomUUID(), name: 'NC1 Room', model: 'smoke-primary', instructions: 'Synthetic only.' });
      const project = await post('/api/projects', { id: randomUUID(), name: 'NC1 Files', members: [{ agent: member.id, write: false }] });
      const room = project.sections[0].id;
      await post(`/api/channels/${room}/turns`, { id: randomUUID(), text: 'FP1 create' });
      await page.goto(`${origin}/rooms/${room}`);
      const answer = page.locator('.room-agent .message-body .markdown p').getByRole('link', { name: 'hello.html', exact: true }); await answer.waitFor();
      assert.equal(await page.locator('.room-agent .attachment, .room-agent [class*="chip"]').count(), 0);
      await answer.click();
      await details.frameLocator('iframe').getByRole('heading', { name: 'Hello panel', exact: true }).waitFor();
      await page.reload();
      await details.frameLocator('iframe').getByRole('heading', { name: 'Hello panel', exact: true }).waitFor();
      await shot('room-inline-output');
      await page.getByRole('tab', { name: /^Agents/ }).click();
      const remote = page.getByRole('button', { name: 'Remote Iris on Studio workstation', exact: true });
      if (!await remote.isVisible()) await page.locator('.machine-group__header').filter({ hasText: 'Studio workstation' }).click();
      await remote.click();
      const site = await post(`${base}/sites`, { id: randomUUID(), name: 'NC1 Remote report', source: '<h1>Remote URL report</h1>' });
      const box = page.getByRole('textbox', { name: 'Message Remote Iris on Studio workstation', exact: true });
      await box.fill(`NC1 URL ${origin}/sites/${site.id}`); await box.press('Enter');
      const link = page.locator('.remote-conversation .agent-message .markdown p').getByRole('link', { name: 'Report', exact: true }); await link.waitFor();
      assert.equal(await page.locator('.remote-conversation .agent-message .attachment, .remote-conversation .agent-message [class*="chip"]').count(), 0);
      await link.click();
      await details.frameLocator('iframe').getByRole('heading', { name: 'Remote URL report', exact: true }).waitFor();
      await page.reload();
      await details.frameLocator('iframe').getByRole('heading', { name: 'Remote URL report', exact: true }).waitFor();
      await shot('remote-inline-url');
    });
    await check('FP1 bounded list shows thumbnails and leaves workspace reachable', async () => {
      const path = `/api/agents/${gitAgent}/files`, png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
      for (let i = 0; i < 18; i++) { const response = await page.request.post(`${origin}${path}/${randomUUID()}`, { headers: { Origin: origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'image.png' }, data: png }); assert(response.ok()); }
      await select(gitAgent); await showFiles();
      const list = details.getByRole('region', { name: 'Conversation files list', exact: true }); await list.waitFor({ state: 'visible' });
      assert(await list.evaluate(el => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto' && el.clientHeight <= 320));
      await list.locator('img').first().evaluate(el => el.decode());
      assert.equal(await list.locator('img').count(), 18);
      await details.getByRole('tab', { name: 'Files', exact: true }).click();
      await list.focus();
      assert.equal(await list.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
      await shot('files-pointer-focus');
      await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      assert(await list.evaluate(el => el === document.activeElement && el.matches(':focus-visible')));
      assert.equal(await list.evaluate(el => getComputedStyle(el).outlineWidth), '2px');
      await shot('files-keyboard-focus');
      await page.keyboard.press('PageDown'); await page.waitForFunction(() => document.querySelector('.right-panel__files')?.scrollTop > 0);
      const workspace = details.getByRole('button', { name: 'Workspace', exact: true }); await workspace.scrollIntoViewIfNeeded(); await workspace.waitFor();
      for (const [width, height] of [[1440, 900], [1024, 768]]) {
        await page.setViewportSize({ width, height });
        for (const theme of ['dark', 'light']) {
          await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
          assert(await details.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
          await shot(`bounded-thumbnails-${width}-${theme}`);
        }
      }
    });
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await agentChat();
  }
}
