import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const root = fileURLToPath(new URL('../../', import.meta.url));
const excludedDirectories = new Set(['references', 'work', 'archive', 'node_modules']);
// These records preserve paths from retired implementations.
const history = new Set(['backlog.md', 'docs/host-package.md']);
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
}).split('\0');
const rootDirectories = new Set(files.filter(file => file.includes('/')).map(file => file.split('/')[0]));
const docs = files.filter(file => file.endsWith('.md') && !history.has(file)
  && !file.split('/').some(part => excludedDirectories.has(part))
  && existsSync(resolve(root, file)));

const problems = new Set();
for (const file of docs) {
  const source = resolve(root, file);
  const tokens = marked.lexer(readFileSync(source, 'utf8'));
  marked.walkTokens(tokens, token => {
    if (token.type === 'link' || token.type === 'image') {
      const { href } = token;
      if (!href || /^(?:[#?/]|[a-z][a-z\d+.-]*:)/i.test(href)) return;
      const path = href.split(/[?#]/, 1)[0];
      let decoded;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        problems.add(`${file}: invalid link encoding ${href}`);
        return;
      }
      if (!existsSync(resolve(dirname(source), decoded))) problems.add(`${file}: missing link target ${href}`);
    } else if (token.type === 'codespan') {
      const { text } = token;
      if (!/^(?:\.\.?\/)?[\w.@-]+(?:\/[\w.@-]+)*\/?$/.test(text)) return;
      const relative = text.startsWith('./') || text.startsWith('../');
      if (!relative && !rootDirectories.has(text.split('/')[0])) return;
      const base = relative ? dirname(source) : root;
      if (!existsSync(resolve(base, text))) problems.add(`${file}: missing code path ${text}`);
    }
  });
}

if (problems.size) {
  console.error([...problems].sort().join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Markdown paths: ${docs.length} docs checked.`);
}
