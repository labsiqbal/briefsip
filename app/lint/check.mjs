import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { browserSafeModules } from '../eslint.config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root });
let checks = 0;
async function check(code, file, rule) {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, file) });
  if (rule) assert(result.messages.some(message => message.ruleId === rule), `${file}: expected ${rule} for ${code}\n${JSON.stringify(result.messages)}`);
  else assert.equal(result.errorCount, 0, `${file}: ${code}\n${JSON.stringify(result.messages)}`);
  checks++;
}
const boundary = 'briefsip/client-server-boundary', builtin = '@typescript-eslint/no-restricted-imports';
for (const [file, prefix] of [['src/lint-probe.ts', '../'], ['src/hub/lint-probe.ts', '../../'], ['src/ui/lint-probe.ts', '../../']]) {
  for (const code of ["import fs from 'node:fs';", "import 'fs';", "import 'fs?raw';", "export * from 'fs/promises';", "import { type Stats, readFile } from 'fs';"])
    await check(code, file, builtin);
  for (const code of ["import('node:fs');", "import(`fs`);", "require('fs/promises');", "import fs = require('node:fs');", 'import(modulePath);'])
    await check(code, file, boundary);
  for (const specifier of [`${prefix}server.ts`, `${prefix}hub/server`, `${prefix}./server.ts`, `${prefix}server.ts?raw`, '/server.ts'])
    for (const code of [`import '${specifier}';`, `export * from '${specifier}';`, `import('${specifier}');`])
      await check(code, file, boundary);
  for (const code of ["import type { Stats } from 'node:fs';", "import { type Stats } from 'fs';", `import type { App } from '${prefix}server.ts';`, `export type * from '${prefix}server.ts';`, `import { type App } from '${prefix}server.ts';`, `import { diffLines, type DiffLine } from '${prefix}diff-lines';`, "import './local';", "import type { App } from 'node:sqlite';"])
    await check(code, file);
}
await check("import { Button } from '../ui/kit';", 'src/hub/probe.ts');
await check("import 'node:fs';", 'server.ts');
await check("import '../server.ts';", 'hub/probe.ts');
for (const module of browserSafeModules) {
  await check("import 'node:fs';", module, builtin);
  await check("import './server.ts';", module, boundary);
  await check("import '@clerk/backend';", module, boundary);
}
await check("import { parseDocument } from 'yaml';", 'skill-files.ts');
await check('debugger;', 'hub/probe.ts', 'no-debugger');
await check('function probe() { return; throw new Error(); }', 'server.ts', 'no-unreachable');

// Re-audit the only package reachable from shared root modules using its browser entry.
const packageFiles = new Set();
function visit(file) {
  if (packageFiles.has(file)) return;
  packageFiles.add(file);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function walk(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) specifier = node.arguments[0];
    if (specifier) {
      assert(ts.isStringLiteral(specifier) && specifier.text.startsWith('.'), `Unexpected browser package import in ${file}: ${specifier.getText(source)}`);
      visit(resolve(dirname(file), specifier.text));
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
}
const yaml = resolve(root, 'node_modules/yaml'), exports = JSON.parse(readFileSync(resolve(yaml, 'package.json'), 'utf8')).exports;
visit(resolve(yaml, exports['.'].default));

const rules = new Set();
async function countRules(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['dist', 'node_modules'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await countRules(path);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
      const config = await eslint.calculateConfigForFile(path);
      for (const [rule, setting] of Object.entries(config?.rules ?? {})) if ((Array.isArray(setting) ? setting[0] : setting) !== 0) rules.add(rule);
    }
  }
}
await countRules(root);
console.log(`Lint foundation: ${checks} assertions passed; ${browserSafeModules.length} shared modules guarded; yaml browser graph ${packageFiles.size} files; ${rules.size} enforced rules: ${[...rules].sort().join(', ')}.`);
