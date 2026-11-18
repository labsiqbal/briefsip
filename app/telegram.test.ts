import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectorApp, telegramUpdate, waitFor } from './test-support/rust-connector-fixture.ts';
import { runRustConnector } from './rust-connectors-runner.ts';
import { connectorJournalCommand, openConnectorJournalFixture } from './test-support/connector-journal-command.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

test('Telegram question buttons answer the owning task once across restart and lost responses',async()=>{
  const root=mkdtempSync(join(tmpdir(),'briefsip-question-buttons-')),agent=randomUUID(),providerAnswers:string[]=[];
  const choices=Array.from({length:8},(_,i)=>`${i+1} ${'Long choice '.repeat(10)}${i}`);
  let sequence=0,free=false;
  const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const data=JSON.parse(raw),answer=data.messages.findLast((item:any)=>item.role==='tool');if(answer)providerAnswers.push(JSON.parse(answer.content).answer);res.end(JSON.stringify({choices:[{finish_reason:answer?'stop':'tool_calls',message:answer?{content:'Answered '+JSON.parse(answer.content).answer}:{tool_calls:[{id:'question',type:'function',function:{name:'ask_user',arguments:JSON.stringify({question:'Choose',choices:free?[]:choices})}}]}}]}));});
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();assert(address&&typeof address!=='string');
  const f=await connectorApp('telegram',root,agent,{baseURL:`http://127.0.0.1:${address.port}/v1`});
  const {connector,ui}=f;
  const db=openConnectorJournalFixture('telegram',connector.directory);
  const sent=()=>connector.jsonPosts<any>('sendMessage');
  const answers=()=>connector.requests.filter(req=>req.method==='POST'&&req.path.endsWith('/answer'));
  const until=<T>(check:()=>T)=>waitFor(()=>{connector.check();return check();},'Question case did not settle');
  const callback=(id:string)=>db.prepare('SELECT * FROM telegram_callbacks WHERE notice=?').get(id);
  async function click(question:{id:string;message:number},index:number,change:Record<string,unknown>={}){
    const id=++sequence;
    await connector.send({update_id:id,callback_query:{id:`query-${id}`,data:`q:${question.id}:${index}`,from:{id:4,is_bot:false},message:{message_id:question.message,chat:{id:4,type:'private'},from:{id:123,is_bot:true}},...change}});
  }
  async function ask(){
    const id=++sequence;
    await connector.send(telegramUpdate(id,`Ask ${id}`));
    const q=await until(()=>db.prepare("SELECT q.*,o.message_ids FROM telegram_questions q JOIN telegram_inbox i ON i.turn=q.turn JOIN telegram_outbox o ON o.id=q.id WHERE i.update_id=? AND o.status='sent'").get(id));
    return {id:String(q.id),turn:String(q.turn),thread:String(q.thread),message:JSON.parse(String(q.message_ids)).at(-1),notice:sent().find(item=>item.text.includes(String(q.id)))};
  }
  try{
    connector.start();
    const q=await ask();
    assert.equal(q.notice.reply_markup.inline_keyboard.length,8);
    assert(q.notice.text.includes(choices[7]));
    assert(q.notice.reply_markup.inline_keyboard[7][0].text.endsWith('...'));
    assert(Buffer.byteLength(q.notice.reply_markup.inline_keyboard[7][0].callback_data)<=64);
    await click(q,8);await click(q,0,{from:{id:5,is_bot:false}});await click(q,0,{data:`a:${q.id}:y`});
    await click(q,0,{message:{message_id:q.message+1,chat:{id:4,type:'private'},from:{id:123,is_bot:true}}});
    assert.equal(answers().length,0);
    assert.equal(callback(q.id),undefined);
    connector.faults.push({method:'POST',path:/\/answer$/,after:true});
    await click(q,7);
    assert.equal(callback(q.id)?.selection,7);
    await connector.expectedFailure(/Local agent request failed/);
    connector.start();await click(q,0);
    await until(()=>sent().some(post=>post.text==='Answered '+choices[7]));
    assert.deepEqual(providerAnswers,[choices[7]]);
    assert.equal(answers().length,2);assert.deepEqual(answers()[0],answers()[1]);
    assert.equal(JSON.parse(answers()[0].bytes.toString()).text,choices[7]);
    assert(answers()[0].path.includes(`/threads/${q.thread}/turns/${q.turn}/`));
    await click(q,7);assert.equal(answers().length,2);

    const revoked=await ask();
    await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:1,enabled:false});
    await click(revoked,1);await connector.expectedFailure(/403/);
    assert.equal(callback(revoked.id)?.status,'queued');
    assert.equal(providerAnswers.length,1);
    await ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:2,enabled:true});
    connector.start();await until(()=>providerAnswers.length===2);
    assert.equal(providerAnswers[1],choices[1]);
    const cancelled=await ask();
    await ui(`/api/threads/${cancelled.thread}/turns/${cancelled.turn}/cancel`,{id:randomUUID()});
    await click(cancelled,2);await until(()=>sent().some(item=>item.text.includes('Answer could not be applied')));
    free=true;const custom=await ask();
    assert.equal(custom.notice.reply_markup,undefined);await click(custom,0);
    assert.equal(callback(custom.id),undefined);
  }finally{db.close();await f.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
});

test('Telegram offline recovery preserves sent parts and rejects repeated operator decisions', async () => {
  const root=mkdtempSync(join(tmpdir(),'briefsip-telegram-recovery-')),id=randomUUID(),calls:any[]=[];
  let lost=true;
  const fixture=await connectorApp('telegram',root,randomUUID(),{remote:(_method,raw,req)=>{
    const body=JSON.parse(raw.toString());calls.push(body);
    if(calls.length>1&&lost){req.socket.destroy();return;}
    return {message_id:calls.length,chat:{id:4}};
  }});
  const {connector}=fixture;
  const command=connectorJournalCommand('telegram',connector.directory);
  const db=openConnectorJournalFixture('telegram',connector.directory);
  const add=(id:string,text:string)=>db.prepare("INSERT INTO telegram_outbox(id,chat,reply_to,text,status) VALUES(?,4,2,?,'queued')").run(id,text);
  const settle=async(status:string)=>{connector.start();await waitFor(()=>{connector.check();return db.prepare('SELECT status FROM telegram_outbox WHERE id=?').get(id)?.status===status;},`Reply did not become ${status}`);await connector.stop();};
  try{
    add(id,'a'.repeat(4096)+'tail');await settle('uncertain');
    let inspected=JSON.parse(command('inspect',id).stdout);assert.equal(inspected.reply.status,'uncertain');assert.equal(inspected.reply.part,1);assert.equal(inspected.revision,0);
    assert.equal(command('recover',id,'0','retry').status,1);assert.equal(command('recover',id,'1','retry','--accept-duplicate-risk').status,1);
    assert.equal(command('recover',id,'0','retry','--accept-duplicate-risk').status,0);
    await settle('uncertain');assert.equal(calls.length,3);assert.equal(calls[2].text,'tail');
    assert.equal(command('recover',id,'0','retry','--accept-duplicate-risk').status,1);
    inspected=JSON.parse(command('inspect',id).stdout);assert.equal(inspected.revision,1);assert.equal(inspected.decisions[0].status,'uncertain');assert.equal(inspected.decisions[0].part,1);
    lost=false;assert.equal(command('recover',id,'1','retry','--accept-duplicate-risk').status,0);
    await settle('sent');
    inspected=JSON.parse(command('inspect',id).stdout);assert.equal(inspected.reply.status,'sent');assert.equal(inspected.reply.message_ids,'[1,4]');assert.equal(calls[3].text,'tail');
    assert.equal(command('recover',id,'2','retry','--accept-duplicate-risk').status,1);
    const rejected=randomUUID();add(rejected,'Rejected');db.prepare("UPDATE telegram_outbox SET status='failed',error='Rejected' WHERE id=?").run(rejected);
    assert.equal(command('recover',rejected,'0','discard').status,1);assert.equal(command('recover',rejected,'0','discard','--confirm').status,0);
    inspected=JSON.parse(command('inspect',rejected).stdout);assert.equal(inspected.reply.status,'discarded');assert.equal(inspected.decisions[0].error,'Rejected');
    connector.start();await connector.send(telegramUpdate(1,'/status'));
    await waitFor(()=>{connector.check();return db.prepare("SELECT 1 FROM telegram_outbox WHERE id<>? AND id<>? AND status='sent'").get(id,rejected);},'Connector did not settle probe');
    await connector.stop();assert.equal(calls.filter(row=>row.text==='Rejected').length,0);
    assert.equal(command('recover',rejected,'1','retry','--accept-duplicate-risk').status,1);
    const interrupted=randomUUID();add(interrupted,'Interrupted');db.prepare("UPDATE telegram_outbox SET status='sending' WHERE id=?").run(interrupted);
    inspected=JSON.parse(command('inspect',interrupted).stdout);assert.equal(inspected.reply.status,'uncertain');assert.equal(inspected.revision,0);
    assert.equal(command('recover',interrupted,'0','discard','--confirm').status,0);
  }finally{db.close();await fixture.close();rmSync(root,{recursive:true,force:true});}
});

test('Telegram bridge submits once through granted side-thread API and isolates main history', async () => {
  const root=mkdtempSync(join(tmpdir(),'briefsip-telegram-')),agent=randomUUID();
  let calls=0,parts=0;
  const provider=createServer(async(req,res)=>{for await(const _ of req){}calls++;res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Synthetic reply'}}]}));});
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const address=provider.address();assert(address&&typeof address!=='string');
  const f=await connectorApp('telegram',root,agent,{baseURL:`http://127.0.0.1:${address.port}/v1`,remote:async(method,raw)=>{
    const body=JSON.parse(raw.toString());
    if(method==='sendMessage'&&body.text.startsWith('xxxx')){
      parts++;
      await f.ui(`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:1,enabled:false});
      return {message_id:100,chat:{id:4}};
    }
  }});
  const {connector,ui}=f;
  const db=openConnectorJournalFixture('telegram',connector.directory);
  const update=telegramUpdate(1,'Hello');update.message.message_id=2;
  const sent=()=>connector.jsonPosts<{text:string}>('sendMessage').filter(post=>post.text==='Synthetic reply');
  const turns=()=>connector.requests.filter(req=>req.method==='POST'&&req.path.endsWith('/turns'));
  try{
    connector.faults.push({method:'POST',path:/\/turns$/,after:true});
    connector.start();await connector.send(update);
    await connector.expectedFailure(/Local agent request failed/);
    connector.start();await waitFor(()=>{connector.check();return sent().length===1;},'Telegram reply was not delivered');
    assert.equal(calls,1);assert.equal(turns().length,2);assert.deepEqual(turns()[0],turns()[1]);
    assert.deepEqual(await ui(`/api/agents/${agent}/turns`),[]);
    await connector.stop();

    connector.start();await connector.push(update);
    await connector.send(telegramUpdate(3,'/status'));
    await waitFor(()=>{connector.check();return db.prepare("SELECT 1 FROM telegram_outbox WHERE reply_to=3 AND text LIKE 'No active tasks%' AND status='sent'").get();},'Status probe failed');
    assert.equal(sent().length,1);assert.equal(calls,1);
    const pending=randomUUID();
    db.prepare("INSERT INTO telegram_outbox(id,chat,reply_to,text,status) VALUES(?,4,2,?,'queued')").run(pending,'x'.repeat(4097));
    await connector.expectedFailure(/403/);assert.equal(parts,1);
    const paused=db.prepare('SELECT status,part FROM telegram_outbox WHERE id=?').get(pending)!;
    assert.equal(paused.status,'queued');assert.equal(paused.part,1);
    connector.start();await connector.expectedFailure(/403/);
    assert.equal(sent().length,1);assert.equal(parts,1);
  }finally{db.close();await f.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
});

test('Rust Telegram runner rejects a mismatched bot identity and releases its journal lock', async () => {
  const {mkdtempSync,rmSync,existsSync} = await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const root=mkdtempSync(join(tmpdir(),'briefsip-telegram-lock-'));
  const server=createServer((_req,res)=>res.end(JSON.stringify({ok:true,result:{id:124,is_bot:true}})));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');
  try{
    await assert.rejects(runRustConnector('telegram', {directory:join(root,'mismatch'),scriptDirectory:join(root,'absent'),agent:randomUUID(),token:'123:'+'x'.repeat(24),users:[4],origin:`http://127.0.0.1:${address.port}`},new AbortController().signal),/identity mismatch/);
    assert(!existsSync(join(root,'mismatch','owner.lock')));
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
});

for(const ask of [false,true])test(`Telegram runner ${ask?'answers a question':'replies directly'} and releases owned journal on shutdown`,async()=>{
  const {mkdtempSync,rmSync,existsSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {startApp}=await import('./test-bridge.ts');
  const root=mkdtempSync(join(tmpdir(),'briefsip-telegram-run-')),agent=randomUUID(),controller=new AbortController();
  let modelCalls=0,delivered=0;let answerUpdate:any;const offsets:number[]=[];
  const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const data=JSON.parse(raw);modelCalls++;const question=ask&&!data.messages.some((message:any)=>message.role==='tool');res.end(JSON.stringify({choices:[{finish_reason:question?'tool_calls':'stop',message:question?{tool_calls:[{id:'question',type:'function',function:{name:'ask_user',arguments:JSON.stringify({question:'Proceed?',choices:['Yes','No']})}}]}:{content:'Runner reply'}}]}));});
  const telegram=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);let result:any;
    if(req.url?.endsWith('/getMe'))result={id:123,is_bot:true};
    else if(req.url?.endsWith('/getUpdates')){offsets.push(body.offset);result=body.offset<8?[{update_id:7,message:{message_id:8,chat:{id:4,type:'private'},from:{id:4,is_bot:false},text:'Runner request'}}]:answerUpdate&&body.offset<9?[answerUpdate]:[];}
    else{assert.equal(body.chat_id,4);delivered++;result={message_id:20+delivered,chat:{id:4}};if(body.text.includes('/answer ')){const id=/\/answer ([a-f0-9-]{36})/.exec(body.text)![1];answerUpdate={update_id:8,message:{message_id:10,chat:{id:4,type:'private'},from:{id:4,is_bot:false},text:`/answer ${id} Yes`}};}else if(body.text==='Runner reply')setTimeout(()=>controller.abort(),30);else assert.equal(body.text,'Answer accepted.');}
    res.end(JSON.stringify({ok:true,result}));});
  await Promise.all([new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve)),new Promise<void>(resolve=>telegram.listen(0,'127.0.0.1',resolve))]);
  const pa=provider.address(),ta=telegram.address();assert(pa&&typeof pa!=='string'&&ta&&typeof ta!=='string');
  const app=await startApp({database:join(root,'app.sqlite'),baseURL:`http://127.0.0.1:${pa.port}/v1`,scriptDirectory:join(root,'scripts')});
  const timeout=setTimeout(()=>controller.abort(),10000);
  try{
    for(const [path,body]of [['/api/agents',{runtime:'api', id:agent,name:'Runner',model:'fixture',instructions:'Help'}],[`/api/agents/${agent}/scripts`,{id:randomUUID(),revision:0,enabled:true}]]as const){const response=await fetch(app.origin+path,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});assert(response.ok);await response.json();}
    await runRustConnector('telegram', {directory:join(root,'state'),scriptDirectory:join(root,'scripts'),agent,token:'123:'+'x'.repeat(24),users:[4],origin:`http://127.0.0.1:${ta.port}`},controller.signal);
    assert.equal(modelCalls,ask?2:1);assert.equal(delivered,ask?3:1);assert(offsets.includes(8));assert(!existsSync(join(root,'state','owner.lock')));
    const journal=new DatabaseSync(join(root,'state','telegram.sqlite'));try{assert.equal(journal.prepare('SELECT status FROM telegram_outbox').get()!.status,'sent');}finally{journal.close();}
  }finally{clearTimeout(timeout);controller.abort();await app.close();provider.closeAllConnections();telegram.closeAllConnections();await Promise.all([new Promise<void>(resolve=>provider.close(()=>resolve())),new Promise<void>(resolve=>telegram.close(()=>resolve()))]);rmSync(root,{recursive:true,force:true});}
});
