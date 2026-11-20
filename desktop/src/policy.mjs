// Adapted from T3 DesktopWebLinks.ts and DesktopWindow.ts. See provenance.json.
export function parseServerUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) throw new Error('Enter a valid server URL.');
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('Enter a valid server URL.'); }
  if (url.username || url.password || url.hash || url.search || !['', '/'].includes(url.pathname)) throw new Error('Use a server origin without credentials, path, query parameters, or fragment.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS, or HTTP on localhost.');
  return url;
}

export function isAllowedNavigation(input, configuredUrl) {
  try {
    const applicationUrl = parseServerUrl(configuredUrl);
    const navigationUrl = new URL(input);
    return applicationUrl.host !== '' && navigationUrl.protocol === applicationUrl.protocol && navigationUrl.host === applicationUrl.host;
  } catch { return false; }
}
export function isAllowedExternal(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === 'http:' || protocol === 'https:';
}
export function canGrantPermission(permission, requestingUrl, configuredUrl, details) {
  return details?.isMainFrame === true && ['notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission) && isAllowedNavigation(requestingUrl, configuredUrl);
}
export function canNotify(permission, requestingUrl, configuredUrl) {
  return permission === 'notifications' && isAllowedNavigation(requestingUrl, configuredUrl);
}
export function trustedSender(event, contents, configuredUrl, localUrl) {
  const frame = event.senderFrame;
  if (!frame || event.sender !== contents || frame !== contents.mainFrame) return false;
  return frame.url === localUrl || frame.url.startsWith(`${localUrl}?`) ||
    isAllowedNavigation(frame.url, configuredUrl) && frame.origin === new URL(configuredUrl).origin;
}

async function responseText(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > 512 * 1024) throw new Error('Server identity response exceeds 512 KiB.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function validateServer(input, fetchImpl = globalThis.fetch) {
  const url = parseServerUrl(input);
  const request = async (pathname) => {
    const response = await fetchImpl(new URL(pathname, url).href, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if (response.status >= 300 && response.status < 400) throw new Error('Server redirected. Enter its final HTTPS origin.');
    return response;
  };
  const environment = await request('/api/environment');
  if (environment.ok) {
    const data = JSON.parse(await responseText(environment));
    if (!data || typeof data !== 'object' || !('id' in data || 'environmentId' in data || 'environment' in data)) throw new Error('Environment endpoint did not identify a Minarbot server.');
  } else if (environment.status === 404) {
    await environment.body?.cancel();
    const root = await request('/');
    if (!root.ok || !/text\/html/i.test(root.headers.get('content-type') ?? '') || !/<title>\s*Minarbot\s*<\/title>/i.test(await responseText(root))) throw new Error('URL did not return the Minarbot app.');
  } else throw new Error(`Environment endpoint returned HTTP ${environment.status}. Check server access.`);
  return url.href;
}
