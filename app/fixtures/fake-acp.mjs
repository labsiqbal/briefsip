#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--help')) { console.log('Commands:\n  acp Start ACP'); process.exit(0); }
if (process.argv.includes('--version')) { console.log('fake-acp 1.0.0'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const reply = (id, result) => send({ id, result });
const sessionId = 'fixture-session';
let prompt, request = 100, mode, child;
const waiting = new Map();
function update(update) { send({ method: 'session/update', params: { sessionId, update } }); }
function ask(method, params) { const id = ++request; send({ id, method, params: { sessionId, ...params } }); return new Promise(resolve => waiting.set(id, resolve)); }
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  appendFileSync('fake-acp-log.jsonl', JSON.stringify({ ...value, canary: process.env.BRIEFSIP_HARNESS_CANARY }) + '\n');
  if (value.type === 'extension_ui_response') {
    send({ type: 'tool_execution_end', toolCallId: 'pi-tool', toolName: 'bash', isError: !value.confirmed });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Pi answer.' } });
    send({ type: 'agent_end' }); continue;
  }
  if (value.type === 'prompt') {
    send({ type: 'response', id: value.id, success: true, data: {} });
    send({ type: 'message_start', message: { role: 'assistant' } });
    if (value.message === 'WAIT') { send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Waiting.' } }); continue; }
    send({ type: 'tool_execution_start', toolCallId: 'pi-tool', toolName: 'bash' });
    send({ type: 'extension_ui_request', method: 'confirm', title: 'Briefsip tool approval', id: 'pi-approval', message: JSON.stringify({ toolName: 'bash', input: { command: 'echo fixture' } }) }); continue;
  }
  if (value.type) {
    if (value.type === 'get_state') send({ type: 'response', id: value.id, success: true, data: { sessionId: 'pi-fixture' } });
    else if (value.type === 'get_available_models') send({ type: 'response', id: value.id, success: true, data: { models: [{ provider: 'fixture', id: 'model', name: 'Fixture' }] } });
    else send({ type: 'response', id: value.id, success: true, data: {} });
    continue;
  }
  if (value.method === undefined) { waiting.get(value.id)?.(value); waiting.delete(value.id); continue; }
  if (value.method === 'initialize') { reply(value.id, { protocolVersion: 1, agentInfo: { name: 'fake', version: '1' }, authMethods: [{ id: 'oauth-personal', type: 'agent' }], agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, models: { availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }] } }); continue; }
  if (['session/new', 'session/load'].includes(value.method)) {
    if (value.method === 'session/load') update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Historic text must not replay.' } });
    reply(value.id, { sessionId, modes: { availableModes: [{ id: 'default', name: 'Supervised' }] }, models: { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }] } }); continue;
  }
  if (value.method === 'session/set_mode') { mode = value.params.modeId; reply(value.id, {}); continue; }
  if (value.method === 'authenticate') { reply(value.id, {}); continue; }
  if (value.method === 'session/set_model') { reply(value.id, {}); continue; }
  if (value.method === 'session/cancel') { writeFileSync('cancel-received', 'yes'); if (prompt) reply(prompt, { stopReason: 'cancelled' }); continue; }
  if (value.method !== 'session/prompt') { if (value.id) send({ id: value.id, error: { code: -32601, message: 'unsupported' } }); continue; }
  prompt = value.id;
  const content = value.params.prompt[0].text;
  if (mode !== 'default') { process.exit(2); }
  void (async () => {
    if (content.includes('CRASH')) { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial before crash.' } }); setTimeout(() => process.exit(3), 100); return; }
    if (content.includes('INVALID')) { process.stdout.write('bad json\n'); return; }
    if (content.includes('TREE')) { child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }); writeFileSync('child-pid', String(child.pid)); }
    if (content.includes('WAIT') || content.includes('TREE')) { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Waiting.' } }); return; }
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Before tool. ' } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'echo fixture', kind: 'execute', status: 'pending' });
    const result = await ask('session/request_permission', { toolCall: { toolCallId: 'tool-1', title: 'Run echo fixture', kind: 'execute', rawInput: { command: 'echo fixture' } }, options: [{ kind: 'allow_once', optionId: 'once' }, { kind: 'allow_always', optionId: 'persistent' }, { kind: 'reject_once', optionId: 'deny' }] });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: result.result?.outcome?.optionId === 'once' ? 'completed' : 'failed' });
    if (content.includes('FILES')) {
      const outside = await ask('fs/write_text_file', { path: '../escape.txt', content: 'escape' });
      const link = await ask('fs/read_text_file', { path: 'outside/escape.txt' });
      const inside = await ask('fs/write_text_file', { path: 'hello.txt', content: 'hello\n' });
      const read = await ask('fs/read_text_file', { path: 'hello.txt' });
      if (!outside.error || !link.error || inside.error || read.result?.content !== 'hello\n') { process.exit(4); return; }
    }
    if (content.includes('READONLY')) { const write = await ask('fs/write_text_file', { path: 'readonly.txt', content: 'no' }); if (!write.error) { process.exit(5); return; } }
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Final ' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer.' } });
    reply(prompt, { stopReason: 'end_turn' });
  })();
}
