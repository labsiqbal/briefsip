import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectorApp, telegramUpdate, waitFor } from './test-support/rust-connector-fixture.ts';
import { openConnectorJournalFixture } from './test-support/connector-journal-command.ts';

function approvalClick(sequence: number, notice: string, message: number, accepted: boolean, change: object = {}) {
  return { update_id: sequence, callback_query: {
    id: `click-${sequence}`, data: `a:${notice}:${accepted ? 'y' : 'n'}`, from: { id: 4, is_bot: false },
    message: { message_id: message, chat: { id: 4, type: 'private' }, from: { id: 123, is_bot: true } },
    ...change,
  } };
}

test('Telegram retains early button clicks until multipart delivery is confirmed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'briefsip-telegram-early-')), agent = randomUUID(), notice = randomUUID(), run = randomUUID();
  let release!: () => void;
  const responseGate = new Promise<void>(resolve => release = resolve);
  let part = 0, visible = false;
  const fixture = await connectorApp('telegram', root, agent, { remote: async (method, raw) => {
    if (method !== 'sendMessage') return;
    const body = JSON.parse(raw.toString());
    if (++part === 1) {
      assert.equal(body.reply_markup, undefined);
      return { message_id: 98, chat: { id: 4 } };
    }
    if (part === 2) {
      assert(body.reply_markup);
      visible = true;
      await responseGate;
      return { message_id: 99, chat: { id: 4 } };
    }
  } });
  const { connector } = fixture;
  const db = openConnectorJournalFixture('telegram', connector.directory);
  const callbacks = () => db.prepare('SELECT * FROM telegram_callbacks').all();
  try {
    db.prepare('INSERT INTO telegram_workflows VALUES (?,4,?,1)').run(run, randomUUID());
    db.prepare('INSERT INTO telegram_approvals VALUES (?,1,?)').run(run, notice);
    db.prepare("INSERT INTO telegram_outbox(id,chat,reply_to,text,status) VALUES(?,4,2,?,'queued')").run(notice, 'a'.repeat(4096) + 'Approve?');
    connector.start();
    await waitFor(() => { connector.check(); return visible; }, 'Second part not visible');
    await connector.push(approvalClick(1, notice, 99, true));
    const before = connector.polls.length;
    await waitFor(() => connector.polls.length >= before + 2, 'Connector did not poll early callback');
    assert.equal(connector.offset, 0);
    assert.equal(callbacks().length, 0);
    assert.equal(connector.posts.filter(post => post.method === 'answerCallbackQuery').length, 0);
    release();
    await waitFor(() => connector.offset === 2, 'Connector did not commit confirmed callback');
    assert.equal(callbacks().length, 1);
    assert.equal(callbacks()[0].selection, 1);
    await waitFor(() => connector.posts.some(post => post.method === 'answerCallbackQuery'), 'Connector did not acknowledge callback');
    assert.equal(callbacks().length, 1);
  } finally { release(); db.close(); await fixture.close(); rmSync(root, { recursive: true, force: true }); }
});

async function workflowFixture(root: string) {
  const agent = randomUUID();
  let ackLost = false;
  const users = [4, 5];
  let db: DatabaseSync;
  const app = await connectorApp('telegram', root, agent, { users, remote: (method, raw, req) => {
    if (method === 'answerCallbackQuery') {
      const { callback_query_id } = JSON.parse(raw.toString());
      const id = Number(callback_query_id.split('-').at(-1));
      assert(Number(db.prepare('SELECT offset FROM telegram_binding').get()!.offset) > id);
      if (ackLost) { ackLost = false; req.socket.destroy(); }
    }
  } });
  const { connector, ui } = app;
  const workflow = await ui(`/api/agents/${agent}/workflows`, { id: randomUUID(), revision: 0, name: 'Approval',
    graph: { entry: 'ask', maxSteps: 2, nodes: [{ id: 'ask', kind: 'approval', prompt: 'Proceed?', yes: 'out' }, { id: 'out', kind: 'output' }] } });
  db = openConnectorJournalFixture('telegram', connector.directory);
  const posts = () => connector.jsonPosts<any>('sendMessage');
  const requests = (suffix: string) => connector.requests.filter(req => req.method === 'POST' && req.path.endsWith(suffix));
  const until = <T>(check: () => T, description = 'Telegram workflow did not settle') => waitFor(() => { connector.check(); return check(); }, description);
  let sequence = 0;
  async function incoming(text: string, user = 4) {
    const id = ++sequence;
    await connector.send(telegramUpdate(id, text, user));
    return db.prepare('SELECT * FROM telegram_inbox WHERE update_id=?').get(id)!;
  }
  async function start(text: string) {
    const row = await incoming(`/workflow ${workflow.id} 1 ${text}`);
    return notice(row.turn);
  }
  async function notice(turn: unknown) {
    const approval = await until(() => {
      const row = db.prepare("SELECT a.notice,a.revision,o.message_ids FROM telegram_approvals a JOIN telegram_outbox o ON a.notice=o.id WHERE a.run=? AND o.status='sent'").get(String(turn));
      return row;
    });
    return { id: String(approval.notice), revision: Number(approval.revision), message: JSON.parse(String(approval.message_ids)).at(-1), run: String(turn) };
  }
  const click = (notice: {id:string;message:number}, accepted: boolean, change?: object) =>
    connector.send(approvalClick(++sequence, notice.id, notice.message, accepted, change));
  const delivered = (id: unknown) => until(() => db.prepare("SELECT 1 FROM telegram_outbox WHERE id=? AND status='sent'").get(String(id)));
  const command = async (text: string, user = 4) => { const row = await incoming(text, user); await delivered(row.turn); return posts().at(-1); };
  const lose = (suffix: string) => connector.faults.push({ method: 'POST', path: new RegExp(`/${suffix}$`), after: true });
  const restartAfterLoss = async () => { await connector.expectedFailure(/Local agent request failed/); connector.start(); };
  return { connector, db, ui, agent, users, workflow, requests, posts, until, incoming, start, notice, click, command, lose, restartAfterLoss, delivered,
    loseAck() { ackLost = true; }, async close() { db.close(); await app.close(); } };
}

test('Telegram inline approvals validate message ownership and persist the first decision before acknowledgement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'briefsip-telegram-buttons-'));
  const f = await workflowFixture(root);
  const { connector, db, ui } = f;
  try {
    connector.start();
    const notice = await f.start('Button result');
    const message = { message_id: notice.message, chat: { id: 4, type: 'private' }, from: { id: 123, is_bot: true } };
    for (const change of [
      { from: { id: 5, is_bot: false } },
      { from: { id: 5, is_bot: false }, message: { ...message, chat: { id: 5, type: 'private' } } },
      { message: { ...message, message_id: message.message_id + 1 } },
      { message: { ...message, chat: { id: 4, type: 'group' } } },
      { message: { ...message, from: { id: 999, is_bot: true } } },
      { data: `a:${randomUUID()}:y` }, { from: { id: 4, is_bot: true } },
    ]) await f.click(notice, true, change);
    assert.equal(f.requests('/approve').length, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_callbacks').get()!.n, 0);
    f.lose('approve'); f.loseAck(); await f.click(notice, true);
    const persisted = db.prepare('SELECT * FROM telegram_callbacks WHERE notice=?').get(notice.id)!;
    assert.equal(persisted.selection, 1);
    await f.restartAfterLoss();
    await f.click(notice, false);
    await f.delivered(notice.run);
    const decisions = f.requests('/approve');
    assert.equal(decisions.length, 2);
    assert.deepEqual(decisions[0], decisions[1]);
    assert.equal(JSON.parse(decisions[0].bytes.toString()).id, persisted.id);
    assert.equal((await ui(`/api/workflow-runs/${notice.run}`)).status, 'done');
    const total = f.posts().length;
    await f.click(notice, true);
    assert.equal(f.requests('/approve').length, 2);
    assert.equal(f.posts().length, total);

    const rejected = await f.start('Reject');
    await f.click(rejected, false); await f.delivered(rejected.run);
    assert.equal((await ui(`/api/workflow-runs/${rejected.run}`)).status, 'failed');
    const stale = await f.start('Stale');
    await ui(`/api/workflow-runs/${stale.run}/approve`, { id: randomUUID(), revision: stale.revision, accepted: false });
    await f.click(stale, true);
    await f.until(() => f.posts().some(item => item.text.includes('Approval could not be applied')));
    assert.equal((await ui(`/api/workflow-runs/${stale.run}`)).status, 'failed');
    const revoked = await f.start('Revoked');
    connector.faults.push({ method: 'POST', path: /\/approve$/, after: false });
    await f.click(revoked, true);
    await connector.expectedFailure(/Local agent request failed/);
    assert.equal(db.prepare('SELECT status FROM telegram_callbacks WHERE notice=?').get(revoked.id)!.status, 'queued');
    f.users.splice(f.users.indexOf(4), 1);
    connector.start();
    await f.until(() => db.prepare('SELECT status FROM telegram_callbacks WHERE notice=?').get(revoked.id)!.status === 'revoked');
    assert.equal((await ui(`/api/workflow-runs/${revoked.run}`)).status, 'approval');
    assert(connector.jsonPosts<{text:string}>('answerCallbackQuery').some(post => post.text.includes('choice was already')));
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Telegram workflow approval binds requester and recovers lost run and decision responses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'briefsip-telegram-flow-'));
  const f = await workflowFixture(root);
  const { connector, workflow, ui } = f;
  try {
    connector.start();
    assert((await f.command('/workflows')).text.includes(workflow.id));
    f.lose('run');
    const started = await f.incoming(`/workflow ${workflow.id} 1 Exact input`);
    await f.restartAfterLoss();
    const approval = await f.notice(started.turn);
    const runs = f.requests('/run');
    assert.equal(runs.length, 2);
    assert.deepEqual(runs[0], runs[1]);
    assert.equal((await ui(`/api/workflows/${workflow.id}/runs`)).length, 1);
    await f.command(`/approve ${approval.run} ${approval.revision} yes`, 5);
    assert.equal(f.requests('/approve').length, 0);
    f.lose('approve');
    const accepted = await f.incoming(`/approve ${approval.run} ${approval.revision} yes`);
    await f.restartAfterLoss();
    await f.delivered(accepted.turn); await f.delivered(approval.run);
    const decisions = f.requests('/approve');
    assert.equal(decisions.length, 2);
    assert.deepEqual(decisions[0], decisions[1]);
    assert.equal((await ui(`/api/workflow-runs/${approval.run}`)).status, 'done');
    assert(f.posts().some(row => row.chat_id === 4 && row.text === 'Exact input'));
    const stopped = await f.start('Stop input');
    await f.command(`/stop ${stopped.run}`, 5);
    assert.equal(f.requests('/cancel').length, 0);
    f.lose('cancel');
    const cancellation = await f.incoming(`/stop ${stopped.run}`);
    await f.restartAfterLoss(); await f.delivered(cancellation.turn);
    const cancels = f.requests('/cancel');
    assert.equal(cancels.length, 2);
    assert.deepEqual(cancels[0], cancels[1]);
    assert.equal((await ui(`/api/workflow-runs/${stopped.run}`)).status, 'cancelled');
    const rejected = await f.start('Reject input');
    await f.command(`/approve ${rejected.run} ${rejected.revision} no`);
    assert.equal((await ui(`/api/workflow-runs/${rejected.run}`)).status, 'failed');
    const stale = await f.command(`/approve ${rejected.run} ${rejected.revision} yes`);
    assert(stale.text.includes('Workflow request denied'));
    assert.equal((await ui(`/api/workflow-runs/${rejected.run}`)).status, 'failed');
    for (let i = 0; i < 20; i++) await ui(`/api/agents/${f.agent}/workflows`, { id: randomUUID(), revision: 0, name: `Page ${i}`,
      graph: { entry: 'out', maxSteps: 1, nodes: [{ id: 'out', kind: 'output' }] } });
    const first = (await f.command('/workflows')).text;
    assert.equal((first.match(/\/workflow /g) || []).length, 20);
    const cursor = /Next page: \/workflows ([a-f0-9-]{36})/.exec(first)![1];
    assert.equal(((await f.command(`/workflows ${cursor}`)).text.match(/\/workflow /g) || []).length, 1);
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});
