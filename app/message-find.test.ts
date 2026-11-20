import assert from 'node:assert/strict';
import test from 'node:test';
import { matchOffsets } from './src/ui/transcript.ts';

test('find matches literal text, case, Unicode and repeat occurrences', () => {
  assert.deepEqual(matchOffsets('Table table TABLE', 'table'), [{ start: 0, end: 5 }, { start: 6, end: 11 }, { start: 12, end: 17 }]);
  assert.deepEqual(matchOffsets('a.*b aXb', 'a.*b'), [{ start: 0, end: 4 }]);
  assert.deepEqual(matchOffsets('[x] \\ $', '[x]'), [{ start: 0, end: 3 }]);
  assert.deepEqual(matchOffsets('İris Iris Kelvin', 'k'), [{ start: 10, end: 11 }]);
  assert.deepEqual(matchOffsets('hello', ''), []);
  assert.deepEqual(matchOffsets('hello', '   '), []);
});

test('work log titles hide protocol separators without dropping tool identity', async () => {
  const { toolTitle } = await import('./src/ui/transcript.ts');
  assert.equal(toolTitle('create_text_file'), 'Create text file');
  assert.equal(toolTitle('mcp__minarbot__read_workspace_file'), 'Read workspace file');
  assert.equal(toolTitle('shell-command'), 'Shell command');
});
