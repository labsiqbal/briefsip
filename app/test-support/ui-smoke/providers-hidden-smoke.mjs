import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function providersHiddenSmoke({ page, check, origin, root, settings, workspace, lead }) {
  const evidence = join(root, 'app/test-support/ui-smoke/artifacts/providers-hidden');
  await mkdir(evidence, { recursive: true });
  const capture = name => page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' });
  await check('PH1 Providers groups, counts, default, scroll and search', async () => {
    const models = ['ag/atlas', 'cx/default', ...Array.from({ length: 40 }, (_, i) => `cx/model-${String(i).padStart(2, '0')}`), 'gcli/gemini', 'oc/original', 'xai/grok', 'mmf/model', 'unprefixed'];
    const accountsRoute = '**/api/provider-accounts', modelsRoute = '**/api/models?account=providers-hidden-fixture';
    await page.route(accountsRoute, route => route.fulfill({ json: [{ id: 'providers-hidden-fixture', name: 'Fixture provider', host: 'fixture.invalid', configured: true, defaultModel: 'cx/default' }] }));
    await page.route(modelsRoute, route => route.fulfill({ json: { models } }));
    try {
      const panel = await settings('Providers');
      const list = panel.getByRole('region', { name: 'Models for Fixture provider', exact: true });
      await list.getByText('cx/default', { exact: true }).waitFor();
      assert.equal(await list.getByRole('listitem').count(), models.length);
      assert.equal(await list.getByRole('button').count(), 7);
      assert.match(await list.getByRole('button', { name: /^cx\// }).textContent(), /41/);
      assert.equal(await list.getByText('Default', { exact: true }).count(), 1);
      assert.equal(await list.getByText(models.join(', '), { exact: true }).count(), 0);
      assert(!(await list.textContent()).includes(', '), 'Models must not render comma-joined text');
      assert(await list.evaluate(el => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto'), 'Models must scroll inside card');
      for (const title of ['Host', 'Default model']) assert.equal(await panel.locator('.k-row').filter({ has: page.getByText(title, { exact: true }) }).count(), 1);
      const cx = list.getByRole('button', { name: /^cx\// });
      await cx.focus(); await page.keyboard.press('Enter');
      assert.equal(await cx.getAttribute('aria-expanded'), 'false');
      const search = panel.getByRole('searchbox', { name: 'Search models for Fixture provider', exact: true });
      await search.fill('CX/DEFAULT');
      assert.deepEqual(await list.getByRole('listitem').allTextContents(), ['cx/defaultDefault']);
      assert.equal(await cx.getAttribute('aria-expanded'), 'true');
      await capture('providers-search');
      await search.fill('missing-model');
      await list.getByText('No matching models', { exact: true }).waitFor();
      assert.equal(await list.getByRole('listitem').count(), 0);
      await search.fill('');
      assert.equal(await cx.getAttribute('aria-expanded'), 'true');
      for (const width of [1440, 1024]) {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 768 });
        for (const theme of ['dark', 'light']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          await list.evaluate(el => { el.scrollTop = 0; });
          assert(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Settings overflow');
          await capture(`providers-${theme}-${width}`);
        }
      }
    } finally {
      await page.unroute(accountsRoute); await page.unroute(modelsRoute);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await workspace();
    }
  });
  await check('PH1 Hide, collapsed Hidden count, row Restore and palette Restore', async () => {
    const name = 'Hidden restore fixture';
    const response = await page.request.post(origin + '/api/agents', { headers: { Origin: origin }, data: { runtime: 'api', id: randomUUID(), name, model: 'smoke-primary', instructions: 'Synthetic restore fixture.' } });
    assert.equal(response.status(), 201);
    const agent = await response.json();
    try {
      await workspace();
      await page.getByRole('tab', { name: /^Agents/ }).click();
      const row = page.getByRole('navigation', { name: 'Choose agent', exact: true }).getByRole('button', { name: `${name} Idle`, exact: true });
      await row.waitFor();
      const hide = async () => {
        await row.hover();
        await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
        await page.getByRole('menuitem', { name: 'Hide', exact: true }).click();
        await row.waitFor({ state: 'hidden' });
      };
      await hide();
      const group = page.locator('.hidden-agents'), toggle = group.getByRole('button', { name: /^Hidden/ });
      await toggle.waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await toggle.locator('.machine-group__count').textContent(), '1');
      assert(await group.evaluate(el => el === el.parentElement.lastElementChild), 'Hidden group must be last');
      await capture('hidden-collapsed');
      await toggle.focus(); await page.keyboard.press('Enter');
      const restore = group.getByRole('button', { name: `Restore ${name}`, exact: true });
      await restore.waitFor();
      await capture('hidden-expanded');
      await restore.click(); await row.waitFor(); await group.waitFor({ state: 'hidden' });
      let directory = await (await page.request.get(origin + '/api/agents')).json();
      assert.equal(directory.agents.find(item => item.id === agent.id).hidden, false);
      await hide();
      await page.keyboard.press('Control+k');
      const palette = page.getByRole('dialog', { name: 'Quick switcher', exact: true });
      await palette.getByRole('combobox', { name: 'Jump to', exact: true }).fill(`Restore ${name}`);
      await palette.getByRole('option', { name: `Restore ${name}`, exact: true }).waitFor();
      await capture('hidden-palette');
      await page.keyboard.press('Enter'); await palette.waitFor({ state: 'hidden' });
      await row.waitFor(); await group.waitFor({ state: 'hidden' });
      directory = await (await page.request.get(origin + '/api/agents')).json();
      assert.equal(directory.agents.find(item => item.id === agent.id).hidden, false);
      await page.getByRole('button', { name: new RegExp(`^${lead} `) }).first().click();
    } finally {
      const deleted = await page.request.post(origin + `/api/agents/${agent.id}/delete`, { headers: { Origin: origin }, data: { id: randomUUID() } });
      assert(deleted.ok());
      await workspace();
    }
  });
}
