#!/usr/bin/env node
// Fake native peer. No model calls, no host configuration reads.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
if (process.argv.includes('--version')) { console.log('fake-harness 1.0.0'); process.exit(0); }
for (const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','COMPOSIO_API_KEY','BRIEFSIP_SCRIPT_TOKEN','NODE_OPTIONS','BRIEFSIP_HARNESS_CANARY']) assert.equal(process.env[key], undefined, `${key} leaked`);
const codex = process.argv.includes('app-server');
const arg = flag => { const at = process.argv.indexOf(flag); return at >= 0 ? process.argv[at + 1] : process.argv.find(value => value.startsWith(flag + '='))?.slice(flag.length + 1); };
const log = value => appendFileSync('fake-log.jsonl', JSON.stringify(value) + '\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const hasResume = process.argv.some(value => value === '--resume' || value.startsWith('--resume='));
let session = codex ? 'fake-codex-session' : (hasResume ? (arg('--resume') ?? process.argv.find(value => value.startsWith('--resume='))?.slice(9)) : undefined) ?? arg('--session-id') ?? randomUUID(), prompt = '', callback = '', approvalId = '';
const notify = (method, params) => send({ method, params: { threadId: session, ...params } });
function delta(text) { if (codex) notify('item/agentMessage/delta', { delta: text }); else send({ type: 'stream_event', session_id: session, uuid: randomUUID(), parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }); }
function finish(allowed = true) {
  if (codex) {
    notify('item/completed', { item: { id: 'shell', type: 'commandExecution', command: 'echo hello', status: allowed ? 'completed' : 'declined' } });
    delta(allowed ? 'finished' : 'denied');
    notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 11, outputTokens: 7 } } });
    notify('turn/completed', { turn: { id: 'fake-turn', status: 'completed' } });
  } else {
    send({ type: 'assistant', uuid: randomUUID(), session_id: session, parent_tool_use_id: null, message: { id: 'm1', role: 'assistant', type: 'message', content: [{ type: 'tool_use', id: 'shell', name: 'Bash', input: { command: 'echo hello' } }], model: 'fake', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 11, output_tokens: 7 } } });
    send({ type: 'user', uuid: randomUUID(), session_id: session, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shell', content: 'fake result', is_error: !allowed }] } });
    delta(allowed ? 'finished' : 'denied');
    send({ type: 'result', subtype: 'success', is_error: false, result: 'fake result', session_id: session, uuid: randomUUID(), duration_ms: 5, duration_api_ms: 5, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, permission_denials: [] });
  }
}
function run(text) {
  prompt = text; log({ type: 'turn', session, prompt }); delta('Harness ');
  if (text.includes('CRASH')) { setTimeout(() => process.exit(19), 20); return; }
  if (text.includes('OVERSIZE')) { process.stdout.write('x'.repeat(1024 * 1024 + 1)); return; }
  if (text.includes('HOLD')) {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); log({ type: 'descendant', pid: child.pid }); return;
  }
  if (codex) {
    notify('item/started', { item: { id: 'shell', type: 'commandExecution', command: 'echo hello' } });
    if (text.includes('NETWORK') || text.includes('OUTSIDE_FILE') || text.includes('READ_ONLY_WRITE')) {
      approvalId = 'approval-native'; send({id:approvalId,method:text.includes('NETWORK') ? 'item/permissions/requestApproval' : 'item/fileChange/requestApproval',params:{threadId:session,turnId:'fake-turn',itemId:'shell',reason:'Allow requested access?',...(text.includes('NETWORK') ? {permissions:{network:{enabled:true}}} : {grantRoot:text.includes('OUTSIDE_FILE') ? '/outside' : process.cwd()})}}); return;
    }
    if (text.includes('APPROVE')) { approvalId = 'approval-native'; send({ id: approvalId, method: 'item/commandExecution/requestApproval', params: { threadId: session, turnId: 'fake-turn', itemId: 'shell', command: text.includes('APPROVE_SECRET') ? 'echo test-mcp-session-token' : 'echo hello', reason: 'Run command outside sandbox?', cwd: process.cwd() } }); return; }
  } else if (text.includes('OUTSIDE_FILE') || text.includes('NETWORK') || text.includes('WORKSPACE_WRITE') || text.includes('READ_ONLY_WRITE') || text.includes('APPROVE')) {
    approvalId = 'approval-native'; send({ type: 'control_request', request_id: approvalId, request: { subtype: 'hook_callback', callback_id: callback, input: { session_id: session, transcript_path: '', cwd: process.cwd(), hook_event_name: 'PreToolUse', tool_name: text.includes('NETWORK') ? 'WebFetch' : /OUTSIDE_FILE|WORKSPACE_WRITE|READ_ONLY_WRITE/.test(text) ? 'Write' : 'Bash', tool_input: text.includes('NETWORK') ? {url:'https://example.invalid/'} : /OUTSIDE_FILE|WORKSPACE_WRITE|READ_ONLY_WRITE/.test(text) ? {file_path:text.includes('OUTSIDE_FILE') ? '/outside/hello.txt' : process.cwd()+'/hello.txt',content:'hello'} : { command: text.includes('APPROVE_SECRET') ? 'echo test-mcp-session-token' : 'echo hello' }, tool_use_id: 'shell' } } }); return;
  }
  setTimeout(() => finish(), 100);
}
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  if (codex) {
    log({ method: value.method ?? 'response' });
    if (value.method === 'initialize') send({ id: value.id, result: { userAgent: 'fake' } });
    if (['thread/start','thread/resume'].includes(value.method)) {
      assert.equal(value.params.cwd, process.cwd()); assert.match(value.params.config.mcp_servers.briefsip.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      assert.match(value.params.config.mcp_servers.briefsip.http_headers.Authorization, /^Bearer /);
      session = value.params.threadId ?? session; send({ id: value.id, result: { thread: { id: session } } });
    }
    if (value.method === 'turn/start') { assert.equal(value.params.threadId, session); assert.equal(value.params.sandboxPolicy.networkAccess ?? false, false); send({ id: value.id, result: { turn: { id: 'fake-turn', status: 'inProgress' } } }); notify('turn/started', { turn: { id: 'fake-turn' } }); run(value.params.input[0].text); }
    if (value.id === approvalId && value.result) { log({ decision: value.result.decision }); finish(value.result.decision === 'accept' || !!value.result.permissions?.network); }
    if (value.method === 'turn/interrupt') { log({ interrupted: true }); send({ id: value.id, result: {} }); }
  } else {
    if (value.type === 'control_request') {
      const request = value.request;
      if (request.subtype === 'initialize') {
        callback = request.hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0] ?? '';
        log({ type: 'init', resume: hasResume, callback: !!callback });
        const config = JSON.parse(arg('--mcp-config')); assert.match(config.mcpServers.briefsip.headers.Authorization, /^Bearer /);
        send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: { commands: [], models: [], account: {}, hook_on_failure_supported: true, hooks_applied: true } } });
        send({ type: 'system', subtype: 'init', session_id: session, uuid: randomUUID(), cwd: process.cwd(), tools: [], mcp_servers: [], model: 'fake', permissionMode: 'default', apiKeySource: 'none', slash_commands: [] });
      } else if (request.subtype === 'interrupt') { log({ interrupted: true }); send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: {} } }); }
      else send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: {} } });
    }
    if (value.type === 'user') run(typeof value.message.content === 'string' ? value.message.content : value.message.content.map(block => block.text ?? '').join('\n'));
    if (value.type === 'control_response' && value.response.request_id === approvalId) { const decision = value.response.response?.hookSpecificOutput?.permissionDecision; log({ decision }); finish(decision === 'allow'); }
  }
}
