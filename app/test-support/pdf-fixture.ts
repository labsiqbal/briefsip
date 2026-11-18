import { deflateSync } from 'node:zlib';

export function pdfFixture(text: string, pages = 1, compressed = true) {
  const objects: Buffer[] = [], add = (value: string | Buffer) => { objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value)); };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < pages; i++) {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10000 10000] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    const plain = Buffer.from(`BT /F1 12 Tf 40 9900 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`), stream = compressed ? deflateSync(plain) : plain;
    add(Buffer.concat([Buffer.from(`<< /Length ${stream.length}${compressed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`), stream, Buffer.from('\nendstream')]));
  }
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let length = chunks[0].length;
  objects.forEach((object, i) => { offsets.push(length); const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]); chunks.push(chunk); length += chunk.length; });
  chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
