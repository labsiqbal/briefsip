import test from 'node:test';
import assert from 'node:assert/strict';
import { claimNotification, requestKey } from './src/hooks/useNeedsYouNotifications.ts';

test('notification claims survive reload and distinguish sequential requests and completion', () => {
  const data = new Map<string, string>();
  const storage = () => ({ getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } });
  const input = { kind: 'question' as const, turn: 'turn-1', request: 'request-1' };
  assert.equal(claimNotification(storage(), requestKey(input)), true);
  assert.equal(claimNotification(storage(), requestKey(input)), false);
  assert.equal(claimNotification(storage(), requestKey({ ...input, request: 'request-2' })), true);
  assert.equal(claimNotification(storage(), 'finished:turn-1'), true);
  assert.equal(claimNotification(storage(), 'finished:turn-1'), false);
});
