import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { runRustConnector } from '../rust-connectors-runner.ts';

export type Platform = 'slack' | 'telegram';
const telegramToken = '123:' + 'x'.repeat(24);
const botToken = 'xoxb-' + 'b'.repeat(24);
const appToken = 'xapp-' + 'a'.repeat(24);
type Request = (method: string, raw: Buffer, req: IncomingMessage, res: ServerResponse) => unknown;
type ProxyFault = { method?: string; path: RegExp; after: boolean };

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function close(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  return new Promise<void>(resolve => server.close(() => resolve()));
}

export async function waitFor<T>(read: () => T | Promise<T>, description: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 12000;
  for (;;) {
    const value = await read();
    if (value) return value;
    assert(Date.now() < deadline, description);
    await pause(20);
  }
}

export function slackEnvelope(n: number, text: string, user = 'UUSER', root?: string, channel = 'DCHAT') {
  return {
    type: 'events_api', envelope_id: `envelope-${n}`,
    payload: {
      type: 'event_callback', team_id: 'TTEAM', api_app_id: 'AAPP', event_id: `Ev${n}`,
      authorizations: [{ team_id: 'TTEAM', user_id: 'UBOT', is_bot: true }],
      event: {
        type: 'message', channel_type: channel.startsWith('D') ? 'im' : 'channel',
        channel, user, text, ts: `1700000000.${String(n).padStart(6, '0')}`,
        ...(root ? { thread_ts: root } : {}),
      },
    },
  };
}

export function telegramUpdate(n: number, text: string, chat = 4) {
  return { update_id: n, message: { message_id: n, chat: { id: chat, type: 'private' }, from: { id: chat, is_bot: false }, text } };
}

export async function rustConnectorFixture(platform: Platform, root: string, agent: string,
  appOrigin: string, scriptToken: string, remote?: Request, channels: string[] = [],
  users: (number | string)[] = platform === 'slack' ? ['UUSER', 'UOTHER'] : [4, 5]) {
  const directory = join(root, 'state');
  const scriptDirectory = join(root, 'connector-scripts');
  mkdirSync(scriptDirectory, { mode: 0o700 });
  const requests: { method: string; path: string; bytes: Buffer; name?: string }[] = [];
  const successful: typeof requests = [];
  const faults: ProxyFault[] = [];
  const updates: { update_id: number }[] = [];
  const acks: string[] = [];
  const polls: number[] = [];
  const posts: { method: string; raw: Buffer }[] = [];
  let socket: WebSocket | undefined;
  let fixtureError: unknown;
  let offset = 0;
  const local = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const path = req.url!;
      const headerName = req.headers['x-file-name'];
      const request = { method: req.method!, path, bytes, name: typeof headerName === 'string' ? headerName : undefined };
      requests.push(request);
      const index = faults.findIndex(f => (!f.method || f.method === req.method) && f.path.test(path));
      const [fault] = index < 0 ? [] : faults.splice(index, 1);
      if (fault && !fault.after) { req.socket.destroy(); return; }
      assert.equal(req.headers.authorization, `Bearer ${scriptToken}`);
      const headers = { Authorization: req.headers.authorization, 'Content-Type': req.headers['content-type']! };
      const name = req.headers['x-file-name'];
      if (typeof name === 'string') Object.assign(headers, { 'X-File-Name': name });
      const result = await fetch(appOrigin + path, {
        method: req.method, headers, body: req.method === 'POST' ? new Uint8Array(bytes) : undefined,
      });
      const data = Buffer.from(await result.arrayBuffer());
      if (result.ok) successful.push(request);
      if (fault) { req.socket.destroy(); return; }
      res.writeHead(result.status, { 'Content-Type': result.headers.get('content-type') ?? 'application/octet-stream' });
      res.end(data);
    } catch (error) { fixtureError = error; res.destroy(); }
  });
  const api = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const path = req.url!;
      const method = path.split('/').at(-1)!;
      let value: unknown;
      if (method === 'auth.test') value = { team_id: 'TTEAM', user_id: 'UBOT', bot_id: 'BBOT' };
      else if (method === 'apps.connections.open') value = { url: origin.replace('http:', 'ws:') + '/socket' };
      else if (method === 'getMe') value = { id: 123, is_bot: true };
      else if (method === 'getUpdates') {
        const poll = JSON.parse(raw.toString());
        assert.deepEqual(poll.allowed_updates, ['message', 'callback_query']);
        offset = poll.offset;
        polls.push(offset);
        value = updates.filter(update => update.update_id >= offset).slice(0, 20);
      } else {
        const body = req.headers['content-type']?.startsWith('application/json') ? JSON.parse(raw.toString()) : undefined;
        posts.push({ method, raw });
        value = await remote?.(method, raw, req, res);
        if (res.writableEnded || res.destroyed || req.socket.destroyed) return;
        value ??= platform === 'slack'
          ? { channel: body?.channel, ts: `1700000001.${String(posts.length).padStart(6, '0')}` }
          : method === 'answerCallbackQuery' ? true : { chat: { id: body?.chat_id ?? 4 }, message_id: 100 + posts.length };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(platform === 'slack' ? { ok: true, ...value as object } : { ok: true, result: value }));
    } catch (error) { fixtureError = error; res.destroy(); }
  });
  const sockets = new WebSocketServer({ server: api });
  sockets.on('connection', connection => {
    socket = connection;
    connection.on('message', raw => acks.push(JSON.parse(raw.toString()).envelope_id));
    connection.send(JSON.stringify({ type: 'hello', connection_info: { app_id: 'AAPP' } }));
  });
  const origin = await listen(api);
  const url = await listen(local);
  writeFileSync(join(scriptDirectory, 'connection.json'), JSON.stringify({ url, token: scriptToken }), { mode: 0o600 });
  let controller: AbortController | undefined;
  let settled: Promise<{ error?: unknown }> | undefined;
  let stopped: { error?: unknown } | undefined;
  function start() {
    assert(!controller);
    controller = new AbortController();
    stopped = undefined;
    settled = runRustConnector(platform, {
      directory, scriptDirectory, agent, origin, channels,
      ...(platform === 'slack'
        ? { team: 'TTEAM', app: 'AAPP', botToken, appToken, users }
        : { token: telegramToken, users }),
    }, controller.signal).then(() => stopped = {}, error => stopped = { error });
  }
  async function stop() {
    controller?.abort();
    const result = await settled;
    controller = undefined;
    socket = undefined;
    if (fixtureError) throw fixtureError;
    return result;
  }
  const check = () => {
    if (fixtureError) throw fixtureError;
    if (stopped) throw stopped.error ?? new Error('Connector stopped');
  };
  async function push<T extends { envelope_id: string } | { update_id: number }>(message: T) {
    if ('envelope_id' in message) {
      await waitFor(() => { check(); return socket?.readyState === WebSocket.OPEN; }, 'Slack socket never opened');
      socket!.send(JSON.stringify(message));
    } else {
      updates.push(message);
    }
  }
  return {
    directory, origin, requests, successful, posts, acks, polls, faults, start, stop,
    jsonPosts<T>(method: string): T[] {
      return posts.filter(post => post.method === method).map(post => JSON.parse(post.raw.toString()));
    },
    async expectedFailure(message: RegExp) {
      const result = await waitFor(() => stopped, 'Connector did not stop after injected failure');
      await stop();
      assert.match(String(result.error), message);
    },
    push,
    get offset() { return offset; },
    async send<T extends { envelope_id: string } | { update_id: number }>(message: T) {
      if ('update_id' in message) {
        await push(message);
        let db: DatabaseSync | undefined;
        try {
          await waitFor(() => {
            try {
              db ??= new DatabaseSync(join(directory,'telegram.sqlite'), { readOnly: true, timeout: 5000 });
              const row = db.prepare('SELECT offset FROM telegram_binding WHERE id=1').get();
              if (Number(row?.offset) > message.update_id) return true;
            } catch (error) {
              if (!(error instanceof Error) || !/unable to open|no such table|database is locked/.test(error.message)) throw error;
            }
            check();
          }, 'Telegram update was not committed');
        } finally { db?.close(); }
        return;
      }
      const received = () => acks.filter(id => id === message.envelope_id).length;
      const before = received();
      await push(message);
      await waitFor(() => { if (received() > before) return true; check(); }, 'Slack event was not acknowledged');
    },
    check,
    async close() {
      try { await stop(); } finally {
        for (const connection of sockets.clients) connection.terminate();
        sockets.close();
        await Promise.all([close(api), close(local)]);
      }
    },
  };
}

export function artifactReceiver(platform: Platform, uploads: Buffer[]): Request {
  return (method, raw, req, res) => {
    if (method === 'files.getUploadURLExternal') {
      return { file_id: 'FFILE', upload_url: `http://${req.headers.host}/uploadFile` };
    }
    if (method === 'uploadFile') {
      assert.equal(req.headers.authorization, undefined);
      uploads.push(raw);
      res.end('OK');
      return;
    }
    if (method === 'files.completeUploadExternal') return { files: JSON.parse(raw.toString()).files };
    if (platform === 'telegram' && method === 'sendDocument') {
      const boundary = req.headers['content-type']?.match(/boundary=(.+)$/)?.[1];
      assert(boundary);
      const fields = raw.toString('latin1').split(`--${boundary}`);
      const document = fields.find(field => field.includes('name="document"'));
      assert(document);
      uploads.push(Buffer.from(document.slice(document.indexOf('\r\n\r\n') + 4, -2), 'latin1'));
      const chat = fields.find(field => field.includes('name="chat_id"'));
      assert(chat);
      return { chat: { id: Number(chat.split('\r\n\r\n')[1].trim()) }, message_id: 1000 + uploads.length };
    }
  };
}

export async function connectorApp(
  platform: Platform, root: string, agent: string,
  options: { baseURL?: string; channels?: string[]; users?: (number | string)[]; remote?: Request } = {},
) {
  const { startApp } = await import('../test-bridge.ts');
  const token = 'fixture-connector-app-token-01234567890';
  const app = await startApp({ database: join(root, 'app.sqlite'), scriptToken: token, baseURL: options.baseURL });
  async function ui(path: string, body?: unknown) {
    const response = await fetch(app.origin + path, {
      method: body === undefined ? 'GET' : 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert(response.ok, JSON.stringify(value));
    return value;
  }
  try {
    await ui('/api/agents', { runtime: 'api', id: agent, name: 'Connector', model: 'fixture', instructions: 'Help' });
    await ui(`/api/agents/${agent}/scripts`, { id: crypto.randomUUID(), revision: 0, enabled: true });
    const connector = await rustConnectorFixture(platform, root, agent, app.origin, token, options.remote, options.channels, options.users);
    return { connector, app, ui, async close() { try { await connector.close(); } finally { await app.close(); } } };
  } catch (error) {
    await app.close();
    throw error;
  }
}
