import { parseSkillFiles, skillFileBytes, skillFileFromBytes, skillBinaryLimit, type SkillFile } from './skill-files.ts';

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// Entry comments preserve explicit binary classification, including empty and UTF-8 assets.
const binaryComment = encoder.encode('briefsip-binary-v1');
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
const invalid = () => new Error('ZIP is invalid or uses an unsupported format. Use a standard ZIP with UTF-8 SKILL.md.');

export async function readSkillZip(bytes: Uint8Array) {
  // ponytail: single-disk stored/deflate ZIP only; add ZIP64/encryption only with explicit format support.
  if (bytes.length < 22 || bytes.length > 3 * 1024 * 1024) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true), u32 = (offset: number) => view.getUint32(offset, true);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break;
  if (end < 0 || u32(end) !== 0x06054b50 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10) || u16(end + 10) > 64 || u32(end + 16) + u32(end + 12) !== end) throw invalid();
  const central = u32(end + 16), files: SkillFile[] = [], paths = new Set<string>(), ranges: [number, number][] = [];
  let cursor = central, total = 0;
  for (let index = 0; index < u16(end + 10); index++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) throw invalid();
    const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16), compressed = u32(cursor + 20), size = u32(cursor + 24), length = u16(cursor + 28), extra = u16(cursor + 30), comment = u16(cursor + 32), local = u32(cursor + 42), attributes = u32(cursor + 38);
    if (u16(cursor + 6) > 20 || flags & ~0x080e || ![0, 8].includes(method) || u16(cursor + 34) || cursor + 46 + length + extra + comment > end || size > skillBinaryLimit || (total += size) > skillBinaryLimit + 48000) throw invalid();
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + length), path = decoder.decode(nameBytes), directory = path.endsWith('/');
    const normalized = (directory ? path.slice(0, -1) : path).toLowerCase();
    if (!path || path.length > 305 || /[\\\x00-\x1f\x7f:]/.test(path) || !normalized.split('/').every(part => part && part !== '.' && part !== '..') || paths.has(normalized)) throw invalid();
    paths.add(normalized);
    const kind = (attributes >>> 16) & 0xf000;
    if (kind && kind !== (directory ? 0x4000 : 0x8000) || directory && size) throw invalid();
    if (local + 30 > central || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method || u16(local + 26) !== length) throw invalid();
    const start = local + 30 + length + u16(local + 28), stop = start + compressed;
    if (stop > central || start > central || !nameBytes.every((byte, n) => byte === bytes[local + 30 + n])) throw invalid();
    let recordEnd = stop;
    if (flags & 8) {
      if (stop + 12 > central) throw invalid();
      const descriptor = u32(stop) === 0x08074b50 ? stop + 4 : stop;
      if (descriptor + 12 > central || u32(descriptor) !== crc || u32(descriptor + 4) !== compressed || u32(descriptor + 8) !== size) throw invalid();
      recordEnd = descriptor + 12;
    }
    if (ranges.some(([a, b]) => local < b && recordEnd > a)) throw invalid();
    ranges.push([local, recordEnd]);
    if (!(flags & 8) && (u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== size)) throw invalid();
    let output = bytes.slice(start, stop);
    if (method === 8) {
      const reader = new Blob([output]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      const chunks: Uint8Array[] = []; let received = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; received += part.value.length; if (received > size) throw invalid(); chunks.push(part.value); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      output = new Uint8Array(received); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    }
    if (output.length !== size || crc32(output) !== crc) throw invalid();
    const commentStart = cursor + 46 + length + extra;
    const binary = comment === binaryComment.length && binaryComment.every((byte, index) => bytes[commentStart + index] === byte);
    if (!directory) files.push(skillFileFromBytes(path, output, binary));
    cursor += 46 + length + extra + comment;
  }
  if (cursor !== end || files.length > 32) throw invalid();
  const filePaths = new Set(files.map(file => file.path.toLowerCase()));
  if ([...paths].some(path => path.split('/').slice(0, -1).some((_, index, parts) => filePaths.has(parts.slice(0, index + 1).join('/'))))) throw invalid();
  let root = '';
  if (!files.some(file => file.path === 'SKILL.md')) {
    root = files[0]?.path.split('/')[0] ?? '';
    if (!root || !files.every(file => file.path.startsWith(root + '/'))) throw invalid();
    for (const file of files) file.path = file.path.slice(root.length + 1);
  }
  const parsed = parseSkillFiles(files);
  if (root && root !== parsed.name) throw new Error('ZIP folder name must match the name in SKILL.md.');
  return parsed.files;
}

export function writeSkillZip(input: SkillFile[]) {
  const parsed = parseSkillFiles(input), entries = parsed.files.map(file => ({ name: encoder.encode(`${parsed.name}/${file.path}`), bytes: skillFileBytes(file), comment: file.encoding === 'base64' ? binaryComment : new Uint8Array() }));
  const size = entries.reduce((n, entry) => n + 76 + entry.name.length * 2 + entry.bytes.length + entry.comment.length, 22), output = new Uint8Array(size), view = new DataView(output.buffer);
  const u16 = (offset: number, value: number) => view.setUint16(offset, value, true), u32 = (offset: number, value: number) => view.setUint32(offset, value, true);
  let local = 0, central = entries.reduce((n, entry) => n + 30 + entry.name.length + entry.bytes.length, 0); const centralStart = central;
  for (const entry of entries) {
    const crc = crc32(entry.bytes);
    u32(local, 0x04034b50); u16(local + 4, 20); u16(local + 6, 0x800); u16(local + 12, 33); u32(local + 14, crc); u32(local + 18, entry.bytes.length); u32(local + 22, entry.bytes.length); u16(local + 26, entry.name.length); output.set(entry.name, local + 30); output.set(entry.bytes, local + 30 + entry.name.length);
    u32(central, 0x02014b50); u16(central + 4, 20); u16(central + 6, 20); u16(central + 8, 0x800); u16(central + 14, 33); u32(central + 16, crc); u32(central + 20, entry.bytes.length); u32(central + 24, entry.bytes.length); u16(central + 28, entry.name.length); u32(central + 42, local); output.set(entry.name, central + 46);
    u16(central + 32, entry.comment.length); output.set(entry.comment, central + 46 + entry.name.length);
    local += 30 + entry.name.length + entry.bytes.length; central += 46 + entry.name.length + entry.comment.length;
  }
  u32(central, 0x06054b50); u16(central + 8, entries.length); u16(central + 10, entries.length); u32(central + 12, central - centralStart); u32(central + 16, centralStart);
  return output;
}
