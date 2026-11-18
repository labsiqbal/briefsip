import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { HarnessRuntime } from '../shared/runtime.ts';

export function findHostHarness(runtime: HarnessRuntime) {
  const names = runtime === 'hermes' ? ['hermes-acp', 'hermes'] : runtime === 'antigravity' ? ['agy', 'antigravity'] : [runtime];
  for (const name of names) {
    for (const directory of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
      const path = join(directory, name);
      try {
        accessSync(path, constants.X_OK);
        if (statSync(path).isFile()) return path;
      } catch { /* Continue PATH lookup. */ }
    }
  }
}
