import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectorApp, slackEnvelope, waitFor } from './test-support/rust-connector-fixture.ts';
import { openConnectorJournalFixture } from './test-support/connector-journal-command.ts';

for (const shared of [false, true]) test(`Slack workflow commands bind requester root and retry run, approval and cancellation across restart (shared=${shared})`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'briefsip-slack-workflows-'));
  const agent = randomUUID(), channel = shared ? 'CROOM' : 'DCHAT';
  const f = await connectorApp('slack', directory, agent, { channels: shared ? [channel] : [] });
  const { connector, ui } = f;
  const db = openConnectorJournalFixture('slack', connector.directory);
  let sequence = 0;
  const requests = (suffix: string) => connector.requests.filter(req => req.method === 'POST' && req.path.endsWith(suffix));
  const posts = () => connector.jsonPosts<any>('chat.postMessage');
  const until = <T>(check: () => T) => waitFor(() => { connector.check(); return check(); }, 'Slack workflow did not settle');
  const delivered = (id: unknown) => until(() => db.prepare("SELECT * FROM slack_outbox WHERE id=? AND status='sent'").get(String(id)));
  async function incoming(text: string, root?: string, user = 'UUSER', dest = channel) {
    const id = ++sequence;
    await connector.send(slackEnvelope(id, shared && !root ? `<@UBOT> ${text}` : text, user, root, dest));
    return db.prepare('SELECT * FROM slack_inbox WHERE event=?').get(`Ev${id}`)!;
  }
  async function command(text: string, root?: string, user?: string, dest?: string) {
    const row = await incoming(text, root, user, dest);
    await delivered(row.turn);
    return posts().at(-1);
  }
  async function notice(run: unknown) {
    const row = await until(() => db.prepare("SELECT a.notice,a.revision,o.timestamps FROM slack_approvals a JOIN slack_outbox o ON o.id=a.notice WHERE a.run=? AND o.status='sent'").get(String(run)));
    return { id: String(row.notice), revision: row.revision, ts: JSON.parse(String(row.timestamps)).at(-1) };
  }
  function click(n: {id:string;ts:string}, yes = true) {
    const choice = yes ? 'yes' : 'no';
    return { type: 'interactive', envelope_id: `click-${++sequence}`, payload: {
      type: 'block_actions', team: { id: 'TTEAM' }, api_app_id: 'AAPP', user: { id: 'UUSER' }, channel: { id: channel },
      container: { channel_id: channel, message_ts: n.ts }, message: { user: 'UBOT', ts: n.ts },
      actions: [{ type: 'button', action_id: `briefsip_approve_${choice}`, value: `approval:${n.id}:${choice}` }],
    } };
  }
  const fault = (suffix: string, after = true) => connector.faults.push({ method: 'POST', path: new RegExp(`/${suffix}$`), after });
  async function recover() { await connector.expectedFailure(/Local agent request failed/); connector.start(); }
  try {
    const workflow = await ui(`/api/agents/${agent}/workflows`, { id: randomUUID(), revision: 0, name: 'Approval',
      graph: { entry: 'ask', maxSteps: 2, nodes: [{ id: 'ask', kind: 'approval', prompt: 'Proceed?', yes: 'out' }, { id: 'out', kind: 'output' }] } });
    connector.start();
    assert((await command('!workflows')).text.includes(workflow.id));
    fault('run');
    const start = await incoming(`!workflow ${workflow.id} 1 Exact input`);
    await recover();
    const approval = await notice(start.turn);
    assert.equal(requests('/run').length, 2);
    assert.deepEqual(requests('/run')[0], requests('/run')[1]);
    assert.equal((await ui(`/api/workflows/${workflow.id}/runs`)).length, 1);
    const buttons = posts().find(post => post.blocks)?.blocks.at(-1).elements;
    assert.equal(buttons.length, 2);
    assert.notEqual(buttons[0].action_id, buttons[1].action_id);

    const root = String(start.root);
    const cmd = `!approve ${start.turn} ${approval.revision} yes`;
    await command(cmd);
    await command(cmd, root, 'UOTHER', shared ? channel : 'DOTHER');
    await command(`!stop ${start.turn}`);
    assert.equal(requests('/approve').length + requests('/cancel').length, 0);
    assert((await command('!status', root)).text.includes(String(start.turn)));
    assert.equal(posts().filter(post => post.blocks).length, 1);

    const mutations: ((p: ReturnType<typeof click>['payload']) => void)[] = [
      p => p.user.id = 'UOTHER',
      p => p.team.id = 'TOTHER', p => p.api_app_id = 'AOTHER', p => p.message.user = 'UOTHER',
      p => p.message.ts = '1700000009.000001', p => p.channel.id = 'DOTHER',
    ];
    for (const mutate of mutations) {
      const invalid = click(approval);
      mutate(invalid.payload);
      await connector.send(invalid);
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM slack_callbacks').get()!.n, 0);
    fault('approve');
    await connector.send(click(approval));
    await recover();
    await connector.send(click(approval, false));
    await delivered(start.turn);
    assert.equal(db.prepare('SELECT accepted FROM slack_callbacks WHERE notice=?').get(approval.id)!.accepted, 1);
    assert.equal(requests('/approve').length, 2);
    assert.deepEqual(requests('/approve')[0], requests('/approve')[1]);
    assert.equal((await ui(`/api/workflow-runs/${start.turn}`)).status, 'done');
    assert(posts().some(post => post.thread_ts === root && post.text === 'Exact input'));

    const stopped = await incoming(`!workflow ${workflow.id} 1 Stop input`);
    await notice(stopped.turn);
    fault('cancel');
    const cancellation = await incoming(`!stop ${stopped.turn}`, String(stopped.root));
    await recover(); await delivered(cancellation.turn);
    assert.equal(requests('/cancel').length, 2);
    assert.deepEqual(requests('/cancel')[0], requests('/cancel')[1]);
    assert.equal((await ui(`/api/workflow-runs/${stopped.turn}`)).status, 'cancelled');

    const rejected = await incoming(`!workflow ${workflow.id} 1 Reject input`);
    const rejection = await notice(rejected.turn);
    await ui(`/api/agents/${agent}/scripts`, { id: randomUUID(), revision: 1, enabled: false });
    await connector.send(click(rejection, false));
    await connector.expectedFailure(/403/);
    assert.equal((await ui(`/api/workflow-runs/${rejected.turn}`)).status, 'approval');
    assert.equal(db.prepare('SELECT status FROM slack_callbacks WHERE notice=?').get(rejection.id)!.status, 'queued');
    await ui(`/api/agents/${agent}/scripts`, { id: randomUUID(), revision: 2, enabled: true });
    connector.start(); await delivered(rejected.turn);
    await command(`!approve ${rejected.turn} ${rejection.revision} yes`, String(rejected.root));
    assert.equal((await ui(`/api/workflow-runs/${rejected.turn}`)).status, 'failed');
    assert.equal(db.prepare('SELECT count(*) AS n FROM slack_closed_threads').get()!.n, 0);

    await connector.stop();
    const unsent = randomUUID(), stop = randomUUID(), unsentRoot = '1700000699.000001', thread = randomUUID();
    const insert = db.prepare("INSERT INTO slack_inbox(event,channel,sender,ts,root,text,thread,turn,kind) VALUES(?,?,'UUSER',?,?,?,?,?,?)");
    insert.run('EvUnsent', channel, unsentRoot, unsentRoot, `!workflow ${workflow.id} 1 Never start`, thread, unsent, 'workflow');
    insert.run('EvStop', channel, '1700000699.000002', unsentRoot, `!stop ${unsent}`, thread, stop, 'message');
    const count = requests('/run').length;
    connector.start(); await delivered(stop);
    assert.equal(requests('/run').length, count);
    assert.equal(db.prepare('SELECT status FROM slack_inbox WHERE turn=?').get(unsent)!.status, 'cancelled');

    fault('run', false);
    const before = await incoming(`!workflow ${workflow.id} 1 Not accepted`);
    await connector.expectedFailure(/Local agent request failed/);
    const failStop = randomUUID();
    insert.run('EvStopBefore', channel, '1700000699.000003', before.root, `!stop ${before.turn}`, before.thread, failStop, 'message');
    connector.start(); await delivered(failStop);
    assert.equal(db.prepare('SELECT status FROM slack_inbox WHERE turn=?').get(before.turn)!.status, 'unavailable');

    for (let i = 0; i < 20; i++) await ui(`/api/agents/${agent}/workflows`, { id: randomUUID(), revision: 0, name: `Page ${i}`,
      graph: { entry: 'out', maxSteps: 1, nodes: [{ id: 'out', kind: 'output' }] } });
    const first = (await command('!workflows')).text;
    assert.equal((first.match(/!workflow /g) || []).length, 20);
    const cursor = /!workflows ([a-f0-9-]{36})/.exec(first)![1];
    assert.equal(((await command(`!workflows ${cursor}`)).text.match(/!workflow /g) || []).length, 1);
  } finally { db.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});
