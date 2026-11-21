import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const fixture = `<!doctype html>
<html lang="en" data-theme="dark" data-color-theme="minarbot">
<div id="root"></div>
<script type="module">
  import { createElement } from 'react';
  import { createRoot } from 'react-dom/client';
  import { AgentForm } from '/src/AgentProfileDialog.tsx';
  import { FirstRun } from '/src/FirstRun.tsx';
  import '/src/ui/tokens.css';
  import '/src/ui/base.css';
  import '/src/ui/kit.css';
  import '@fontsource-variable/inter';

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
  let setup = 0;
  window.mountFirstRun = ({ choices, accounts = [], logins = [], pending }) => {
    window.created = null;
    window.catalogPath = null;
    window.savedAccount = null;
    if (pending) sessionStorage.setItem('minarbot-agent-creation', JSON.stringify(pending));
    else sessionStorage.removeItem('minarbot-agent-creation');
    async function request(path, body) {
      if (path === '/api/runtimes') return { choices };
      if (path === '/api/engine-logins') return logins;
      if (path === '/api/provider-accounts/test') return { models: ['tested-model'] };
      if (path === '/api/provider-accounts') {
        if (!body) return accounts;
        window.savedAccount = body.id;
        return { ...body, configured: true, source: 'settings', revision: 0 };
      }
      if (path === '/api/agents') {
        window.created = body;
        return body;
      }
      if (!path.startsWith('/api/models?')) throw new Error('Unexpected request: ' + path);
      window.catalogPath = path;
      const runtime = new URL(path, location.origin).searchParams.get('runtime');
      const id = runtime + '-preferred';
      return { models: [runtime + '-other', id], catalog: [{ id, label: runtime + ' preferred', default: true }] };
    }
    root.render(createElement(FirstRun, {
      key: ++setup, request, isClientError: () => false, settingsOpen: false,
      onOpenEngines: () => {}, onCreated: () => {},
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

  const runtime = (runtime, label, extra = {}) => ({ runtime, label, available: true, enabled: true, signedIn: true, models: [], ...extra });
  const codex = runtime('codex', 'Codex');
  const claude = runtime('claude', 'Claude Code');
  const signedOutCodex = { ...codex, signedIn: false };
  const hermes = runtime('hermes', 'Hermes', { models: [{ id: 'host-model', label: 'Host model' }] });
  const login = { runtime: 'codex', id: 'fixture-login', name: 'Work login', signedIn: true };
  const api = { id: 'fixture-api', name: 'Work API', configured: true, defaultModel: 'saved-api-model', provider: 'anthropic' };
  const openai = { ...api, id: 'fixture-openai', name: 'Work OpenAI', provider: 'openai-compatible' };
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  const modelInput = page.getByLabel('Model', { exact: true });
  const picker = page.getByRole('combobox', { name: 'Run with', exact: true });
  const status = page.locator('.first-run__status');
  const mountFirstRun = fixture => page.evaluate(fixture => window.mountFirstRun(fixture), fixture);
  const expectModel = async (runtime, account, display = runtime + '-preferred') => {
    if (runtime !== 'hermes') {
      await page.waitForFunction(path => window.catalogPath === path, `/api/models?runtime=${runtime}&account=${encodeURIComponent(account)}`);
    }
    await page.waitForFunction(value => document.querySelector('input[name="model"]')?.value === value, display);
  };
  const creation = (id, runtime, providerAccount, model) => ({
    id, providerAccount, name: 'Fixture agent', role: '', model, backupModel: '',
    instructions: 'Help the user complete their tasks.', threadLimit: 2, toolBudget: 90, runtime,
  });
  const created = async (button = 'Create agent') => {
    await page.getByRole('button', { name: button, exact: true }).click();
    return await page.evaluate(() => window.created);
  };
  const expectCreation = async (runtime, account, model) => {
    const result = await created();
    assert.match(result.id, /^[a-f0-9-]{36}$/);
    assert.equal(JSON.stringify(result), JSON.stringify(creation(result.id, runtime, account, model)));
  };

  for (const [fixture, runtime, account, model] of [
    [{ choices: [claude, codex, hermes], accounts: [api], logins: [login] }, 'codex', 'device', 'default'],
    [{ choices: [signedOutCodex, claude, hermes], accounts: [api], logins: [login] }, 'claude', 'device', 'default'],
    [{ choices: [signedOutCodex, hermes], logins: [login] }, 'codex', 'login:fixture-login', 'default'],
    [{ choices: [hermes] }, 'hermes', '', 'host-model'],
    [{ choices: [signedOutCodex, hermes], accounts: [api, openai], logins: [login] }, 'codex', openai.id, 'codex-preferred'],
    [{ choices: [hermes], accounts: [openai] }, 'api', openai.id, 'api-preferred'],
  ]) {
    await mountFirstRun(fixture);
    await expectModel(runtime, account, runtime === 'hermes' ? model : undefined);
    await name.fill('Fixture agent');
    await expectCreation(runtime, account, model);
  }
  for (const [choices, runtime] of [[[codex, claude], 'codex'], [[claude], 'api']]) {
    await mountFirstRun({ choices });
    await page.getByRole('button', { name: 'Use an API key', exact: true }).click();
    await name.fill('Saved provider');
    await page.getByLabel('API key', { exact: true }).fill('fixture-key');
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const id = await page.evaluate(() => window.savedAccount);
    await expectModel(runtime, id);
    await name.fill('Fixture agent');
    await expectCreation(runtime, id, runtime + '-preferred');
  }
  console.log('First-run default payloads match: device Codex, device Claude, login, host, configured and newly saved providers.');

  await mountFirstRun({ choices: [codex] });
  await expectModel('codex', 'device');
  assert.equal(await picker.count(), 0);
  assert.equal(await page.locator('.first-run__form .k-field__hint').textContent(), 'Codex');

  const three = { choices: [codex, claude], accounts: [api] };
  await mountFirstRun(three);
  await expectModel('codex', 'device');
  await name.fill('Fixture agent');
  assert.equal(await status.textContent(), 'Codex');
  assert.equal(await modelInput.getAttribute('aria-describedby'), null);
  assert.equal(await picker.textContent(), 'Codex');
  await picker.click();
  const options = page.getByRole('option');
  await page.getByRole('option', { name: 'Claude Code', exact: true }).waitFor();
  assert.deepEqual(await options.allTextContents(), ['Codex', 'Claude Code', 'Work API']);
  assert.equal(await page.locator('[role="option"] .agent-profile__runtime-label svg').count(), 3);
  const optionFonts = await page.locator('[role="option"] .agent-profile__runtime-label').evaluateAll(items => items.map(item => getComputedStyle(item).fontFamily));
  assert(optionFonts.every(font => !font.includes('monospace')));
  if (process.env.FIRST_RUN_SCREENSHOT) {
    await page.screenshot({ path: process.env.FIRST_RUN_SCREENSHOT, animations: 'disabled' });
  }
  await page.keyboard.press('Escape');
  await modelInput.fill('codex-override');
  await picker.press('Enter');
  const focusedOption = label => page.waitForFunction(label =>
    document.activeElement?.getAttribute('role') === 'option' && document.activeElement.textContent === label, label);
  await focusedOption('Codex');
  await page.keyboard.press('ArrowDown');
  await focusedOption('Claude Code');
  await page.keyboard.press('Enter');
  await expectModel('claude', 'device');
  assert.equal(await status.textContent(), 'Claude Code');
  assert.equal(await name.inputValue(), 'Fixture agent');
  await expectCreation('claude', 'device', 'default');

  await mountFirstRun(three);
  await expectModel('codex', 'device');
  await name.fill('Fixture agent');
  await picker.click();
  await page.getByRole('option', { name: api.name, exact: true }).click();
  await expectModel('api', api.id);
  assert.equal(await status.textContent(), api.name);
  assert.equal(await name.inputValue(), 'Fixture agent');
  await expectCreation('api', api.id, 'api-preferred');

  await mountFirstRun({
    choices: [codex, claude, hermes, runtime('grok', 'Grok', { enabled: false })],
    accounts: [api, { ...openai, configured: false }],
    logins: [{ ...login, name: api.name }, { ...login, id: 'signed-out', signedIn: false }],
  });
  await expectModel('codex', 'device');
  await picker.click();
  await page.getByRole('option', { name: 'Hermes', exact: true }).waitFor();
  assert.deepEqual(await options.allTextContents(), ['Codex', 'Claude Code', 'Work API (Codex)', 'Work API', 'Hermes']);
  await page.keyboard.press('Escape');

  const pending = creation('9b3d8d00-a5cf-45d6-9130-2b883971cdb1', 'claude', 'device', 'recovered-model');
  await mountFirstRun({ ...three, pending });
  await expectModel('claude', 'device', pending.model);
  assert.equal(await picker.textContent(), 'Claude Code');
  assert(await picker.isDisabled());
  assert.equal(await status.textContent(), 'Claude Code');
  assert.equal(JSON.stringify(await created('Retry creation')), JSON.stringify(pending));
  console.log('First-run connection smoke passed: three icon options, keyboard selection, catalog reloads, name preserved, one-connection hint, and exact recovery retry.');
} finally {
  await browser?.close();
  await server.close();
}
