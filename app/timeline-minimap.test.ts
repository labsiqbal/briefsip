// Adapted from T3 minimap tests (MIT); see app/t3/provenance.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveTimelineMinimapItems, resolveTimelineMinimapPreview, resolveTimelineMinimapHeightStyle, resolveTimelineMinimapIndexFromPointer, resolveTimelineMinimapTopPercent } from './src/ui/timelineMinimapItems.ts';

test('minimap contains human turns in order, including attachment-only turns, without agent deliveries', () => {
  const turns = [
    { id: 'one', text: '', reply: null },
    { id: 'child', text: 'delegated task', reply: 'child reply', parent: 'one' },
    { id: 'peer', text: 'peer message', reply: 'delivery', messageOrigin: { kind: 'peer' } },
    { id: 'report', text: '', reply: 'routine result', routineReport: { run: 'run' } },
    { id: 'two', text: 'Question', reply: 'Final answer', partial: { text: 'Earlier partial' } },
    { id: 'three', text: 'Next question', reply: null, partial: { text: 'Streaming answer' } },
  ];
  assert.deepEqual(deriveTimelineMinimapItems(turns), [
    { id: 'one', rowIndex: 0, userText: '', assistantText: null },
    { id: 'two', rowIndex: 4, userText: 'Question', assistantText: 'Final answer' },
    { id: 'three', rowIndex: 5, userText: 'Next question', assistantText: 'Streaming answer' },
  ]);
  assert.equal(resolveTimelineMinimapPreview(deriveTimelineMinimapItems(turns)[0])?.userText, null);
});

test('room turns use final assistant reply and update preview during streaming', () => {
  const room = { root: 'root', messages: [{ kind: 'request', text: 'Agent request' }, { kind: 'reply', text: 'First' }, { kind: 'reply', text: 'Last answer' }] };
  const turns = [{ id: 'root', text: 'Human brief', reply: 'First', room }, { id: 'child', text: 'Internal brief', reply: 'Last answer', room }];
  assert.deepEqual(deriveTimelineMinimapItems(turns), [{ id: 'root', rowIndex: 0, userText: 'Human brief', assistantText: 'Last answer' }]);
  assert.equal(deriveTimelineMinimapItems([...turns, { id: 'live', text: '', reply: null, partial: { text: 'Growing reply' }, room }])[0].assistantText, 'Growing reply');
  assert.equal(deriveTimelineMinimapItems([turns[1]])[0].id, 'child', 'Orphaned room root on paged history remains reachable');
});

test('preview compacts user text and renders Markdown text without link destinations', () => {
  const preview = (assistantText: string | null, userText = '  A\n question  ') => resolveTimelineMinimapPreview({ id: 'one', rowIndex: 0, userText, assistantText });
  assert.equal(resolveTimelineMinimapPreview(null), null);
  assert.deepEqual(preview('## Answer\n\n**Ready** and [Docs](https://example.test/private).\n\n- One\n- Two\n\n`code` &amp; text'), { id: 'one', rowIndex: 0, userText: 'A question', assistantText: 'Answer Ready and Docs. One Two code & text' });
  assert.equal(preview('  ')?.assistantText, null);
  assert.equal(preview('x'.repeat(2000))?.assistantText?.length, 1500);
  assert.equal(preview('| Name | Value |\n| --- | --- |\n| A | B |')?.assistantText, 'Name Value A B');
  assert.equal(preview('<img src="https://tracker.test">')?.assistantText, '<img src="https://tracker.test">', 'Match Briefsip Markdown: raw HTML stays inert text');
});

test('T3 rail geometry keeps 8px pitch, bounds pointer and keyboard positions', () => {
  assert.equal(resolveTimelineMinimapHeightStyle(4), 'min(24px, max(4rem, calc(100% - 14.75rem)))');
  assert.equal(resolveTimelineMinimapTopPercent(2, 5), 50);
  assert.equal(resolveTimelineMinimapTopPercent(-1, 5), 0);
  assert.equal(resolveTimelineMinimapTopPercent(9, 5), 100);
  assert.equal(resolveTimelineMinimapTopPercent(0, 1), 0);
  assert.equal(resolveTimelineMinimapIndexFromPointer(0, 20, 80, 30), null);
  assert.equal(resolveTimelineMinimapIndexFromPointer(4, 20, 0, 30), null);
  assert.equal(resolveTimelineMinimapIndexFromPointer(5, 20, 80, 60), 2);
  assert.equal(resolveTimelineMinimapIndexFromPointer(5, 20, 80, -20), 0);
  assert.equal(resolveTimelineMinimapIndexFromPointer(5, 20, 80, 200), 4);
});
