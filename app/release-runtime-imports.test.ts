import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const { stageRuntime } = await import(new URL('../scripts/release.mjs', import.meta.url).href);

test('release stages Rust runtime inputs and T3 notices without Node source', () => {
  const stage = mkdtempSync(join(tmpdir(), 'briefsip-runtime-'));
  try {
    stageRuntime(fileURLToPath(new URL('./', import.meta.url)), stage);
    assert.deepEqual(readdirSync(join(stage, 'app')), ['shared-data-worker.py']);
    assert.deepEqual(readFileSync(join(stage, 'app/shared-data-worker.py')), readFileSync(new URL('./shared-data-worker.py', import.meta.url)));
    assert.deepEqual(readdirSync(join(stage, 't3')).sort(), ['NOTICE', 'provenance.json']);
  } finally { rmSync(stage, { recursive: true, force: true }); }
});
