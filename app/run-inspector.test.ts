import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeRunSteps, turnActivitySteps } from './src/ui/transcript.ts';
import type { StreamSegment } from './shared/turn-stream.ts';

const segment = (id: string, text: string, kind: StreamSegment['kind'] = 'tool', state = 'completed', seq = 1): StreamSegment => ({
  id, text, kind, state, seq, ordinal: 0, final: 0, revision: 1,
});

test('work log keeps narration and hides internal events and verification artifacts', () => {
  const rows = turnActivitySteps({
    status: 'done',
    activity: {
      calls: [], tools: [], fallback_model: null,
      artifacts: [{ id: 'report', name: 'test-summary.md', kind: 'check', url: '/report' }],
      stream: [
        segment('tool-user', 'userMessage'),
        segment('narration', 'Creating and checking the file.', 'text'),
        segment('tool-verification-reminder', 'Verify result', 'tool', 'requested'),
        segment('tool-verify', 'verify_result'),
      ],
      harness: [
        { id: 'user', name: 'userMessage', state: 'completed' },
        { id: 'reason', name: 'reasoning', state: 'completed' },
      ],
    },
  }, 'Agent');
  assert.deepEqual(rows.map(row => [row.text, row.state, row.prose]), [
    ['Creating and checking the file.', undefined, true],
    ['Verify result', 'Completed', undefined],
  ]);
});

test('work log dedupes native and journal receipts while preserving repeated calls', () => {
  const tools = [
    { id: 'journal-1', name: 'run_shell', failed: 0 },
    { id: 'journal-2', name: 'run_shell', failed: 1 },
    { id: 'third', name: 'create_text_file', title: 'Created hello.txt', failed: 0 },
  ];
  const harness = ['native-1', 'native-2'].map(id => ({ id, name: 'run_shell', state: 'completed' }));
  const rows = turnActivitySteps({
    status: 'done',
    activity: {
      calls: [], tools, harness, fallback_model: null,
      stream: [
        segment('tool-native-1', 'run_shell'),
        segment('tool-native-1', 'run_shell', 'tool', 'completed', 2),
        segment('tool-native-2', 'run_shell'),
      ],
    },
  }, 'Agent');
  assert.deepEqual(rows.map(row => [row.stepId, row.text, row.state]), [
    ['native-1', 'Run shell', 'Completed'],
    ['native-2', 'Run shell', 'Failed'],
    ['third', 'Created hello.txt', 'Completed'],
  ]);
  assert.deepEqual(mergeRunSteps(tools, harness).map(row => row.id), rows.map(row => row.stepId));
});
