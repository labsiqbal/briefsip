import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

export async function connectorsTestBridge(options: { composio?: { baseURL?: string } }) {
  if (!options.composio?.baseURL) return { config: undefined, close: async () => {} };
  const url = new URL(options.composio.baseURL);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) throw new Error('Composio test endpoint must be loopback HTTP.');
  const token = randomBytes(32).toString('hex');
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}` || request.url !== '/composio-key') { response.writeHead(403); response.end(); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ key: process.env.COMPOSIO_API_KEY ?? '' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Connector fixture bridge did not bind.');
  return { config: { origin: `http://127.0.0.1:${address.port}`, token }, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
