import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const root = dirname(fileURLToPath(import.meta.url));
// Browser imports outside src receive the same boundary checks.
export const browserSafeModules = [
  'shared/agent-create.ts', 'agent-template.ts', 'shared/agent-visibility.ts', 'connected-app-command.ts',
  'conversation-command.ts', 'diff-lines.ts', 'flows.ts', 'shared/mcp-scopes.ts', 'memory-command.ts',
  'navigation.ts', 'panel-width.ts', 'presentation.ts', 'question-answer.ts', 'remote-message-command.ts',
  'shared/skill-command.ts', 'shared/skill-files.ts', 'shared/skill-pack-schema.ts', 'shared/skill-zip.ts',
  'shared/speech-preference.ts', 'shared/speech.ts', 'thread-command.ts', 'shared/turn-stream.ts', 'workflow-command.ts',
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

export const comments = {
  meta: {
    type: 'suggestion', schema: [],
    messages: {
      shape: 'Keep comments on one line, at most 120 characters including delimiters; move rationale to an issue or commit.',
      justification: 'Fix the root cause, or open a GitHub issue and reference it with TODO(#123).',
    },
  },
  create(context) {
    return {
      Program() {
        const source = context.sourceCode, all = source.getAllComments();
        const firstToken = source.getFirstToken(source.ast)?.range[0] ?? source.text.length;
        const headers = all.filter(comment => comment.range[1] <= firstToken);
        if (headers.some(comment => /(?:@generated\b|\bauto-generated\b|\bCode generated\b.*\bDO NOT EDIT\b)/i.test(comment.value))) return;
        for (const comment of all) {
          const header = headers.includes(comment) && /\b(?:copyright|SPDX-License-Identifier|MIT|provenance|adapted from T3)\b/i.test(comment.value);
          if (!header && (comment.loc.start.line !== comment.loc.end.line || [...source.getText(comment)].length > 120))
            context.report({ node: comment, messageId: 'shape' });
          const text = comment.value.replace(/\bTODO\(#[1-9]\d*\)/g, '');
          if (/\b(?:workaround|for\s+now|temporary|hack|in\s+case|quick\s+fix|TODO|FIXME)\b/i.test(text))
            context.report({ node: comment, messageId: 'justification' });
        }
      },
    };
  },
};

const foundation = [
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    languageOptions: { parser: tseslint.parser },
    plugins: { briefsip: { rules: { 'client-server-boundary': clientServerBoundary, comments } } },
    rules: { 'no-debugger': 'error', 'no-unreachable': 'error' },
  },
  // #39: product comments; test bodies and lint fixtures remain outside product scope.
  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    ignores: ['**/*.test.{ts,tsx,mjs,js}', 'test.ts', 'lint/check.mjs', '**/generated/**', '**/*.generated.{ts,tsx,mjs,js}'],
    rules: { 'briefsip/comments': 'error' },
  },
  {
    files: ['src/**/*.{ts,tsx,mjs,js}', ...browserSafeModules],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [{ regex: builtinPattern, allowTypeImports: true, message: nodeMessage }] }],
      'briefsip/client-server-boundary': 'error',
    },
  },
];

// #38: timer, effect and explicit-any ratchets. Existing debt lives in bulk suppressions.
export const timerAllowlist = [];
export const effectPrimitives = [
  'src/ui/kit.tsx', 'src/ui/Menu.tsx', 'src/ui/Modal.tsx', 'src/ui/ChatPrimitives.tsx',
  'src/ui/resizable.tsx', 'src/ui/primitives/**/*.{ts,tsx}',
];
const effectMessage = 'Move lifecycle work to src/hooks/: use usePolling for refresh loops; use a focused hook for subscriptions, focus or browser resources. UI primitives belong in the kit.';
export const noComponentEffects = {
  meta: { type: 'problem', schema: [], messages: { effect: effectMessage } },
  create(context) {
    return {
      'Program:exit'() {
        for (const scope of context.sourceCode.scopeManager.scopes) for (const variable of scope.variables) {
          const binding = variable.defs.find(def => def.type === 'ImportBinding' && def.parent.source?.value === 'react');
          if (!binding) continue;
          const specifier = binding.node;
          if (specifier.type === 'ImportSpecifier' && (specifier.imported.name ?? specifier.imported.value) === 'useEffect') {
            for (const reference of variable.references) context.report({ node: reference.identifier, messageId: 'effect' });
          } else if (['ImportNamespaceSpecifier', 'ImportDefaultSpecifier'].includes(specifier.type)) {
            for (const reference of variable.references) {
              const member = reference.identifier.parent;
              if (member.type === 'MemberExpression' && ((!member.computed && member.property.name === 'useEffect') || (member.computed && member.property.value === 'useEffect')))
                context.report({ node: member, messageId: 'effect' });
              if (member.type === 'VariableDeclarator' && member.id.type === 'ObjectPattern')
                for (const property of member.id.properties) if (property.key?.name === 'useEffect' || property.key?.value === 'useEffect') context.report({ node: property, messageId: 'effect' });
            }
          }
        }
      },
    };
  },
};
const timerMessage = 'Use usePolling from src/hooks/usePolling for refresh loops or downloadBlob from src/hooks/downloadBlob for downloads. Put other timer lifecycles in a focused hook; do not add component timers.';
export const lifecycleRatchets = [
  {
    files: ['**/*.{ts,tsx,mjs,js}'], ignores: ['**/*.test.ts', '**/test.ts', '**/*-it.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
  {
    files: ['src/**/*.{ts,tsx,mjs,js}'], ignores: ['src/hooks/**', ...timerAllowlist],
    languageOptions: { globals: { window: 'readonly', self: 'readonly', globalThis: 'readonly' } },
    rules: {
      'no-restricted-globals': ['error', { globals: ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback'].map(name => ({ name, message: timerMessage })), checkGlobalObject: true }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx,mjs,js}'], ignores: ['src/hooks/**', ...effectPrimitives],
    plugins: { 'briefsip-lifecycle': { rules: { 'no-component-effects': noComponentEffects } } },
    rules: { 'briefsip-lifecycle/no-component-effects': 'error' },
  },
];

export default [...foundation, ...lifecycleRatchets];
