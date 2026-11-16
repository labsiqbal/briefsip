import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const { stageRuntime, assertRelativeImports } = await import(new URL('../scripts/release.mjs', import.meta.url).href);

test('every runtime import resolves inside the shipped release selection', () => {
  const stage = mkdtempSync(join(tmpdir(), 'briefsip-runtime-'));
  try {
    stageRuntime(fileURLToPath(new URL('./', import.meta.url)), stage);
    assert.doesNotThrow(() => assertRelativeImports(stage));
  } finally { rmSync(stage, { recursive: true, force: true }); }
});
