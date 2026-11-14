import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './server.ts';
import { intentionalSilence, partialSilence, mentionedMembers } from './room-chat.ts';

// UI components are exercised in ui-smoke; native boundary tests keep the saved transcript shape exact.
test('Hermes exact silence normalization preserves prose, blanks and malformed brackets', () => {
  for (const text of ['NO_REPLY', ' no_reply ', '**NO_REPLY**', '.NO_REPLY!', '[silent]', 'no\n reply', '【静默】', '沉默。', '\u0085NO_REPLY\u0085']) assert(intentionalSilence(text), JSON.stringify(text));
  for (const text of ['', ' ', '[SILENT', 'SILENT]', '[SILENT] nothing new', 'Use NO_REPLY here', 'x'.repeat(65), '\ufeffNO_REPLY']) assert(!intentionalSilence(text), JSON.stringify(text));
  for (const text of ['NO', '[SIL', '*NO_REP*']) assert(partialSilence(text));
  assert(!partialSilence('No useful answer yet'));
});
test('room mentions use full names, longest matches, Unicode and word boundaries', () => {
  const members = [{ id: 'ann', name: 'Ann', role: '' }, { id: 'smith', name: 'Ann Smith', role: '' }, { id: 'hand', name: 'Right Hand', role: '' }, { id: 'lin', name: '林', role: '' }];
  assert.deepEqual(mentionedMembers('@Ann Smith, @right hand! @林', members), ['smith','hand','lin']);
  assert.deepEqual(mentionedMembers('mail@Ann.com @Annabelle @@Ann', members), []);
});

async function fixture(run: (f: any) => Promise<void>, concurrency = 4) {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules/.room-test-'));
  const calls: any[] = [];
  let respond = (body: any): any => 'NO_REPLY';
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push(body);
    const answer = await respond(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: typeof answer === 'string' ? 'stop' : 'tool_calls', message: typeof answer === 'string' ? { content: answer } : { tool_calls: [answer] } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const options = { database: join(dir, 'state.sqlite'), baseURL: `http://127.0.0.1:${address.port}/v1`, concurrency };
  let app = await startApp(options), closed = false;
  const stop = async () => { if (!closed) { closed = true; await app.close(); } };
  const request = async (path: string, body?: any, status?: number) => {
    const response = await fetch(app.origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert.equal(response.status, status ?? (body ? 201 : 200), JSON.stringify(value)); return value;
  };
  const members: any[] = [];
  for (const [name, role] of [['Assistant','Coordinator'],['Right Hand','Researcher'],['Reviewer','Reviewer'],['Four','Writer'],['Five','Designer'],['Six','Tester']]) members.push(await request('/api/agents', { id: randomUUID(), name, role, model: name, instructions: `Work as ${role}.` }));
  const room = async (n = 3, lead: string | null = members[0].id) => {
    const channel = await request('/api/channels', { id: randomUUID(), name: 'Team', instructions: 'Collaborate.', members: members.slice(0,n).map(member => member.id), lead });
    return `/api/channels/${channel.id}/turns`;
  };
  const wait = async (path: string, id: string, predicate = (rows: any[]) => rows.filter(row => row.room?.root === id).every(row => !['running','queued'].includes(row.status))) => {
    for (let n = 0; n < 500; n++) { const rows = await request(path); if (rows.some((row: any) => row.id === id) && predicate(rows)) return rows; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail(`Room timed out: ${JSON.stringify(await request(path))}`);
  };
  try { await run({ database: options.database, members, room, calls, request, wait, setRespond: (fn: any) => { respond = fn; }, stop, restart: async () => { await stop(); app = await startApp(options); closed = false; }, tool: (name: string, args: any) => ({ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }) }); }
  finally { await stop(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
}
const latest = (body: any) => body.messages.filter((message: any) => message.role === 'user').at(-1)?.content;

test('room fans out, records quiet agents, emits named agent mention replies and survives exact retry/restart', async () => fixture(async ({ room, members, calls, request, wait, restart, setRespond }: any) => {
  setRespond((body: any) => latest(body) === 'Plan today' ? body.model === 'Assistant' ? '@Right Hand, check the schedule.' : '**NO_REPLY**' : 'The schedule is clear.');
  const path = await room(), id = randomUUID(), command = { id, text: 'Plan today' };
  await request(path, command, 202); const rows = await wait(path, id);
  assert.equal(calls.length, 4); assert.deepEqual(calls.slice(0,3).map((body: any) => body.model).sort(), ['Assistant','Reviewer','Right Hand']);
  for (const call of calls) { const system = call.messages[0].content; for (const member of members.slice(0,3)) { assert(system.includes(member.name)); assert(system.includes(member.role)); } assert(system.includes('exactly NO_REPLY')); assert(!system.startsWith('Choose exactly')); }
  const root = rows.find((row: any) => row.id === id);
  assert.deepEqual(root.room.messages.map((item: any) => item.text), ['@Right Hand, check the schedule.', 'The schedule is clear.']);
  assert.equal(root.room.messages[1].agent, members[1].id);
  assert.equal(root.room.quiet.length, 2);
  assert(rows.filter((row: any) => row.room.silent).every((row: any) => row.reply === null));
  assert(calls.at(-1).messages[0].content.includes('"name":"Assistant"'));
  await request(path, command, 202); await restart(); await request(path, command, 202);
  assert.equal(calls.length, 4); assert.equal((await request(path)).length, 4);
  await request(path, { ...command, text: 'changed' }, 409);
}));

test('@mentions skip provider calls for unmentioned members, including lead', async () => fixture(async ({ room, members, calls, request, wait, setRespond }: any) => {
  setRespond(() => 'A relevant answer.'); const path = await room(), id = randomUUID();
  await request(path, { id, text: '@Right Hand, research this.' }, 202); const rows = await wait(path, id);
  assert.deepEqual(calls.map((body: any) => body.model), ['Right Hand']);
  assert.equal(rows.filter((row: any) => row.room.silent === 'not_mentioned').length, 2);
  assert.equal(rows.find((row: any) => row.id === id).room.messages[0].agent, members[1].id);
}));

test('optional lead breaks all-silent tie once; mention requests never fall back to unmentioned lead', async () => fixture(async ({ room, calls, request, wait, setRespond }: any) => {
  setRespond((body: any) => body.messages[0].content.includes('Nobody answered.') ? 'What outcome would help?' : '[SILENT]');
  const path = await room(), id = randomUUID(); await request(path, { id, text: 'Help me choose.' }, 202);
  const rows = await wait(path, id, (rows: any[]) => rows.length === 4 && rows.every(row => row.status === 'done'));
  assert.equal(calls.length, 4); assert.equal(calls.at(-1).model, 'Assistant');
  assert.equal(rows.find((row: any) => row.id === id).room.messages[0].text, 'What outcome would help?');
  const next = randomUUID(); await request(path, { id: next, text: '@Right Hand, decide.' }, 202); await wait(path,next); assert.equal(calls.length, 5);
}));

for (const name of ['send_message','delegate_task']) test(`room ${name} creates visible request/reply before parent answer`, async () => fixture(async ({ room, members, request, wait, setRespond, tool }: any) => {
  setRespond((body: any) => body.model !== 'Assistant' ? latest(body) === 'Check facts' ? 'Facts checked.' : 'NO_REPLY' : body.messages.some((message: any) => message.role === 'tool') ? 'Ready to proceed.' : tool(name, name === 'send_message' ? { recipients: [members[1].id], text: 'Check facts', expects_reply: true } : { agent: members[1].id, task: 'Check facts', wait: true }));
  const path = await room(), id = randomUUID(); await request(path, { id, text: '@Assistant, coordinate.' }, 202); const rows = await wait(path,id);
  const root = rows.find((row: any) => row.id === id);
  assert.deepEqual(root.room.messages.map((message: any) => message.text), ['Check facts','Facts checked.','Ready to proceed.']);
  assert.deepEqual(root.room.messages.map((message: any) => message.agent), [members[0].id,members[1].id,members[0].id]);
  assert.equal(root.agentMessages[0].thread, ''); assert.equal(root.agentMessages[0].reply, 'Facts checked.');
}));

test('room rounds stop at 3 and reserve at most 10 visible agent messages', async () => fixture(async ({ room, request, wait, setRespond }: any) => {
  let sequence = 0;
  setRespond((body: any) => `${++sequence} @${body.model === 'Assistant' ? 'Right Hand' : 'Assistant'}, continue.`);
  const path = await room(2,null), id = randomUUID(); await request(path,{ id, text:'@Assistant, start.' },202); const rows = await wait(path,id);
  assert(Math.max(...rows.map((row: any) => row.room.round)) <= 3); assert.match(rows[0].room.note,/3 agent rounds/);
  setRespond(() => `Update ${++sequence}. @Assistant @Right Hand @Reviewer @Four @Five @Six`);
  const many = await room(6,null), next = randomUUID(); await request(many,{ id:next,text:'Discuss.' },202); const capped = await wait(many,next);
  assert(capped[0].room.messages.length <= 10); assert.match(capped[0].room.note,/10 agent message/);
}));

test('per-agent loop guard stops repeated replies without an unbounded conversation', async () => fixture(async ({ room, request, wait, setRespond, calls }: any) => {
  setRespond((body: any) => `@${body.model === 'Assistant' ? 'Right Hand' : 'Assistant'}, continue.`);
  const path = await room(2,null), id=randomUUID(); await request(path,{id,text:'Discuss.'},202); const rows=await wait(path,id);
  assert.match(rows[0].room.note,/loop guard/); assert(calls.length <= 6);
}));

test('room limit preserves the original delegation call and bounded receipt across restart', async () => fixture(async ({ database, members, room, request, wait, setRespond, tool, calls, stop, restart }: any) => {
  setRespond((body: any) => latest(body) === '@Assistant, begin.' ? '@Right Hand, continue.' : body.model === 'Right Hand' ? '@Assistant, delegate now.' : body.messages.some((message: any) => message.role === 'tool') ? 'Bounded safely.' : tool('delegate_task', { agent: members[1].id, task: 'One more round', wait: true }));
  const path = await room(2, null), id = randomUUID(), command = { id, text: '@Assistant, begin.' };
  await request(path, command, 202); const rows = await wait(path, id);
  assert.match(rows[0].room.note, /3 agent rounds/);
  assert.equal(rows[0].room.messages.at(-1).text, 'Bounded safely.');
  await stop(); const db = new DatabaseSync(database, { readOnly: true });
  try {
    const saved = db.prepare('SELECT call,result FROM flow_tool_calls ORDER BY seq DESC LIMIT 1').get()!;
    assert.equal(JSON.parse(String(saved.call)).function.name, 'delegate_task');
    assert.deepEqual(JSON.parse(String(saved.result)), { status: 'bounded' });
  } finally { db.close(); }
  const count = calls.length; await restart(); await request(path, command, 202); assert.equal(calls.length, count);
}));

test('restart resumes queued room members without replaying interrupted provider calls', async () => fixture(async ({ room, request, wait, setRespond, calls, restart }: any) => {
  let release: (() => void) | undefined; let first=true;
  setRespond(async () => { if(first) { first=false; await new Promise<void>(resolve => { release=resolve; }); } return 'A useful reply.'; });
  const path=await room(2,null), id=randomUUID(), command={id,text:'Recover room'}; await request(path,command,202);
  await wait(path,id,(rows:any[])=>rows.some(row=>row.status==='running'));
  await restart(); release?.(); const rows=await wait(path,id);
  assert.equal(calls.length,2); assert.equal(rows.filter((row:any)=>row.status==='interrupted').length,1);
  await request(path,command,202); assert.equal(calls.length,2);
},1));

test('direct delegation exposes inline transcript request, named reply, machine and activity without replacing final answer', async () => fixture(async ({ members, request, setRespond, tool }: any) => {
  setRespond((body:any)=>body.model==='Right Hand'?'Research result.':body.messages.some((message:any)=>message.role==='tool')?'Final answer.':tool('delegate_task',{agent:members[1].id,task:'Research request.',wait:true}));
  const path=`/api/agents/${members[0].id}/turns`, id=randomUUID(); await request(path,{id,text:'Delegate.'},202);
  let turn:any;
  for(let n=0;n<300;n++){turn=(await request(path))[0];if(turn.status==='done')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(turn.reply,'Final answer.');assert.equal(turn.agentMessages[0].task,'Research request.');assert.equal(turn.agentMessages[0].name,'Right Hand');assert.equal(turn.agentMessages[0].reply,'Research result.');assert(turn.agentMessages[0].activity.calls.length);
}));
