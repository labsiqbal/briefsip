import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, markdownLink } from './src/Markdown.ts';
const scope = '/api/agents/00000000-0000-4000-8000-000000000000', file = '11111111-1111-4111-8111-111111111111';
const origin = 'http://localhost:3000';
const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text, scope, origin, results: true }));
test('Markdown renders structure and scoped links without model-supplied DOM or automatic network loads', () => {
  const html = render(`# Heading\n\n**Bold**, *italic*, ~~old~~ and \`<code>\`.\n\n- One\n- Two\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\n\`\`\`html\n<script>alert(1)</script>\n\`\`\`\n\n[File](${scope}/files/${file})\n\n[Docs](https://example.com/docs?q=one&v=two)`);
  for (const tag of ['<h1 aria-level="4">', '<strong>', '<em>', '<del>', '<ul>', '<table>', '<pre']) assert(html.includes(tag), tag);
  assert(html.includes(encodeURIComponent(`${scope}/panel/files/${file}`))); assert(!html.includes('download=')); assert(!html.includes('target="_blank"')); assert(!html.includes('<script>'));
  const attack = render('<img src="https://tracker.test/x" onerror="alert(1)">\n\n<script>alert(1)</script>\n\n[evil](javascript:alert(1))\n\n![track](https://tracker.test/x)\n\n<iframe src="/api/backup"></iframe>');
  for (const tag of ['<img', '<script', '<iframe', '<style']) assert(!attack.includes(tag));
  assert(!attack.includes('href=')); assert(!attack.includes('src=' ) || attack.includes('&lt;img'));
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'sandbox:/mnt/data/x', '//example.com', 'https://user:pass@example.com', 'https://example.com\\x', '/api/backup', `${scope}/files/${file}?x=1`, `/api/threads/00000000-0000-4000-8000-000000000000/files/${file}`]) assert.equal(markdownLink(url, scope, origin), null, url);
  assert.match(render('&lt;safe&gt; &#x41;'), /&lt;safe&gt; A/);
  assert.match(render('&#38;lt;'), /&amp;lt;/);
  assert.equal(markdownLink('javascript&#58;alert(1)', scope, origin), null);
  assert.equal(markdownLink('https://example.com/?a=1&amp;b=2', scope, origin)?.href, 'https://example.com/?a=1&b=2');
  assert.equal(markdownLink(origin + '/api/backup', scope, origin), null);
  assert.match(render(`[Site](/sites/${file})`), /result=/);
  assert.equal(markdownLink(`/sites/${file}?redirect=/api/backup`, scope, origin), null);
  assert.equal(markdownLink('/sites/../../api/backup', scope, origin), null);
  assert.equal(markdownLink(origin + scope + '/files/' + file, scope, origin)?.external, false);
  assert.equal((render('- [x] done\n- [ ] todo').match(/\[x\]/g) ?? []).length, 1);
  assert(render('| Right | Center |\n| ---: | :---: |\n| 1 | 2 |').includes('text-align:right'));
  const amplified = '| x '.repeat(200) + '|\n' + '| --- '.repeat(200) + '|\n' + '|x|\n'.repeat(1000);
  assert(render(amplified).includes('class="message-text"'));
  const huge = 'x'.repeat(64001); assert(render(huge).includes('class="message-text"'));
  const deep = '> '.repeat(100) + 'Nested'; assert(render(deep).includes('Nested'));
});

test('reply files link mentions or append prose links, with plain deleted text and scoped teammate files', () => {
  const files = [{ id: file, name: 'report.html', size: 10 }];
  const output = (text: string, extra: import('./src/attachments.ts').AttachmentFile[] = files) => renderToStaticMarkup(createElement(Markdown, { text, scope, origin, files: extra }));
  for (const text of ['Review report.html now.', 'Review `report.html` now.', `[Report](${scope}/files/${file})`, `[Report](${origin}${scope}/files/${file})`, '[Report](/tmp/report.html)']) {
    const html = output(text); assert.equal((html.match(/<a /g) ?? []).length, 1); assert(!html.includes('attachment')); assert(!html.includes('chip'));
    assert(html.includes(encodeURIComponent(`${scope}/panel/files/${file}`)));
  }
  assert.match(output('myreport.html report.html.bak'), /myreport.html report.html.bak<\/p><p><a /);
  assert.match(output('Done.'), /<p>Done.<\/p><p><a /);
  const deleted = output('Review report.html.', [{ ...files[0], deleted: true }]);
  assert(!deleted.includes('<a ')); assert(deleted.includes('class="message-muted"')); assert(deleted.includes('(deleted)'));
  assert.match(output('`&amp;`'), /<code>&amp;amp;<\/code>/);
  const teammate = output('Done.', [{ ...files[0], thread: file }]);
  assert(teammate.includes(encodeURIComponent(`/api/threads/${file}/panel/files/${file}`)));
  const absoluteTeammate = output(`[Report](${origin}/api/threads/${file}/files/${file})`, [{ ...files[0], thread: file }]);
  assert.equal((absoluteTeammate.match(/<a /g) ?? []).length, 1);
});

test('Markdown outside replies retains ordinary download and external links', () => {
  const html = renderToStaticMarkup(createElement(Markdown, { text: `[File](${scope}/files/${file}) [Docs](https://example.test/)`, scope, origin }));
  assert(html.includes('download=""')); assert(html.includes('target="_blank"')); assert(!html.includes('result='));
});
