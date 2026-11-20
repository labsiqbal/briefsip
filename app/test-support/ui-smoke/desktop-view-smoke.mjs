import assert from 'node:assert/strict';
import { desktopImage, installVncFixture, preloadVncFixture } from './computer-smoke.mjs';

export async function desktopViewSmoke({ check, context, page, lead, visible, hidden, screenshot, viewport }) {
  await check('Desktop only in panel and pop-out; old browser preference ignored', async () => {
    const status = { available: true, enabled: true, state: 'running', revision: 1, width: 1280, height: 800, stopsInMs: 900000, requests: [], control: { mode: 'agent', who: 'fixture', since: new Date().toISOString(), revision: 0 } };
    const pattern = /\/api\/agents\/[^/]+\/computer(?:\/[^?]+)?(?:\?.*)?$/;
    const image = await desktopImage;
    const browserRequests = [];
    const record = request => { if (/\/api\/agents\/[^/]+\/browser(?:\/|$)/.test(new URL(request.url()).pathname)) browserRequests.push(request.url()); };
    context.on('request', record);
    await context.route(pattern, route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/screenshot')) return route.fulfill({ contentType: 'image/png', body: image });
      return route.fulfill({ json: path.endsWith('/vnc-ticket') ? { ticket: 'smoke-single-use' } : status });
    });
    await installVncFixture(page, `data:image/png;base64,${image.toString('base64')}`);
    const details = page.getByRole('complementary', { name: 'Conversation details', exact: true });
    const computerTab = details.getByRole('tab', { name: 'Computer', exact: true });
    let popup;
    try {
      // Seed obsolete choices for every fixture agent. Saved choice cannot restore browser mode.
      await page.evaluate(async () => { const { agents } = await (await fetch('/api/agents')).json(); for (const agent of agents) localStorage.setItem(`minarbot:computer-view:${agent.id}`, '"browser"'); });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await computerTab.click();
      const embedded = details.locator('.computer-viewer'); await visible(embedded.locator('canvas'));
      const assertDesktop = async scope => {
        await visible(scope.locator('canvas'));
        assert.equal(await scope.locator('.agent-browser-viewer, .computer-viewer__switch, [aria-label="Browser tabs"], [aria-label="Page address"]').count(), 0);
        assert.equal(await scope.getByRole('button', { name: 'New tab', exact: true }).count(), 0);
      };
      for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
        await page.setViewportSize(size); await assertDesktop(embedded); await screenshot(`desktop-panel-${size.width}`);
      }
      await preloadVncFixture(context, `data:image/png;base64,${image.toString('base64')}`);
      const opened = context.waitForEvent('page');
      await embedded.getByRole('button', { name: 'Pop out', exact: true }).click();
      popup = await opened; await popup.waitForLoadState(); await assertDesktop(popup);
      await popup.close(); popup = null;
      await page.setViewportSize(viewport);
      await details.getByRole('tab', { name: 'Chats', exact: true }).click();
      const card = page.getByRole('region', { name: 'Computer', exact: true });
      await visible(card.locator('.computer-compact-row > svg')); assert.equal(await card.locator('img').count(), 0); await visible(card.getByText('Computer', { exact: true }));
      await card.getByRole('button', { name: 'Open', exact: true }).click();
      await assertDesktop(details); await screenshot('desktop-from-details');
      await details.getByRole('tab', { name: 'Chats', exact: true }).click();
      assert.deepEqual(browserRequests, []);
    } finally {
      status.state = 'off';
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await hidden(details.getByAltText('Agent computer screen'));
      await popup?.close(); context.off('request', record); await context.unroute(pattern); await page.setViewportSize(viewport);
    }
  });
}
