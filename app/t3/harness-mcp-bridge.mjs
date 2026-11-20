// Minarbot HTTP session credentials stay in environment and never enter argv.
import { StringDecoder } from 'node:string_decoder';
let session, pending = '', bytes = 0, active = 0;
const decoder = new StringDecoder('utf8');
const endpoint = process.env.MINARBOT_MCP_URL, token = process.env.MINARBOT_MCP_TOKEN;
process.stdin.on('data', chunk => {
  bytes += chunk.length;
  if (bytes > 16 * 1024 * 1024) process.exit(1);
  pending += decoder.write(chunk);
  if (Buffer.byteLength(pending) > 2 * 1024 * 1024) process.exit(1);
  while (pending.includes('\n')) {
    const at = pending.indexOf('\n'), line = pending.slice(0, at); pending = pending.slice(at + 1);
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { process.exit(1); }
    if (++active > 64) process.exit(1);
    void (async () => {
      try {
        const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: line, signal: AbortSignal.timeout(120_000) });
        session = response.headers.get('mcp-session-id') ?? session;
        if (!response.ok) throw new Error('MCP unavailable.');
        if (value.id === undefined) return;
        const body = await response.text();
        if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('MCP response exceeded limit.');
        const payload = response.headers.get('content-type')?.includes('text/event-stream') ? body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(item => item.id === value.id) : JSON.parse(body);
        if (!payload || payload.id !== value.id) throw new Error('MCP response missing.');
        process.stdout.write(JSON.stringify(payload) + '\n');
      } catch { if (value.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: value.id, error: { code: -32603, message: 'Minarbot MCP request failed.' } }) + '\n'); }
      finally { active--; }
    })();
  }
});
process.stdin.on('end', () => process.exit(0));
