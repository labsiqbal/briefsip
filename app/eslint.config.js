import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const root = dirname(fileURLToPath(import.meta.url));
// Runtime closure of src's root imports. Every member receives the same boundary checks.
export const browserSafeModules = [
  'agent-create.ts', 'agent-template.ts', 'agent-visibility.ts', 'connected-app-command.ts',
  'conversation-command.ts', 'diff-lines.ts', 'flows.ts', 'mcp-scopes.ts', 'memory-command.ts',
  'panel-width.ts', 'presentation.ts', 'question-answer.ts', 'remote-message-command.ts',
  'site-command.ts', 'skill-command.ts', 'skill-files.ts', 'skill-pack-schema.ts', 'skill-zip.ts',
  'speech-preference.ts', 'speech.ts', 'thread-command.ts', 'turn-stream.ts', 'workflow-command.ts',
  'workflow-editor-state.ts', 'workflows.ts',
];
// yaml's default/browser export is node-free; its Node entry is not used by Vite.
const browserSafePackages = new Set(['yaml']);
const builtinPattern = `^(?:node:|(?:${[...new Set(builtinModules.map(name => name.replace(/^node:/, '').split('/')[0]))].join('|')})(?:[/?#]|$))`;
const nodeImport = new RegExp(builtinPattern);
const serverMessage = 'Server module in browser code: import its types with `import type`, or move browser-safe code into an allowlisted module.';
const nodeMessage = 'Node builtin in browser code: use a browser API, or import its types with `import type`.';
const typeOnly = node => node.importKind === 'type' || node.exportKind === 'type'
  || (node.specifiers?.length > 0 && node.specifiers.every(specifier => specifier.importKind === 'type' || specifier.exportKind === 'type'));

export const clientServerBoundary = {
  meta: { type: 'problem', schema: [], messages: { server: serverMessage, node: nodeMessage, literal: 'Use a literal module path so the browser/server boundary can be checked.' } },
  create(context) {
    // ponytail: no local import aliases today; resolve them here if Vite adds aliases.
    function check(node, source, dynamic = false) {
      const specifier = source?.type === 'TemplateLiteral' && source.expressions.length === 0 ? source.quasis[0].value.cooked : source?.value;
      if (typeof specifier !== 'string') { context.report({ node, messageId: 'literal' }); return; }
      // Static builtins are covered by no-restricted-imports (including allowTypeImports).
      if (nodeImport.test(specifier)) { if (dynamic) context.report({ node, messageId: 'node' }); return; }
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const path = specifier.split(/[?#]/)[0];
        const target = relative(root, path.startsWith('/') ? resolve(root, '.' + path) : resolve(dirname(context.filename), path)).replaceAll('\\', '/');
        if (target.startsWith('src/')) return;
        if (browserSafeModules.some(file => target === file || target === file.slice(0, -3))) return;
      } else if (!specifier.startsWith('file:') && (relative(root, context.filename).replaceAll('\\', '/').startsWith('src/') || browserSafePackages.has(specifier))) return;
      context.report({ node, messageId: 'server' });
    }
    return {
      ImportDeclaration(node) { if (!typeOnly(node)) check(node, node.source); },
      ExportNamedDeclaration(node) { if (node.source && !typeOnly(node)) check(node, node.source); },
      ExportAllDeclaration(node) { if (!typeOnly(node)) check(node, node.source); },
      ImportExpression(node) { check(node, node.source, true); },
      CallExpression(node) { if (node.callee.type === 'Identifier' && node.callee.name === 'require') check(node, node.arguments[0], true); },
      TSImportEqualsDeclaration(node) { if (node.importKind !== 'type' && node.moduleReference.type === 'TSExternalModuleReference') check(node, node.moduleReference.expression, true); },
    };
  },
};

export default [
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    languageOptions: { parser: tseslint.parser },
    rules: { 'no-debugger': 'error', 'no-unreachable': 'error' },
  },
  {
    files: ['src/**/*.{ts,tsx,mjs,js}', ...browserSafeModules],
    plugins: { '@typescript-eslint': tseslint.plugin, briefsip: { rules: { 'client-server-boundary': clientServerBoundary } } },
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [{ regex: builtinPattern, allowTypeImports: true, message: nodeMessage }] }],
      'briefsip/client-server-boundary': 'error',
    },
  },
];
