import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileOptimisticTurns } from './src/hooks/useOptimisticTurns.ts';

test('optimistic sends survive stale snapshots, reconcile once by id and respect queued sends', () => {
  const local = { id: 'sent', seq: 2, status: 'running', optimistic: true };
  const pending = new Map([[local.id, local]]);
  const prior = { id: 'prior', seq: 1, status: 'done' };
  assert.deepEqual(reconcileOptimisticTurns(pending, [prior]), [prior, local]);
  const accepted = { ...local, status: 'running' };
  reconcileOptimisticTurns(pending, [accepted], false);
  assert.equal(pending.size, 1, 'POST acceptance must survive an older in-flight GET');
  assert.equal(reconcileOptimisticTurns(pending, [prior]).length, 2);
  const reconciled = reconcileOptimisticTurns(pending, [prior, { ...local, status: 'done' }]);
  assert.equal(reconciled.filter(row => row.id === local.id).length, 1);
  assert.equal(reconciled.at(-1)?.status, 'done'); assert.equal(pending.size, 0);
  assert.equal(reconcileOptimisticTurns(pending, [prior]).length, 1, 'Acknowledged turns cannot reappear');
  pending.set(local.id, { ...local, status: 'queued' });
  assert.equal(reconcileOptimisticTurns(pending, [{ ...local, status: 'queued' }])[0].status, 'queued');
  pending.set(local.id, local);
  assert.equal(reconcileOptimisticTurns(pending, [{ ...local, status: 'queued' }])[0].status, 'queued', 'Server queue placement wins over optimistic Working');
  pending.set(local.id, local); pending.delete(local.id);
  assert.deepEqual(reconcileOptimisticTurns(pending, []), [], 'Rejected sends leave no optimistic bubble');
});
