import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, splitDiffLines } from './src/diff-lines.ts';
test('diff gutters distinguish metadata, real hunk contents and missing newline markers', () => {
  const text = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -3,2 +3,3 @@\n-old\n---old dash\n+new\n+++new plus\n+last\n\\ No newline at end of file\n';
  const lines = diffLines(text);
  assert.equal(lines[2].kind, 'meta'); assert.equal(lines[4].old, '3'); assert.equal(lines[5].old, '4'); assert.equal(lines[7].next, '4'); assert.equal(lines[9].kind, 'meta');
  const split = splitDiffLines(text);
  assert.equal(split[4].left?.text, '-old'); assert.equal(split[4].right?.text, '+new'); assert.equal(split[6].left, undefined); assert.equal(split[6].right?.next, '5');
});
test('split diffs preserve context and restart numbering per hunk/file', () => {
  const rows = splitDiffLines('@@ -1 +1 @@\n context\n@@ -9,0 +10,1 @@\n+new\ndiff --git a/b b/b\n+++ b/b\n@@ -0,0 +1 @@\n+first\n');
  assert.equal(rows[1].left?.old, '1'); assert.equal(rows[3].right?.next, '10'); assert.equal(rows.at(-1)?.right?.next, '1');
});
