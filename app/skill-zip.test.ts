import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseSkillFiles, skillFileBytes, skillFileFromBytes, skillBinaryLimit } from './skill-files.ts';
import { readSkillZip, writeSkillZip } from './skill-zip.ts';

const files = [{ path: 'SKILL.md', content: '---\nname: portable\ndescription: Portable fixture\n---\nUse reference files.\n' }, { path: 'references/note.txt', content: 'Exact bytes\r\n' }];
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function compressed() {
  const bytes = writeSkillZip(files.slice(0, 1)), old = view(bytes), start = 30 + old.getUint16(26, true), size = old.getUint32(22, true), central = start + size;
  const data = deflateRawSync(bytes.subarray(start, central)), result = new Uint8Array(bytes.length - size + data.length);
  result.set(bytes.subarray(0, start)); result.set(data, start); result.set(bytes.subarray(central), start + data.length);
  const next = view(result), offset = start + data.length;
  next.setUint16(8, 8, true); next.setUint32(18, data.length, true); next.setUint16(offset + 10, 8, true); next.setUint32(offset + 20, data.length, true); next.setUint32(result.length - 6, offset, true);
  return result;
}
test('portable skill ZIP round trips exact text and validates deflate before preview', async () => {
  assert.deepEqual(await readSkillZip(writeSkillZip(files)), files);
  assert.deepEqual(await readSkillZip(compressed()), files.slice(0, 1));
  const corrupt = compressed(); corrupt[35] ^= 1; await assert.rejects(readSkillZip(corrupt));
  const badCrc = writeSkillZip(files); badCrc[60] ^= 1; await assert.rejects(readSkillZip(badCrc));
  for (const offset of [6, 8, 18, 22]) { const bad = writeSkillZip(files); bad[offset] ^= 1; await assert.rejects(readSkillZip(bad)); }
  for (const size of [0, 21, 128001]) await assert.rejects(readSkillZip(new Uint8Array(size)));
  const symlink = writeSkillZip(files), central = view(symlink).getUint32(symlink.length - 6, true);
  view(symlink).setUint32(central + 38, 0xa1ff0000, true); await assert.rejects(readSkillZip(symlink));
  const traversal = writeSkillZip(files);
  const name = new TextEncoder().encode('../badxx/SKILL.md'); assert.equal(name.length, view(traversal).getUint16(26, true));
  traversal.set(name, 30); traversal.set(name, view(traversal).getUint32(traversal.length - 6, true) + 46); await assert.rejects(readSkillZip(traversal));
  const bomb = compressed(), bombView = view(bomb), bombCentral = bombView.getUint32(bomb.length - 6, true);
  bombView.setUint32(22, 1, true); bombView.setUint32(bombCentral + 24, 1, true); await assert.rejects(readSkillZip(bomb));
  const duplicate = [{ ...files[0] }, { ...files[0] }]; assert.throws(() => writeSkillZip(duplicate));
  const missingDescriptor = writeSkillZip(files.slice(0, 1)), md = view(missingDescriptor), mc = md.getUint32(missingDescriptor.length - 6, true);
  md.setUint16(6, 0x808, true); md.setUint16(mc + 8, 0x808, true); md.setUint32(14, 0, true); md.setUint32(18, 0, true); md.setUint32(22, 0, true);
  await assert.rejects(readSkillZip(missingDescriptor));
  for (const signature of [false, true]) {
    const descriptorSize = signature ? 16 : 12, valid = new Uint8Array(missingDescriptor.length + descriptorSize), v = view(valid);
    valid.set(missingDescriptor.subarray(0, mc)); valid.set(missingDescriptor.subarray(mc), mc + descriptorSize);
    let offset = mc; if (signature) { v.setUint32(offset, 0x08074b50, true); offset += 4; }
    for (let n = 0; n < 3; n++) v.setUint32(offset + n * 4, md.getUint32(mc + 16 + n * 4, true), true);
    v.setUint32(valid.length - 6, mc + descriptorSize, true);
    assert.deepEqual(await readSkillZip(valid), files.slice(0, 1)); valid[offset] ^= 1; await assert.rejects(readSkillZip(valid));
  }
  for (const nested of [[{ path: 'references', content: 'file' }, files[1]], [files[1], { path: 'REFERENCES', content: 'file' }]]) assert.throws(() => writeSkillZip([files[0], ...nested]));
});


test('binary skill assets roundtrip exact bytes with strict base64, size and path boundaries', async () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  const asset = skillFileFromBytes('assets/sample.bin', bytes), input = [...files, asset];
  assert.equal(asset.encoding, 'base64');
  assert.deepEqual(skillFileBytes((await readSkillZip(writeSkillZip(input)))[2]), bytes);
  assert.deepEqual(skillFileBytes(parseSkillFiles(JSON.parse(JSON.stringify(input))).files[2]), bytes);
  for (const content of ['AA', 'AB==', 'AA==\n', 'AA-_', '====']) assert.throws(() => parseSkillFiles([...files, { path: 'bad.bin', content, encoding: 'base64' }]));
  assert.throws(() => parseSkillFiles([{ path: 'SKILL.md', content: btoa(files[0].content), encoding: 'base64' }]));
  assert.throws(() => parseSkillFiles([...files, { ...asset, path: '../bad' }]));
  assert.throws(() => parseSkillFiles([...files, { ...asset, encoding: 'hex' }]));
  const large = skillFileFromBytes('assets/large.bin', new Uint8Array(skillBinaryLimit));
  assert.equal(skillFileBytes((await readSkillZip(writeSkillZip([...files, large])))[2]).length, skillBinaryLimit);
  assert.throws(() => parseSkillFiles([...files, large, asset]));
});


test('ZIP preserves explicit binary classification even for UTF-8 bytes', async () => {
  for (const size of [0, 20, 60000]) {
    const asset = { path: 'assets/ascii.bin', content: btoa('a'.repeat(size)), encoding: 'base64' as const };
    const imported = await readSkillZip(writeSkillZip([...files, asset]));
    assert.deepEqual(imported[2], asset);
  }
});
