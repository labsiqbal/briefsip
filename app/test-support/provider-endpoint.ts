export type ProviderFamily = 'openai-compatible' | 'anthropic' | 'gemini';

export function providerURL(base: string, path: string): URL {
  const url = new URL(base.replace(/\/$/, '') + path);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Invalid provider address. Use HTTPS or loopback HTTP without credentials or a query in the URL.');
  return url;
}
