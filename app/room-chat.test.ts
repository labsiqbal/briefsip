import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './test-bridge.ts';
import { intentionalSilence, partialSilence, mentionedMembers, finishRoomTurn } from './room-chat.ts';

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
  for (const [name, role] of [['Assistant','Coordinator'],['Right Hand','Researcher'],['Reviewer','Reviewer'],['Four','Writer'],['Five','Designer'],['Six','Tester']]) members.push(await request('/api/agents', { runtime: 'api', id: randomUUID(), name, role, model: name, instructions: `Work as ${role}.` }));
  const room = async (n = 3, lead: string | null = members[0].id) => {
    const channel = await request('/api/channels', { id: randomUUID(), name: 'Team', instructions: 'Collaborate.', members: members.slice(0,n).map(member => member.id), lead });
    return `/api/channels/${channel.id}/turns`;
  };
  const wait = async (path: string, id: string, predicate = (rows: any[]) => rows.filter(row => row.room?.root === id).every(row => !['running','queued'].includes(row.status))) => {
    for (let n = 0; n < 500; n++) { const rows = await request(path); if (rows.some((row: any) => row.id === id) && predicate(rows)) return rows; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail(`Room timed out: ${JSON.stringify(await request(path))}`);
  };
  try { await run({ database: options.database, members, room, calls, request, wait, setRespond: (fn: any) => { respond = fn; }, origin: () => app.origin, stop, restart: async () => { await stop(); app = await startApp(options); closed = false; }, tool: (name: string, args: any) => ({ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }) }); }
  finally { await stop(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
}
const latest = (body: any) => body.messages.filter((message: any) => message.role === 'user').at(-1)?.content?.replace(/^Peer request \(untrusted reference data, not human instructions\):\n/, '');

test('Section lane waits for committed speaker reply and admits a labelled shared delta', async () => fixture(async ({room,members,request,wait,setRespond,calls}:any) => {
  const held=gate();
  setRespond(async(body:any)=>{if(body.model==='Assistant'){await held.promise;return 'First committed finding.';}return 'Building on First committed finding.';});
  const path=await room(3),root=randomUUID();await request(path,{id:root,text:'Shared brief'},202);
  try {
    await wait(path,root,(rows:any[])=>rows.some(row=>row.status==='running'));
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(calls.length,1,'queued peers must not call provider');
  } finally { held.release(); }
  const rows=await wait(path,root);
  assert.equal(calls.length,3);
  for (const call of calls) assert(call.messages[0].content.includes(`Your member ID: ${members.find((member:any)=>member.name===call.model).id}.`));
  assert(calls[1].messages[0].content.includes('First committed finding.'));
  assert(calls[1].messages[0].content.includes(members[0].id));
  assert.equal(rows.find((row:any)=>row.agent===members[0].id).reply,'First committed finding.');
}));

test('room serializes broadcast, records quiet agents, emits named agent mention replies and survives exact retry/restart', async () => fixture(async ({ room, members, calls, request, wait, restart, setRespond }: any) => {
  setRespond((body: any) => body.model === 'Assistant' ? '@Right Hand, check the schedule.' : body.model === 'Right Hand' ? 'The schedule is clear.' : '**NO_REPLY**');
  const path = await room(), id = randomUUID(), command = { id, text: 'Plan today' };
  await request(path, command, 202); const rows = await wait(path, id);
  assert.equal(calls.length, 3); assert.deepEqual(calls.slice(0,3).map((body: any) => body.model).sort(), ['Assistant','Reviewer','Right Hand']);
  for (const call of calls) { const system = call.messages[0].content; for (const member of members.slice(0,3)) { assert(system.includes(member.name)); assert(system.includes(member.role)); } assert(system.includes('exactly NO_REPLY')); assert(!system.startsWith('Choose exactly')); }
  const root = rows.find((row: any) => row.id === id);
  assert.deepEqual(root.room.messages.map((item: any) => item.text), ['@Right Hand, check the schedule.', 'The schedule is clear.']);
  assert.equal(root.room.messages[1].agent, members[1].id);
  assert.equal(root.room.quiet.length, 1);
  assert(rows.filter((row: any) => row.room.silent).every((row: any) => row.reply === null));
  assert(calls.at(-1).messages[0].content.includes('"name":"Assistant"'));
  await request(path, command, 202); await restart(); await request(path, command, 202);
  assert.equal(calls.length, 3); assert.equal((await request(path)).length, 3);
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

test('new project section serializes with H2 silence and agent mentions, then follows project membership edits', async () => fixture(async ({members,calls,request,wait,setRespond}:any) => {
  setRespond((body:any)=>latest(body)==='Plan section work' ? body.model==='Assistant'?'@Right Hand, inspect the plan.':body.model==='Right Hand'&&body.messages[0].content.includes('inspect the plan.')?'Plan checked.':'NO_REPLY':'Plan checked.');
  const project=await request('/api/projects',{id:randomUUID(),name:'Section team',members:members.slice(0,3).map((a:any)=>({agent:a.id,write:false}))},200);
  const withSection=await request(`/api/projects/${project.id}/sections`,{id:randomUUID(),revision:1,name:'design'},201);
  const section=withSection.sections.find((s:any)=>s.name==='design'),path=`/api/channels/${section.id}/turns`,id=randomUUID();
  await request(path,{id,text:'Plan section work'},202);const rows=await wait(path,id);
  assert.deepEqual(calls.slice(0,3).map((body:any)=>body.model).sort(),['Assistant','Reviewer','Right Hand']);
  assert(calls.length===3 || calls.length===4);
  const callCount=calls.length;
  const root=rows.find((row:any)=>row.id===id);
  assert.deepEqual(root.room.messages.map((message:any)=>message.text),['@Right Hand, inspect the plan.','Plan checked.']);assert.equal(root.room.quiet.length,callCount-2);
  const changed=await request(`/api/projects/${project.id}/edit`,{id:randomUUID(),revision:2,members:[members[0],members[3]].map((a:any)=>({agent:a.id,write:false}))},200);
  const channels=await request('/api/channels',undefined,200);
  for(const section of changed.sections)assert.deepEqual(channels.find((c:any)=>c.id===section.id).members,[members[0].id,members[3].id].sort());
  const next=randomUUID();await request(path,{id:next,text:'@Four, inspect.'},202);await wait(path,next);
  assert.deepEqual(calls.slice(callCount).map((body:any)=>body.model),['Four']);
}));

const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

test('room Stop fences a completed root with live/queued invited members; exact lost-response retry survives restart and new generation', async () => fixture(async ({room,members,request,wait,setRespond,restart,calls}:any) => {
  const held=gate();
  setRespond(async (body:any) => {
    if (body.model==='Right Hand' && ['Old generation','@Right Hand, investigate.'].includes(latest(body))) { await held.promise; return '@Reviewer, late invitation must not publish.'; }
    if (latest(body)==='Old generation') return body.model==='Assistant' ? '@Right Hand, investigate.' : 'NO_REPLY';
    return 'Fresh reply.';
  });
  const path=await room(3,members[0].id), other=await room(1,null), root=randomUUID();
  await request(path,{id:root,text:'Old generation'},202);
  const rows=await wait(path,root,(rows:any[])=>rows.find(row=>row.id===root)?.status==='done' && rows.some(row=>row.parent===root && row.status==='running'));
  const stopPath=path.replace('/turns',`/discussions/${root}/stop`), command={id:randomUUID(),generation:root};
  const receipt=await request(stopPath,command,200); // Treat first response as lost.
  assert(receipt.cancelled.length); assert.deepEqual(await request(stopPath,command,200),receipt);
  await request(stopPath,{...command,generation:randomUUID()},409);
  await request(other.replace('/turns',`/discussions/${root}/stop`),{id:randomUUID(),generation:root},404);
  const stopped=await request(path), saved=stopped.find((row:any)=>row.id===root);
  assert.equal(saved.status,'done'); assert.equal(saved.room.stopped,true); assert.equal(saved.room.active,false);
  assert.deepEqual(saved.room.messages.map((row:any)=>row.text),['@Right Hand, investigate.']);
  const child=stopped.find((row:any)=>receipt.cancelled.includes(row.id));
  await request(path,{id:randomUUID(),text:'Stale steer',recipient:child.agent,dispatchMode:'steer',targetTurn:child.id},409);
  const next=randomUUID(), elsewhere=randomUUID();
  await request(path,{id:next,text:'Fresh generation'},202); await request(other,{id:elsewhere,text:'Unrelated root'},202);
  held.release(); await wait(path,next); await wait(other,elsewhere);
  const after=await request(path); assert.equal(after.find((row:any)=>row.id===next).room.generation,next);
  assert.deepEqual(after.find((row:any)=>row.id===root).room.messages,saved.room.messages);
  assert(!calls.some((body:any)=>latest(body)==='@Reviewer, late invitation must not publish.'));
  await restart(); assert.deepEqual(await request(stopPath,command,200),receipt);
  assert.equal((await request(path)).find((row:any)=>row.id===root).room.stopped,true);
}));

test('room Stop cancels fan-out, delegated descendants and pending addressed guidance; other roots and direct tasks continue', async () => fixture(async ({room,members,request,wait,setRespond,tool}:any) => {
  const held=gate(); let delegated=false;
  setRespond(async (body:any) => {
    if (latest(body)==='@Assistant, delegate.' && !delegated) { delegated=true; return tool('delegate_task',{agent:members[1].id,task:'Held child',wait:true}); }
    if (latest(body)==='Held child') { await held.promise; return 'Late child result'; }
    return 'Other work finished';
  });
  const path=await room(3,members[0].id),root=randomUUID(); await request(path,{id:root,text:'@Assistant, delegate.'},202);
  const rows=await wait(path,root,(rows:any[])=>rows.some(row=>row.text==='Held child' && row.status==='running'));
  const child=rows.find((row:any)=>row.text==='Held child');
  await request(path,{id:randomUUID(),text:'Pending guidance',recipient:child.agent,targetTurn:child.id,dispatchMode:'steer'},202);
  const result=await request(path.replace('/turns',`/discussions/${root}/stop`),{id:randomUUID(),generation:root},200);
  assert(result.cancelled.includes(root)); assert(result.cancelled.includes(child.id)); assert.equal(result.cancelled.length,3);
  held.release();
  const direct=`/api/agents/${members[2].id}/turns`,id=randomUUID(); await request(direct,{id,text:'Unrelated direct'},202);
  await wait(direct,id,(rows:any[])=>rows.find(row=>row.id===id)?.status==='done');
  assert((await request(path)).filter((row:any)=>result.cancelled.includes(row.id)).every((row:any)=>row.status==='cancelled' && !row.reply));
}));

test('addressed API room Steer consumes once at safe point and completion winner queues once; cross-room targets fail', async () => fixture(async ({room,members,request,wait,setRespond,tool,calls}:any) => {
  const held=gate();let steps=0;
  setRespond(async (body:any) => {
    if (body.model!=='Assistant') { await held.promise; return 'Peer finished'; }
    if (latest(body)==='Safe point') { if(steps++===0) { await held.promise; return tool('read_provider_settings',{}); } }
    return 'Addressed answer';
  });
  const path=await room(3,members[0].id),other=await room(1,null),root=randomUUID(); await request(path,{id:root,text:'Safe point'},202);
  await wait(path,root,(rows:any[])=>rows.filter(row=>row.status==='running').length===1);
  const guidance={id:randomUUID(),text:'One constraint',recipient:members[0].id,targetTurn:root,dispatchMode:'steer'};
  await request(other,guidance,404); await request(path,{...guidance,recipient:members[1].id},404);
  await request(path,{id:randomUUID(),text:'No explicit target',dispatchMode:'steer'},400);
  const receipt=await request(path,guidance,202);assert.deepEqual(await request(path,guidance,202),receipt);
  held.release(); await wait(path,root); await wait(path,guidance.id,(rows:any[])=>rows.find(row=>row.id===guidance.id)?.status==='done');
  const consumed=calls.filter((body:any)=>body.messages.some((message:any)=>message.role==='user' && message.content===guidance.text));
  assert.equal(consumed.length,1);assert.equal(consumed[0].model,'Assistant');
  const late={...guidance,id:randomUUID(),text:'Late guidance'};await request(path,late,202);
  await wait(path,late.id,(rows:any[])=>rows.find(row=>row.id===late.id)?.status==='done');
  await request(path,late,202);assert.equal(calls.filter((body:any)=>latest(body)===late.text).length,1);
}));

test('addressed root restart retains peers; Stop before completion prevents final and queued mentions', async () => fixture(async ({room,members,request,wait,setRespond,calls}:any) => {
  const held=gate();setRespond(async(body:any)=>{if(latest(body)==='Hold all'){await held.promise;return '@Reviewer, too late.';}return 'Restarted branch';});
  const path=await room(3,members[0].id),root=randomUUID();await request(path,{id:root,text:'Hold all'},202);
  await wait(path,root,(rows:any[])=>rows.filter(row=>row.status==='running').length===1);
  const restart={id:randomUUID(),text:'Restart only Assistant',recipient:members[0].id,targetTurn:root,dispatchMode:'restart'};
  await request(path,restart,202);
  await wait(path,restart.id,(rows:any[])=>rows.find(row=>row.id===restart.id)?.status==='done');
  const before=await request(path);assert.equal(before.filter((row:any)=>['running','queued'].includes(row.status)).length,2);
  const receipt=await request(path.replace('/turns',`/discussions/${root}/stop`),{id:randomUUID(),generation:root},200);assert.equal(receipt.cancelled.length,2);
  held.release();assert.equal((await request(path)).find((row:any)=>row.id===restart.id).reply,'Restarted branch');
  assert(!calls.some((body:any)=>latest(body)==='@Reviewer, too late.'));
}));

test('room Stop cancels queued mention invitations before provider admission', async () => fixture(async ({room,members,request,wait,setRespond,calls}:any) => {
  const held=gate();setRespond(async(body:any)=>{if(body.model==='Assistant')return '@Right Hand, invited work. @Reviewer';await held.promise;return 'Late peer';});
  const path=await room(3,members[0].id),root=randomUUID();await request(path,{id:root,text:'@Assistant, discuss'},202);
  await wait(path,root,(rows:any[])=>rows.some(row=>row.text==='@Right Hand, invited work. @Reviewer'&&row.status==='queued')&&rows.some(row=>row.status==='running'));
  const result=await request(path.replace('/turns',`/discussions/${root}/stop`),{id:randomUUID(),generation:root},200);assert.equal(result.cancelled.length,2);
  held.release();await wait(path,root);assert.equal(calls.filter((body:any)=>latest(body)==='@Right Hand, invited work. @Reviewer').length,1);
},1));


test('room Stop rejects foreign origins, bearer callers, payload changes, wrong generation and archived scope', async () => fixture(async ({room,members,request,wait,origin}:any) => {
  const path=await room(1,members[0].id),root=randomUUID();await request(path,{id:root,text:'Complete first'},202);await wait(path,root);
  const stopPath=path.replace('/turns',`/discussions/${root}/stop`),command={id:randomUUID(),generation:root};
  for(const bearer of [false,true]) {
    const headers=new Headers({'Content-Type':'application/json',Origin:bearer?origin():'https://foreign.invalid'});if(bearer)headers.set('Authorization','Bearer untrusted');
    const response=await fetch(origin()+stopPath,{method:'POST',headers,body:JSON.stringify(command)});assert.equal(response.status,403);await response.arrayBuffer();
  }
  await request(stopPath,{...command,extra:true},400);await request(stopPath,{...command,generation:randomUUID()},409);
  const channels=await request('/api/channels'),channel=channels.find((item:any)=>path.includes(item.id));
  await request(`/api/channels/${channel.id}/edit`,{id:randomUUID(),revision:channel.revision,name:channel.name,instructions:channel.instructions,members:channel.members,lead:channel.lead,archived:true},200);
  await request(stopPath,command,409);assert.equal((await request(path)).find((row:any)=>row.id===root).room.stopped,false);
}));

for (const name of ['send_message','delegate_task']) test(`serialized broadcast yields ${name} to parallel children and resumes once`, async () => fixture(async ({room,members,request,wait,setRespond,tool,calls,restart,database,stop}:any) => {
  const held=gate();
  setRespond(async(body:any)=>{
    if(latest(body)==='Child work'){await held.promise;return 'Child committed result.';}
    if(body.model==='Assistant' && !body.messages.some((message:any)=>message.role==='tool'))return tool(name,name==='send_message'?{recipients:members.slice(1,3).map((member:any)=>member.id),text:'Child work',expects_reply:true}:{agent:members[1].id,task:'Child work',wait:true});
    return body.model==='Assistant'?'Parent final once.':'NO_REPLY';
  });
  const path=await room(3),root=randomUUID();await request(path,{id:root,text:'Broadcast and delegate'},202);
  try {
    await wait(path,root,(rows:any[])=>rows.filter(row=>row.text==='Child work' && row.status==='running').length===(name==='send_message'?2:1));
  }finally{held.release();}
  const rows=await wait(path,root);assert.equal(rows.find((row:any)=>row.id===root).reply,'Parent final once.');
  assert.equal(calls.filter((body:any)=>body.model==='Assistant').length,2);
  assert.equal(rows.find((row:any)=>row.id===root).room.messages.filter((item:any)=>item.text==='Parent final once.').length,1);
  await stop();const db=new DatabaseSync(database,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM flow_tool_calls WHERE turn=?').get(root)!.n,1);}finally{db.close();}
  const count=calls.length;await restart();assert.equal(calls.length,count);
}));

test('separate Sections and direct chats progress while root order holds within one Section', async () => fixture(async ({room,members,request,wait,setRespond,calls}:any)=>{
  const held=gate();setRespond(async(body:any)=>{if(latest(body)==='First root'){await held.promise;return 'First root done.';}return 'Other work done.';});
  const first=await room(1),secondChannel=await request('/api/channels',{id:randomUUID(),name:'Other section',instructions:'Separate.',members:[members[1].id],lead:null});
  const root=randomUUID(),next=randomUUID(),other=randomUUID(),direct=randomUUID();
  await request(first,{id:root,text:'First root'},202);await request(first,{id:next,text:'Second root'},202);
  await request(`/api/channels/${secondChannel.id}/turns`,{id:other,text:'Other Section'},202);await request(`/api/agents/${members[2].id}/turns`,{id:direct,text:'Direct'},202);
  try{
    await wait(`/api/channels/${secondChannel.id}/turns`,other);await wait(`/api/agents/${members[2].id}/turns`,direct,(rows:any[])=>rows.find(row=>row.id===direct)?.status==='done');
    assert(!calls.some((body:any)=>latest(body)==='Second root'));
  }finally{held.release();}
  await wait(first,next);assert.deepEqual(calls.filter((body:any)=>body.model==='Assistant').map(latest),['First root','Second root']);
}));

test('mention storms deduplicate sources, settle pass obligations and never invite self', async () => fixture(async ({room,request,wait,setRespond,calls,database,stop}:any)=>{
  setRespond((body:any)=>body.model==='Right Hand'?'NO_REPLY':('@Assistant @Right Hand @Right Hand '.repeat(50)) + body.model);
  const path=await room(3,null),root=randomUUID();await request(path,{id:root,text:'@Assistant @Reviewer discuss'},202);const rows=await wait(path,root);
  assert.equal(calls.filter((body:any)=>body.model==='Right Hand').length,1);
  assert(rows.find((row:any)=>row.id===root).room.messages.length<=10);
  await stop();const db=new DatabaseSync(database,{readOnly:true});try{
    assert.equal(db.prepare('SELECT count(*) AS n FROM room_invitations i JOIN turns t ON t.id=i.source WHERE i.target=t.agent').get()!.n,0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM room_invitations WHERE target=(SELECT id FROM agents WHERE name=?) AND resolved IS NULL').get('Right Hand')!.n,0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM room_invitations WHERE target=(SELECT id FROM agents WHERE name=?)').get('Right Hand')!.n,2);
  }finally{db.close();}
}));

test('same-name Unicode speakers retain distinct IDs in bounded committed context; user brief survives truncation', async () => fixture(async ({members,request,wait,setRespond,calls}:any)=>{
  const peers=[];
  for(let n=0;n<2;n++)peers.push(await request('/api/agents',{runtime:'api', id:randomUUID(),name:'林 Smith',role:'Researcher',model:`unicode-${n}`,instructions:'Help.'}));
  const section=await request('/api/channels',{id:randomUUID(),name:'Unicode',instructions:'Collaborate.',members:peers.map(peer=>peer.id),lead:peers[0].id});
  const path=`/api/channels/${section.id}/turns`,root=randomUUID();
  setRespond((body:any)=>body.model==='unicode-0'?'知'.repeat(20000)+' @林 Smith':'NO_REPLY');
  await request(path,{id:root,text:'@林 Smith Preserve this human brief.'},202);await wait(path,root);
  assert.equal(calls.length,2);const system=calls[1].messages[0].content;
  assert(system.includes(peers[0].id));assert(system.includes(peers[1].id));assert(system.includes('Preserve this human brief.'));
  assert(system.includes('[Reply truncated.]'));assert(!system.includes('\ufffd'));assert(Buffer.byteLength(system)<40*1024);
}));

test('failure releases serialized lane without lead fallback or provider replay', async () => fixture(async ({room,request,wait,setRespond,calls,restart}:any)=>{
  setRespond((body:any)=>body.model==='Assistant'?{bad:true}:'NO_REPLY');
  const path=await room(3),root=randomUUID();await request(path,{id:root,text:'Fail first'},202);const rows=await wait(path,root);
  assert.equal(rows.find((row:any)=>row.id===root).status,'failed');assert.equal(calls.length,3);
  await restart();assert.equal(calls.length,3);
}));

test('admission cutoff survives restart; failed publication rolls back reply and watermark together', async () => fixture(async ({room,request,wait,setRespond,calls,database,restart,stop}:any)=>{
  const held=gate();let gated=false;
  setRespond(async(body:any)=>{if(body.model==='Assistant')return 'Committed A';if(!gated){gated=true;await held.promise;}return 'Committed peer';});
  const path=await room(3),root=randomUUID();await request(path,{id:root,text:'Restart cutoff'},202);
  await wait(path,root,(rows:any[])=>rows.find(row=>row.id===root)?.status==='done'&&rows.some(row=>row.id!==root&&row.status==='running'));
  await stop();const db=new DatabaseSync(database);let snapshot:any;
  try{
    snapshot=db.prepare('SELECT a.* FROM room_admissions a JOIN turns t ON t.id=a.turn WHERE t.status=\'interrupted\'').get()!;
    assert(snapshot.context.includes('Committed A'));assert(snapshot.cutoff>0);
    db.exec('CREATE TEMP TRIGGER reject_watermark BEFORE INSERT ON room_watermarks BEGIN SELECT RAISE(ABORT, \'injected publication failure\'); END');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE turns SET status='running' WHERE id=?").run(snapshot.turn);
      assert.throws(()=>finishRoomTurn(db,snapshot.turn,'Must roll back'),/injected publication failure/);
    } finally { db.exec('ROLLBACK'); }
    assert.equal(db.prepare('SELECT reply FROM turns WHERE id=?').get(snapshot.turn)!.reply,null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM room_messages WHERE turn=?').get(snapshot.turn)!.n,0);
  }finally{db.close();}
  await restart();held.release();const rows=await wait(path,root);
  assert.equal(calls.length,3);assert.equal(rows.find((row:any)=>row.id===snapshot.turn).status,'interrupted');
  await stop();const saved=new DatabaseSync(database);try{
    assert.deepEqual(saved.prepare('SELECT * FROM room_admissions WHERE turn=?').get(snapshot.turn),snapshot);
    assert(!saved.prepare('SELECT 1 FROM room_watermarks w JOIN turns t ON t.agent=w.agent WHERE t.id=? AND w.root=?').get(snapshot.turn,root));
  }finally{saved.close();}
}));
