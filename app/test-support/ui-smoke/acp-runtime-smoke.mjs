import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function acpRuntimeSmoke({ page, check, origin, root, agentChat }) {
  const evidence = join(root, 'app/test-support/ui-smoke/artifacts/acp-harnesses');
  await mkdir(evidence, { recursive: true });
  await check('Runtime picker shows available host harnesses with icons, short labels, no hints, and keyboard selection', async () => {
    await agentChat();
    await page.route(/\/api\/agents\/[^/]+\/runtimes$/, route => route.fulfill({ json: { choices: ['codex', 'claude', 'hermes', 'grok', 'pi'].map(runtime => ({ runtime, label: { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes', grok: 'Grok', pi: 'Pi' }[runtime], available: true, enabled: true, models: [] })) } }));
    try {
      const details = page.getByRole('button', { name: 'Show details', exact: true });
      if (await details.isVisible()) await details.click();
      await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
      const profile = page.getByRole('dialog', { name: 'Agent profile', exact: true });
      await profile.getByRole('tab', { name: 'Model', exact: true }).click();
      const picker = profile.getByRole('combobox', { name: 'Run with', exact: true });
      await picker.click();
      const options = page.getByRole('option');
      await page.getByRole('option', { name: 'Hermes', exact: true }).waitFor();
      assert.deepEqual(await options.allTextContents(), ['API model', 'Codex', 'Claude Code', 'Hermes', 'Grok', 'Pi']);
      assert.equal(await page.locator('[role="option"] .k-menu__hint').count(), 0);
      assert.equal(await page.locator('[role="option"] .agent-profile__runtime-label svg').count(), 6);
      await page.screenshot({ path: join(evidence, 'runtime-picker.png'), animations: 'disabled' });
      await page.keyboard.press('Escape'); await picker.focus(); await page.keyboard.press('Enter');
      await page.getByRole('option', { name: 'API model', exact: true }).focus();
      await page.keyboard.press('Home');
      for (const label of ['Codex', 'Claude Code', 'Hermes']) {
        await page.keyboard.press('ArrowDown');
        await page.waitForFunction(label => document.activeElement?.textContent === label, label);
      }
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => [...document.querySelectorAll('[role=combobox]')].some(element => element.getAttribute('aria-label') === 'Run with' && element.textContent?.includes('Hermes')));
      assert.match(await picker.textContent(), /Hermes/);
      await profile.getByRole('button', { name: 'Cancel', exact: true }).click();
    } finally {
      const cancel = page.getByRole('dialog', { name: 'Agent profile', exact: true }).getByRole('button', { name: 'Cancel', exact: true });
      await page.keyboard.press('Escape');
      if (await cancel.isVisible()) await cancel.click();
      await page.unroute(/\/api\/agents\/[^/]+\/runtimes$/); }
  });
}
