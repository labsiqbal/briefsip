// Adapted from T3 DesktopUpdates.ts and ElectronUpdater.ts; Effect removed.
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export function updateFeedUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('BRIEFSIP_UPDATE_URL must be an HTTPS directory URL without credentials, query, or fragment.');
  url.pathname = url.pathname.replace(/\/$/, '') + '/';
  return url.href;
}
export function configureUpdates({ updater, feed, enabled, prompt, log = console.warn, timers = globalThis }) {
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  if (feed) updater.setFeedURL({ provider: 'generic', url: updateFeedUrl(feed) });
  let checking = null;
  let downloaded = false;
  let prompting = false;
  const reportError = () => log('Briefsip desktop update failed. Retry from the app menu.');
  const offerRestart = async () => {
    if (prompting) return;
    prompting = true;
    try {
      if (await prompt({ title: 'Update ready', message: 'Briefsip update downloaded.', buttons: ['Restart to update', 'Later'], defaultId: 1, cancelId: 1 }) === 0) updater.quitAndInstall(false, true);
    } catch { reportError(); } finally { prompting = false; }
  };
  updater.on('error', reportError);
  const onDownloaded = () => { downloaded = true; void offerRestart(); };
  updater.on('update-downloaded', onDownloaded);
  async function check(manual = false) {
    if (!feed || !enabled) {
      if (manual) await prompt({ title: 'Updates unavailable', message: !feed ? 'No private update feed is configured for this build.' : 'Updates require a packaged AppImage.', buttons: ['OK'] });
      return;
    }
    if (downloaded) { if (manual) await offerRestart(); return; }
    try {
      checking ??= updater.checkForUpdates().finally(() => { checking = null; });
      const result = await checking;
      if (manual) await prompt({ title: 'Updates', message: result?.isUpdateAvailable ? 'Update found. Downloading in the background.' : 'Briefsip is up to date.', buttons: ['OK'] });
    } catch { if (manual) await prompt({ title: 'Update check failed', message: 'Could not reach the private update feed. Check your connection and try again.', buttons: ['OK'] }); }
  }
  let interval;
  if (feed && enabled) { void check(); interval = timers.setInterval(() => { void check(); }, UPDATE_INTERVAL_MS); }
  return { check, stop: () => { if (interval !== undefined) timers.clearInterval(interval); updater.removeListener('error', reportError); updater.removeListener('update-downloaded', onDownloaded); } };
}
