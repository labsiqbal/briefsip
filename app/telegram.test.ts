import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { telegramInput, telegramApi, initializeTelegram, queueTelegramReply, deliverTelegramReply } from './telegram.ts';

test('Telegram accepts only allowlisted private human text', () => {
  const message = { message_id: 2, chat: { id: 4, type: 'private' }, from: { id: 4, is_bot: false }, text: 'Hello' };
  assert.deepEqual(telegramInput({ update_id: 1, message }, new Set([4])), { update: 1, chat: 4, message: 2, text: 'Hello' });
  for (const bad of [{ ...message, chat: { id: 4, type: 'group' } }, { ...message, from: { id: 5, is_bot: false } }, { ...message, from: { id: 4, is_bot: true } }, { ...message, text: '\ud800' }, { ...message, text: '' }]) assert.equal(telegramInput({ update_id: 1, message: bad }, new Set([4])), null);
  assert.equal(telegramInput({ update_id: 1, message }, new Set([5])), null);
});

test('Telegram partial delivery and lost responses never replay accepted chunks', async () => {
  const db = new DatabaseSync(':memory:'), calls: any[] = [];
  let mode = 'ok';
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); calls.push(body);
    if (mode === 'lost') { req.socket.destroy(); return; }
    if (mode === 'reject') { res.writeHead(400); res.end(JSON.stringify({ ok: false, error_code: 400, description: 'untrusted token detail' })); return; }
    res.end(JSON.stringify({ ok: true, result: { message_id: calls.length, chat: { id: body.chat_id } } }));
    mode = 'lost';
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const request = telegramApi('123:' + 'x'.repeat(24), `http://127.0.0.1:${address.port}`);
  try {
    initializeTelegram(db);
    const id = randomUUID(), text = 'a'.repeat(4095) + '\u{1f600}' + 'tail';
    queueTelegramReply(db, id, 4, 2, text); queueTelegramReply(db, id, 4, 2, text);
    assert.throws(() => queueTelegramReply(db, id, 5, 2, text));
    await deliverTelegramReply(db, id, request);
    assert.equal(calls.length, 2); assert.equal(calls[0].text.length, 4095); assert.equal(calls[1].text, '\u{1f600}tail');
    assert.deepEqual(calls[0].reply_parameters, { message_id: 2, allow_sending_without_reply: false });
    assert.equal(calls[0].parse_mode, undefined);
    let row = db.prepare('SELECT * FROM telegram_outbox WHERE id=?').get(id)!;
    assert.equal(row.status, 'uncertain'); assert.equal(row.part, 1); assert.equal(row.message_ids, '[1]');
    initializeTelegram(db); await deliverTelegramReply(db, id, request); assert.equal(calls.length, 2);
    const rejected = randomUUID(); mode = 'reject'; queueTelegramReply(db, rejected, 4, 2, 'Rejected'); await deliverTelegramReply(db, rejected, request);
    row = db.prepare('SELECT * FROM telegram_outbox WHERE id=?').get(rejected)!;
    assert.equal(row.status, 'failed'); assert.equal(row.error, 'Telegram rejected request (400).');
    const interrupted = randomUUID(); queueTelegramReply(db, interrupted, 4, 2, 'Interrupted');
    db.prepare("UPDATE telegram_outbox SET status='sending' WHERE id=?").run(interrupted); initializeTelegram(db);
    await deliverTelegramReply(db, interrupted, request); assert.equal(calls.length, 3);
  } finally { db.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Telegram input journal pins identity and commits messages before acknowledgement', async () => {
  const { bindTelegram, recordTelegramUpdates } = await import('./telegram.ts');
  const db = new DatabaseSync(':memory:'), agent = randomUUID(), users = new Set([4]);
  const update = (id: number, text: string, user = 4) => ({ update_id: id, message: { message_id: id + 1, chat: { id: user, type: 'private' }, from: { id: user, is_bot: false }, text } });
  try {
    initializeTelegram(db); bindTelegram(db,123,agent);
    assert.equal(recordTelegramUpdates(db,[update(2,'Second'),update(1,'First'),update(3,'Foreign',5)],users),4);
    const saved = db.prepare('SELECT * FROM telegram_inbox ORDER BY update_id').all();
    assert.equal(saved.length,2); assert.equal(saved[0].thread,saved[1].thread); assert.notEqual(saved[0].turn,saved[1].turn);
    initializeTelegram(db);bindTelegram(db,123,agent);
    recordTelegramUpdates(db,[update(1,'First'),update(2,'Second')],users);
    assert.deepEqual(db.prepare('SELECT * FROM telegram_inbox ORDER BY update_id').all(),saved);
    assert.throws(()=>bindTelegram(db,124,agent),/another bot/);
    assert.throws(()=>bindTelegram(db,123,randomUUID()),/another bot/);
    assert.throws(()=>recordTelegramUpdates(db,[update(4,'New'),update(4,'Changed')],users),/conflict/);
    assert.equal(db.prepare('SELECT offset FROM telegram_binding').get()!.offset,4);
    assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_inbox').get()!.n,2);
    assert.throws(()=>recordTelegramUpdates(db,[update(5,'Valid'),{update_id:-1}],users));
    assert.equal(db.prepare('SELECT offset FROM telegram_binding').get()!.offset,4);
  } finally {db.close();}
});

test('Telegram bridge submits once through granted side-thread API and isolates main history', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startApp } = await import('./server.ts');
  const { bindTelegram, recordTelegramUpdates } = await import('./telegram.ts');
  const { telegramLocal, telegramAgentStep } = await import('./telegram-bridge.ts');
  const dir = mkdtempSync(join(tmpdir(),'briefsip-telegram-')), agent = randomUUID(), users = new Set([4]);
  let calls = 0;
  const provider = createServer(async(req,res) => { for await (const _ of req) {} calls++; res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Synthetic reply'}}]})); });
  await new Promise<void>(resolve => provider.listen(0,'127.0.0.1',resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  const app = await startApp({database:join(dir,'app.sqlite'),baseURL:`http://127.0.0.1:${address.port}/v1`,scriptDirectory:join(dir,'scripts')});
  const db = new DatabaseSync(join(dir,'telegram.sqlite')), sent: any[] = [];
  const remote = async (_method: string, body: Record<string,unknown>) => {sent.push(body);return {message_id:99,chat:{id:body.chat_id}};};
  async function ui(path: string, body?: unknown): Promise<any> {const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});assert(res.ok);return res.json();}
  try {
    await ui('/api/agents',{id:agent,name:'Telegram fixture',model:'fixture',instructions:'Help'});
    await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true});
    initializeTelegram(db);bindTelegram(db,123,agent);
    const update={update_id:1,message:{message_id:2,chat:{id:4,type:'private'},from:{id:4,is_bot:false},text:'Hello'}};
    recordTelegramUpdates(db,[update],users);
    const local=telegramLocal(join(dir,'scripts')); let lost=true;
    const flaky=async(path:string,body?:unknown,signal?:AbortSignal)=>{const result=await local(path,body,signal);if(lost&&body&&path.endsWith('/turns')){lost=false;throw new Error('Dropped accepted local response');}return result;};
    await assert.rejects(telegramAgentStep(db,users,flaky,remote),/Dropped/);
    for(let n=0;n<100&&!sent.length;n++){await telegramAgentStep(db,users,local,remote);await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(sent.length,1);assert.equal(sent[0].text,'Synthetic reply');assert.equal(calls,1);
    assert.deepEqual(await ui(`/api/agents/${agent}/turns`),[]);
    initializeTelegram(db);recordTelegramUpdates(db,[update],users);await telegramAgentStep(db,users,local,remote);
    assert.equal(sent.length,1);assert.equal(calls,1);
    const pending=randomUUID();queueTelegramReply(db,pending,4,2,'x'.repeat(4097));
    let parts=0;
    const revokeDuringSend=async(_method:string,body:Record<string,unknown>)=>{parts++;await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:1,enabled:false});return {message_id:100,chat:{id:body.chat_id}};};
    await assert.rejects(telegramAgentStep(db,users,local,revokeDuringSend));assert.equal(parts,1);
    const paused=db.prepare('SELECT status,part FROM telegram_outbox WHERE id=?').get(pending)!;
    assert.equal(paused.status,'queued');assert.equal(paused.part,1);
    await assert.rejects(telegramAgentStep(db,users,local,remote));assert.equal(sent.length,1);
  } finally {db.close();await app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

test('Telegram journal refuses concurrent ownership, unsafe files and mismatched bot startup', async () => {
  const {mkdtempSync,mkdirSync,rmSync,writeFileSync,symlinkSync,existsSync} = await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {telegramJournal,runTelegram}=await import('./telegram-runner.ts');
  const root=mkdtempSync(join(tmpdir(),'briefsip-telegram-lock-'));
  const server=createServer((_req,res)=>res.end(JSON.stringify({ok:true,result:{id:124,is_bot:true}})));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');
  try{
    const path=join(root,'safe'),first=telegramJournal(path);initializeTelegram(first.db);
    assert.throws(()=>telegramJournal(path));first.close();const second=telegramJournal(path);second.close();
    const unsafe=join(root,'unsafe');mkdirSync(unsafe,{mode:0o700});writeFileSync(join(root,'outside'),'KEEP');symlinkSync(join(root,'outside'),join(unsafe,'telegram.sqlite'));
    assert.throws(()=>telegramJournal(unsafe),/private and regular/);assert(!existsSync(join(unsafe,'owner.lock')));
    await assert.rejects(runTelegram({directory:join(root,'mismatch'),scriptDirectory:join(root,'absent'),agent:randomUUID(),token:'123:'+'x'.repeat(24),users:[4],origin:`http://127.0.0.1:${address.port}`},new AbortController().signal),/identity mismatch/);
    assert(!existsSync(join(root,'mismatch','owner.lock')));
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
});

test('Telegram question answers stay with requesting chat and retain retry identity', async()=>{
  const {bindTelegram,recordTelegramUpdates}=await import('./telegram.ts');
  const {telegramAgentStep}=await import('./telegram-bridge.ts');
  const db=new DatabaseSync(':memory:'),agent=randomUUID(),question=randomUUID(),users=new Set([4,5]),sent:any[]=[],answers:any[]=[];
  let answered=false,lost=true;
  const update=(id:number,user:number,text:string)=>({update_id:id,message:{message_id:id+1,chat:{id:user,type:'private'},from:{id:user,is_bot:false},text}});
  try{
    initializeTelegram(db);bindTelegram(db,123,agent);recordTelegramUpdates(db,[update(1,4,'Ask')],users);
    const original=db.prepare('SELECT * FROM telegram_inbox').get()!;
    const local=async(path:string,body?:any)=>{
      if(path.endsWith('/answer')){answers.push({path,body});answered=true;if(lost){lost=false;throw new Error('Lost answer response');}return {};}
      if(path.includes('?focus='))return [{id:original.turn,status:answered?'done':'queued',reply:answered?'Confirmed':'',questions:[{id:question,prompt:'Proceed?',choices:['Yes','No'],answer:answered?'Yes':null}]}];
      return {};
    };
    const remote=async(_method:string,body:Record<string,unknown>)=>{sent.push(body);return {message_id:sent.length,chat:{id:body.chat_id}};};
    await telegramAgentStep(db,users,local,remote);assert.match(sent[0].text,/\/answer/);
    recordTelegramUpdates(db,[update(2,5,`/answer ${question} Yes`)],users);
    await telegramAgentStep(db,users,local,remote);assert.equal(answers.length,0);assert.equal(sent[1].chat_id,5);
    recordTelegramUpdates(db,[update(3,4,`/answer ${question} Yes`)],users);
    await assert.rejects(telegramAgentStep(db,users,local,remote),/Lost/);
    await telegramAgentStep(db,users,local,remote);assert.equal(answers.length,2);assert.deepEqual(answers[0],answers[1]);
    assert(answers[0].path.includes(String(original.thread)));assert(answers[0].path.includes(String(original.turn)));
    assert(sent.some(item=>item.text==='Confirmed'&&item.chat_id===4));
  }finally{db.close();}
});

test('Telegram stop cannot cancel another chat and never starts an unsent task',async()=>{
  const {bindTelegram,recordTelegramUpdates}=await import('./telegram.ts');const {telegramAgentStep}=await import('./telegram-bridge.ts');
  const db=new DatabaseSync(':memory:'),users=new Set([4,5]);let writes=0;
  const update=(id:number,user:number,text:string)=>({update_id:id,message:{message_id:id+1,chat:{id:user,type:'private'},from:{id:user,is_bot:false},text}});
  try{
    initializeTelegram(db);bindTelegram(db,123,randomUUID());recordTelegramUpdates(db,[update(1,4,'Never start')],users);
    const turn=String(db.prepare('SELECT turn FROM telegram_inbox').get()!.turn);
    recordTelegramUpdates(db,[update(2,5,`/stop ${turn}`),update(3,4,`/stop ${turn}`)],users);
    const local=async(_path:string,body?:unknown)=>{if(body)writes++;return [];};
    const sent:any[]=[];const remote=async(_method:string,body:Record<string,unknown>)=>{sent.push(body);return {message_id:sent.length,chat:{id:body.chat_id}};};
    await telegramAgentStep(db,users,local,remote);assert.equal(writes,0);
    assert.equal(db.prepare('SELECT status FROM telegram_inbox WHERE turn=?').get(turn)!.status,'cancelled');
    assert(sent.some(item=>item.chat_id===5&&item.text.includes('tidak ditemukan')));
    assert(sent.some(item=>item.chat_id===4&&item.text.includes('sebelum dikirim')));
  }finally{db.close();}
});

for(const ask of [false,true])test(`Telegram runner ${ask?'answers a question':'replies directly'} and releases owned journal on shutdown`,async()=>{
  const {mkdtempSync,rmSync,existsSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {startApp}=await import('./server.ts');const {runTelegram}=await import('./telegram-runner.ts');
  const root=mkdtempSync(join(tmpdir(),'briefsip-telegram-run-')),agent=randomUUID(),controller=new AbortController();
  let modelCalls=0,delivered=0;let answerUpdate:any;const offsets:number[]=[];
  const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const data=JSON.parse(raw);modelCalls++;const question=ask&&!data.messages.some((message:any)=>message.role==='tool');res.end(JSON.stringify({choices:[{finish_reason:question?'tool_calls':'stop',message:question?{tool_calls:[{id:'question',type:'function',function:{name:'ask_user',arguments:JSON.stringify({question:'Proceed?',choices:['Yes','No']})}}]}:{content:'Runner reply'}}]}));});
  const telegram=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);let result:any;
    if(req.url?.endsWith('/getMe'))result={id:123,is_bot:true};
    else if(req.url?.endsWith('/getUpdates')){offsets.push(body.offset);result=body.offset<8?[{update_id:7,message:{message_id:8,chat:{id:4,type:'private'},from:{id:4,is_bot:false},text:'Runner request'}}]:answerUpdate&&body.offset<9?[answerUpdate]:[];}
    else{assert.equal(body.chat_id,4);delivered++;result={message_id:20+delivered,chat:{id:4}};if(body.text.includes('/answer ')){const id=/\/answer ([a-f0-9-]{36})/.exec(body.text)![1];answerUpdate={update_id:8,message:{message_id:10,chat:{id:4,type:'private'},from:{id:4,is_bot:false},text:`/answer ${id} Yes`}};}else if(body.text==='Runner reply')setTimeout(()=>controller.abort(),30);else assert.equal(body.text,'Jawaban diterima.');}
    res.end(JSON.stringify({ok:true,result}));});
  await Promise.all([new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve)),new Promise<void>(resolve=>telegram.listen(0,'127.0.0.1',resolve))]);
  const pa=provider.address(),ta=telegram.address();assert(pa&&typeof pa!=='string'&&ta&&typeof ta!=='string');
  const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${pa.port}/v1`,scriptDirectory:join(root,'scripts')});
  const timeout=setTimeout(()=>controller.abort(),10000);
  try{
    for(const [path,body]of [['/api/agents',{id:agent,name:'Runner',model:'fixture',instructions:'Help'}],[`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true}]]as const){const response=await fetch(app.origin+path,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});assert(response.ok);await response.json();}
    await runTelegram({directory:join(root,'state'),scriptDirectory:join(root,'scripts'),agent,token:'123:'+'x'.repeat(24),users:[4],origin:`http://127.0.0.1:${ta.port}`},controller.signal);
    assert.equal(modelCalls,ask?2:1);assert.equal(delivered,ask?3:1);assert(offsets.includes(8));assert(!existsSync(join(root,'state','owner.lock')));
    const journal=new DatabaseSync(join(root,'state','telegram.sqlite'));try{assert.equal(journal.prepare('SELECT status FROM telegram_outbox').get()!.status,'sent');}finally{journal.close();}
  }finally{clearTimeout(timeout);controller.abort();await app.close();provider.closeAllConnections();telegram.closeAllConnections();await Promise.all([new Promise<void>(resolve=>provider.close(()=>resolve())),new Promise<void>(resolve=>telegram.close(()=>resolve()))]);rmSync(root,{recursive:true,force:true});}
});

test('Telegram polling progresses past a full page of waiting tasks',async()=>{
  const {bindTelegram,recordTelegramUpdates}=await import('./telegram.ts');const {telegramAgentStep}=await import('./telegram-bridge.ts');
  const db=new DatabaseSync(':memory:'),users=new Set([4]);
  try{
    initializeTelegram(db);bindTelegram(db,123,randomUUID());
    const update=(id:number)=>({update_id:id,message:{message_id:id+1,chat:{id:4,type:'private'},from:{id:4,is_bot:false},text:'Wait'}});
    recordTelegramUpdates(db,Array.from({length:100},(_,i)=>update(i)),users);recordTelegramUpdates(db,[update(100)],users);
    db.exec("UPDATE telegram_inbox SET status='running'");const last=String(db.prepare('SELECT turn FROM telegram_inbox WHERE update_id=100').get()!.turn),seen:string[]=[];
    const local=async(path:string)=>{const id=new URL('http://local'+path).searchParams.get('focus');if(id)seen.push(id);return id?[{id,status:'queued',questions:[]}]:[];};
    const remote=async()=>({});await telegramAgentStep(db,users,local,remote);await telegramAgentStep(db,users,local,remote);
    assert(seen.includes(last),'Last task must be polled despite older waiting tasks');
  }finally{db.close();}
});

test('Telegram oversized and whitespace final replies settle without blocking other chats',async()=>{
  const {bindTelegram,recordTelegramUpdates}=await import('./telegram.ts');const {telegramAgentStep}=await import('./telegram-bridge.ts');
  const db=new DatabaseSync(':memory:'),users=new Set([4]);
  try{
    initializeTelegram(db);bindTelegram(db,123,randomUUID());
    recordTelegramUpdates(db,[1,2].map(id=>({update_id:id,message:{message_id:id,chat:{id:4,type:'private'},from:{id:4,is_bot:false},text:'Reply'}})),users);
    const rows=db.prepare('SELECT * FROM telegram_inbox ORDER BY update_id').all();const sent:any[]=[];
    const local=async(path:string)=>{const id=new URL('http://local'+path).searchParams.get('focus');return id?[{id,status:'done',reply:id===rows[0].turn?'x'.repeat(64001):'   '}]:{};};
    const remote=async(_method:string,body:Record<string,unknown>)=>{sent.push(body);return {message_id:sent.length,chat:{id:4}};};
    await telegramAgentStep(db,users,local,remote);
    assert.equal(db.prepare("SELECT count(*) AS n FROM telegram_inbox WHERE status='done'").get()!.n,2);
    assert(sent.some(item=>item.text.includes('Balasan dipotong')));assert(sent.some(item=>item.text==='Tugas selesai tanpa balasan teks.'));
    const count=sent.length;await telegramAgentStep(db,users,local,remote);assert.equal(sent.length,count);
  }finally{db.close();}
});
