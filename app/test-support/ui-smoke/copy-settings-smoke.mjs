import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function copySettingsSmoke({ check, page, origin, root, openNew, settings, workspace, agentChat }) {
  const evidence = join(root, 'app/test-support/ui-smoke/artifacts/ux-copy-settings/after');
  await mkdir(evidence, { recursive: true });
  const shot = name => page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' });
  await check('UXD: name-only agent, inline errors, hidden selection and restore', async () => {
    await workspace();
    const dialog = await openNew('New agent');
    await dialog.getByRole('button', { name: 'Create agent', exact: true }).click();
    await dialog.getByText('Required.', { exact: true }).waitFor();
    assert.equal(await dialog.locator('[name=name]').getAttribute('aria-invalid'), 'true');
    assert.equal(await dialog.getAttribute('aria-describedby'), null);
    await shot('UX-17-inline-errors');
    await dialog.getByLabel('Name', { exact: true }).fill('Name only fixture');
    await shot('UX-17');
    await dialog.getByRole('button', { name: 'Create agent', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const agent = (await (await page.request.get(origin + '/api/agents')).json()).agents.find(a => a.name === 'Name only fixture');
    assert.equal(agent.instructions, 'Help the user complete their tasks.');
    assert.equal(await page.getByText(/The conversation is saved on this computer/).count(), 0);
    const row = page.getByRole('button', { name: /^Name only fixture Idle/ });
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide', exact: true }).click();
    await row.locator('.bot-row__preview').getByText('Hidden', { exact: true }).waitFor();
    assert.equal(await row.getAttribute('aria-current'), 'page');
    await shot('UX-18');
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.bot-row')].find(row => row.textContent.includes('Name only fixture'))?.querySelector('.bot-row__preview')?.textContent === '');
    await row.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    const profile = page.getByRole('dialog', { name: 'Agent profile', exact: true });
    assert.equal(await profile.getByRole('button', { name: 'Delete agent', exact: true }).count(), 0);
    await profile.getByRole('button', { name: 'Agent profile actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete agent', exact: true }).waitFor();
    await shot('UX-38');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await agentChat();
    await page.request.post(`${origin}/api/agents/${agent.id}/delete`, { headers: { Origin: origin }, data: { id: randomUUID() } });
    await page.reload(); await agentChat();
  });
  await check('UXD: provider status opens accounts and models', async () => {
    await workspace();
    await page.getByRole('button', { name: 'Provider configured', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Settings', exact: true });
    await panel.getByRole('heading', { name: 'Providers', exact: true }).waitFor();
    await panel.getByText('Models', { exact: true }).first().waitFor();
    const models = panel.getByRole('region', { name: /^Models for / }).first();
    await models.getByText('smoke-primary', { exact: true }).waitFor();
    await models.getByText('smoke-secondary', { exact: true }).waitFor();
    assert.equal(await panel.getByText('smoke-primary, smoke-secondary', { exact: true }).count(), 0);
    assert.equal(await panel.getByRole('button', { name: 'Back to workspace', exact: true }).count(), 0);
    await shot('UX-22'); await workspace();
  });
  await check('UXD: no launcher shows version without update offer', async () => {
    await workspace();
    const current = await (await page.request.get(origin + '/api/updates')).json();
    const pattern = origin + '/api/updates';
    await page.route(pattern, route => route.fulfill({ json: { ...current, launcherAvailable: false, available: { version: '99.0.0', created: new Date().toISOString(), notes: 'Synthetic release' } } }));
    try {
      await page.reload();
      const panel = await settings('Updates');
      await panel.getByText('Current version', { exact: true }).waitFor();
      assert.equal(await page.getByText('Update available', { exact: true }).count(), 0);
      assert.equal(await panel.getByRole('button', { name: 'Update now', exact: true }).count(), 0);
      assert.equal(await panel.getByText('Updates unavailable', { exact: true }).count(), 0);
      await shot('UX-23');
    } finally { await page.unroute(pattern); await workspace(); }
  });
  await check('UXD: empty routines has one action and no filters', async () => {
    await workspace();
    await page.getByRole('button', { name: 'Routines', exact: true }).click();
    await page.getByText('No routines yet', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'New routine', exact: true }).count(), 1);
    assert.equal(await page.locator('.routine-filters').count(), 0);
    await shot('UX-25');
    assert.equal(await page.getByRole('main').getByRole('button', { name: 'Back', exact: true }).count(), 0); await agentChat();
  });
}
