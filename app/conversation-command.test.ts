import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { restoreChatCommand, restoreChannelCommand } from './src/conversation-command.ts';

test('chat recovery preserves exact retry identity and refuses corrupt or misrouted commands', () => {
  const command = { id: randomUUID(), text: 'Keep original text', files: [randomUUID()] };
  assert.equal(restoreChatCommand(null, false), null);
  assert.deepEqual(restoreChatCommand(JSON.stringify({ ...command, text: '' }), false), { ...command, text: '' });
  assert.deepEqual(restoreChatCommand(JSON.stringify(command), false), command);
  const routed = { ...command, recipient: randomUUID() };
  assert.deepEqual(restoreChatCommand(JSON.stringify(routed), true), routed);
  assert.deepEqual(restoreChatCommand(JSON.stringify({ ...command, automatic: true }), true), { ...command, automatic: true });
  for (const raw of ['{broken', 'null', '[]', JSON.stringify({ ...command, id: 'bad' }), JSON.stringify({ ...command, text: '', files: [] }), JSON.stringify({ ...command, files: ['bad'] }), JSON.stringify({ ...command, files: Array(5).fill(randomUUID()) }), JSON.stringify({ ...command, automatic: true, recipient: randomUUID() })]) assert.throws(() => restoreChatCommand(raw, false));
  assert.deepEqual(restoreChatCommand(JSON.stringify(command), true), command);
  assert.throws(() => restoreChatCommand(JSON.stringify(routed), false));
});

test('channel recovery preserves create/edit payload and rejects unreadable or incomplete commands', () => {
  const member = randomUUID(), command = { id: randomUUID(), name: 'Team', instructions: 'Work together', members: [member], lead: member };
  assert.equal(restoreChannelCommand(null, false), null);
  assert.deepEqual(restoreChannelCommand(JSON.stringify(command), false), command);
  const edit = { ...command, revision: 3, archived: false };
  assert.deepEqual(restoreChannelCommand(JSON.stringify(edit), true), edit);
  for (const value of [null, [], { ...command, id: 'bad' }, { ...command, members: [] }, { ...command, lead: randomUUID() }, { ...command, instructions: '' }, { ...command, extra: true }, edit]) assert.throws(() => restoreChannelCommand(JSON.stringify(value), false));
  assert.throws(() => restoreChannelCommand(JSON.stringify(command), true));
  assert.throws(() => restoreChannelCommand('{broken', false));
});
