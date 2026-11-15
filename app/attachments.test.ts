import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentSize, isAttachmentImage, removeAttachment, uploadLimitError } from './src/attachments.ts';

test('attachment images restrict previews to PNG, JPEG and WebP, including generic MIME fallback', () => {
  for (const name of ['shot.PNG', 'photo.jpeg', 'photo.jpg', 'art.webp']) assert.equal(isAttachmentImage({ name }), true);
  for (const name of ['code.html', 'vector.svg', 'animation.gif', 'photo.tiff', 'fake.png.html']) assert.equal(isAttachmentImage({ name }), false);
  assert.equal(isAttachmentImage({ name: 'clipboard', type: 'image/png' }), true);
  assert.equal(isAttachmentImage({ name: 'shot.png', type: 'application/octet-stream' }), true);
  assert.equal(isAttachmentImage({ name: 'fake.png', type: 'image/svg+xml' }), false);
  assert.equal(isAttachmentImage({ name: 'extensionless', image: true }), true);
  assert.equal(isAttachmentImage({ name: 'fake.png', image: false }), false);
});
test('upload boundaries keep four attachments and 10 MiB per file', () => {
  assert.equal(uploadLimitError([{ size: 10 * 1024 * 1024 }], 3), '');
  assert.match(uploadLimitError([{ size: 1 }], 4), /four/);
  assert.match(uploadLimitError([{ size: 10 * 1024 * 1024 + 1 }], 0), /10 MiB/);
});
test('removing one attachment preserves order and leaves original selection intact', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(removeAttachment(ids, 'b'), ['a', 'c']);
  assert.deepEqual(removeAttachment(ids, 'missing'), ids);
  assert.deepEqual(ids, ['a', 'b', 'c']);
});
test('attachment sizes use compact binary units', () => {
  for (const [size, text] of [[0, '0 B'], [1023, '1023 B'], [1024, '1 KiB'], [1536, '1.5 KiB'], [1048576, '1 MiB']] as const) assert.equal(attachmentSize(size), text);
});
