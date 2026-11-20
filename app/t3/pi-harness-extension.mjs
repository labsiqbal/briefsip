import { productEnv } from './rename-env.mjs';
// Adapted from T3 Pi permission hook and MCP injection (MIT). See provenance.json.
export default async function minarbot(pi) {
  let sequence = 0, session;
  const owned = new Set();
  const request = async (method, params, signal = AbortSignal.timeout(120_000)) => {
    const id = method.startsWith('notifications/') ? undefined : ++sequence;
    const response = await fetch(productEnv('MINARBOT_MCP_URL'), { method: 'POST', headers: { Authorization: `Bearer ${productEnv('MINARBOT_MCP_TOKEN')}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal });
    session = response.headers.get('mcp-session-id') ?? session;
    if (!response.ok) throw new Error('Minarbot MCP unavailable.');
    if (id === undefined) return {};
    const body = await response.text();
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('Minarbot MCP response exceeded limit.');
    const payload = response.headers.get('content-type')?.includes('text/event-stream') ? body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(item => item.id === id) : JSON.parse(body);
    if (!payload || payload.error || !payload.result) throw new Error('Minarbot MCP request failed.');
    return payload.result;
  };
  pi.on('tool_call', async (event, ctx) => {
    if (owned.has(event.toolName)) return;
    const approved = await ctx.ui.confirm('Minarbot tool approval', JSON.stringify({ toolName: event.toolName, input: event.input }), { signal: ctx.signal });
    if (!approved) return { block: true, reason: 'Declined in Minarbot.' };
  });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'minarbot-pi', version: '1' } });
  await request('notifications/initialized', {});
  const tools = await request('tools/list', {});
  for (const tool of tools.tools ?? []) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name)) throw new Error('Invalid Minarbot MCP tool name.');
    const name = `mcp__minarbot__${tool.name}`;
    owned.add(name);
    pi.registerTool({ name, label: tool.name, description: tool.description ?? tool.name,
      parameters: { ...tool.inputSchema, type: 'object', properties: tool.inputSchema?.properties ?? {} },
      async execute(_id, params, signal) {
        const result = await request('tools/call', { name: tool.name, arguments: params }, signal);
        return { content: result.content ?? [], details: {}, ...(result.isError ? { isError: true } : {}) };
      },
    });
  }
}
