import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const fixture = `<!doctype html>
<div id="root"></div>
<script type="module">
  import { createElement } from 'react';
  import { createRoot } from 'react-dom/client';
  import { AgentForm } from '/src/AgentProfileDialog.tsx';
  import '/src/ui/kit.css';

  const root = createRoot(document.getElementById('root'));
  window.mount = (defaults, catalog) => {
    window.created = null;
    window.catalogPath = null;
    async function request(path, body) {
      if (path === '/api/agents') {
        window.created = body;
        return body;
      }
      window.catalogPath = path;
      if (!catalog) throw new Error('Catalog unavailable');
      return { models: catalog.map(item => item.id), catalog };
    }
    root.render(createElement(AgentForm, {
      key: JSON.stringify([defaults, catalog]),
      model: defaults.model, firstRun: defaults, request,
      isClientError: () => false, onCreated: () => {},
    }));
  };
</script>`;

const app = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({
  root: app,
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{
    name: 'model-catalog-fixture',
    configureServer(server) {
      server.middlewares.use('/model-catalog-fixture.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(await server.transformIndexHtml('/model-catalog-fixture.html', fixture));
      });
    },
  }],
});
let browser;
try {
  await server.listen(0);
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage();
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin + '/model-catalog-fixture.html');
  await page.waitForFunction(() => typeof window.mount === 'function');
  const mount = async (defaults, catalog) => {
    await page.evaluate(([defaults, catalog]) => window.mount(defaults, catalog), [defaults, catalog]);
    await page.waitForFunction(path => window.catalogPath === path,
      `/api/models?runtime=${defaults.runtime}&account=${encodeURIComponent(defaults.account)}`);
  };
  const submit = async model => {
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Fixture agent');
    await page.getByRole('button', { name: 'Create agent', exact: true }).click();
    assert.equal(await page.evaluate(() => window.created?.model), model);
  };
  const catalog = [{ id: 'second', label: 'Second model' }, { id: 'preferred', label: 'Preferred model', default: true }];
  await mount({ runtime: 'codex', account: 'device', model: 'default' }, catalog);
  const combo = page.getByRole('combobox', { name: 'Model', exact: true });
  await combo.click();
  const preferred = page.getByRole('option', { name: 'Preferred model', exact: true });
  await preferred.waitFor();
  assert.equal(await preferred.getAttribute('aria-selected'), 'true');
  assert.equal(await combo.inputValue(), 'preferred');
  await submit('default');

  await mount({ runtime: 'claude', account: 'login:fixture', model: 'default' }, catalog);
  await combo.click();
  await page.getByRole('option', { name: 'Second model', exact: true }).click();
  await submit('second');

  await mount({ runtime: 'api', account: 'custom-endpoint', model: 'old-model' }, catalog.map(({ id, label }) => ({ id, label })));
  await combo.click();
  const first = page.getByRole('option', { name: 'Second model', exact: true });
  assert.equal(await first.getAttribute('aria-selected'), 'true');
  await submit('second');

  await mount({ runtime: 'api', account: 'unavailable-endpoint', model: '' }, null);
  const input = page.getByRole('textbox', { name: 'Model', exact: true });
  assert.equal(await input.getAttribute('placeholder'), 'Enter model ID');
  assert.equal(await page.getByRole('button', { name: 'Show model suggestions' }).count(), 0);
  await input.fill('custom/model');
  await submit('custom/model');
  console.log('Model catalog smoke passed: device default, login selection, provider list, editable fallback.');
} finally {
  await browser?.close();
  await server.close();
}
