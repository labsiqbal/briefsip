import { MessageCopyButton } from './ui/MessageCopyButton.ts';
import { createElement as h, memo, type ReactNode } from 'react';
import { marked, type Token, type Tokens } from 'marked';
import { decodeHTML } from 'entities';
import { splitMarkdownBlocks } from './ui/markdownStreamBlocks.ts';

export function markdownLink(value: string, scope: string, origin: string): { href: string; external: boolean } | null {
  value = decodeHTML(value);
  if (/[\x00-\x20\x7f\\]/.test(value)) return null;
  if (/^https?:\/\//i.test(value)) {
    try { const url = new URL(value); if (url.username || url.password) return null; if (url.origin !== origin) return { href: url.href, external: true }; value = url.pathname + url.search + url.hash; } catch { return null; }
  }
  if (value.startsWith(scope + '/files/') && /^[a-f0-9-]{36}$/i.test(value.slice((scope + '/files/').length))) return { href: value, external: false };
  if (/^\/sites\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) return { href: value, external: true };
  return null;
}

export const Markdown = memo(function Markdown({ text, scope, origin }: { text: string; scope: string; origin: string }) {
  let count = 0;
  function render(tokens: Token[], depth = 0): ReactNode[] {
    if (depth > 40) throw new Error('Markdown depth');
    return tokens.map((token, key) => {
      if (++count > 6000) throw new Error('Markdown nodes');
      const child = () => render('tokens' in token ? token.tokens ?? [] : [], depth + 1);
      switch (token.type) {
        case 'space': case 'def': return null;
        case 'text': return token.tokens ? h('span', { key }, child()) : decodeHTML(token.text);
        case 'escape': return decodeHTML(token.text);
        case 'paragraph': return h('p', { key }, child());
        case 'heading': return h(`h${Math.min(6, token.depth + 2)}`, { key }, child());
        case 'strong': case 'em': case 'del': return h(token.type, { key }, child());
        case 'blockquote': return h('blockquote', { key }, child());
        case 'br': case 'hr': return h(token.type, { key });
        case 'codespan': return h('code', { key }, token.text);
        case 'code': return h('div', { key, className: 'markdown-code' }, h('div', { className: 'markdown-code__actions bs-root' }, h(MessageCopyButton, { text: token.text, label: 'Copy code' })), h('pre', { tabIndex: 0, role: 'region', 'aria-label': 'Code block' }, h('code', null, token.text)));
        case 'checkbox': return h('span', { key, role: 'img', 'aria-label': token.checked ? 'Done' : 'Not done' }, token.checked ? '[x] ' : '[ ] ');
        case 'list': return h(token.ordered ? 'ol' : 'ul', { key, ...(token.ordered ? { start: token.start } : {}) }, token.items.map((item: Tokens.ListItem, index: number) => h('li', { key: index }, render(item.tokens, depth + 1))));
        case 'link': {
          const target = markdownLink(token.href, scope, origin);
          return target ? h('a', { key, href: target.href, ...(target.external ? { target: '_blank', rel: 'noopener noreferrer', title: target.href } : { download: true }) }, child()) : h('span', { key }, child());
        }
        case 'image': return h('span', { key }, token.text ? `[Image: ${token.text}]` : '[Image]');
        case 'table': {
          count += token.header.length * (token.rows.length + 1) + token.rows.length;
          if (count > 6000) throw new Error('Markdown table nodes');
          const alignment = (cell: Tokens.TableCell) => ({ textAlign: cell.align ?? 'left' });
          return h('div', { key, className: 'markdown-table', tabIndex: 0, role: 'region', 'aria-label': 'Response table' }, h('table', null,
            h('thead', null, h('tr', null, token.header.map((cell: Tokens.TableCell, index: number) => h('th', { key: index, scope: 'col', style: alignment(cell) }, render(cell.tokens, depth + 1))))),
            h('tbody', null, token.rows.map((row: Tokens.TableCell[], index: number) => h('tr', { key: index }, row.map((cell, column) => h('td', { key: column, style: alignment(cell) }, render(cell.tokens, depth + 1))))))));
        }
        // Raw HTML remains visible source text, never DOM supplied by the model.
        default: return token.raw;
      }
    });
  }
  try {
    if (text.length > 64000) throw new Error('Markdown length');
    // ponytail: conservative pre-lexer table bound; a dedicated tokenizer can narrow false-positive plain-text fallback.
    const lines = text.split(/\r\n|\r|\n/), columns = lines.reduce((max, line) => Math.max(max, line.split('|').length), 1);
    if (columns * lines.length > 6000) throw new Error('Markdown table expansion');
    return h('div', { className: 'markdown' }, render(marked.lexer(text, { gfm: true, breaks: false })));
  } catch { return h('p', { className: 'message-text' }, text); }
});

// Keep completed blocks mounted and memoized while only the trailing block changes.
// Document-wide syntax falls back to one renderer to preserve Markdown semantics.
export function StreamingMarkdown(props: { text: string; scope: string; origin: string }) {
  const blocks = props.text.length <= 64000 ? splitMarkdownBlocks(props.text) ?? [props.text] : [props.text];
  return h('div', { className: 'stream-markdown' }, blocks.map((text, index) =>
    h(Markdown, { ...props, text, key: index })));
}
