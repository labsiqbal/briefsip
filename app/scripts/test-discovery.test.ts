import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTestCoverage, discoverTests } from './test.mjs';

test('discovery covers nested and new tests, excludes opt-in/dependencies, and rejects omissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'minarbot-test-discovery-'));
  const add = (file: string) => writeFileSync(join(root, file), '');
  try {
    for (const dir of ['hub', 'scripts', 'node_modules/pkg', 'hub/node_modules/pkg']) mkdirSync(join(root, dir), { recursive: true });
    for (const file of ['test.ts', 'transcript.test.ts', 'hub/web.test.ts', 'scripts/with space.test.ts', 'agent-desktop.integration.test.ts', 'hub/external.integration.test.ts', 'node_modules/pkg/ignored.test.ts', 'hub/node_modules/pkg/ignored.test.ts', 'helper.ts']) add(file);
    const selected = discoverTests(root);
    assert.deepEqual(selected, ['hub/web.test.ts', 'scripts/with space.test.ts', 'test.ts', 'transcript.test.ts']);
    assertTestCoverage(root, selected);
    add('hub/unlisted.test.ts');
    assert.throws(() => assertTestCoverage(root, selected), /Test omitted: hub\/unlisted\.test\.ts\. Include it in discovery or rename it to \*\.integration\.test\.ts for opt-in\./);
    const updated = discoverTests(root);
    assert(updated.includes('hub/unlisted.test.ts'));
    assertTestCoverage(root, updated);
    assert.throws(() => assertTestCoverage(root, updated.filter(file => file !== 'test.ts')), /Test omitted: test\.ts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
