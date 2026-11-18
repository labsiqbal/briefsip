// Codex caps each additionalContext value at 4,000 UTF-8 bytes.
export function additionalContext(text: string): Record<string, { kind: 'application'; value: string }> {
  const chunks: string[] = []; let value = '', bytes = 0;
  for (const block of text.split(/(?<=\n\n)/)) {
    if (value && bytes + Buffer.byteLength(block) > 4000) { chunks.push(value); value = ''; bytes = 0; }
    for (const char of block) {
      const size = Buffer.byteLength(char);
      if (bytes + size > 4000) { chunks.push(value); value = ''; bytes = 0; }
      value += char; bytes += size;
    }
  }
  if (value) chunks.push(value);
  return Object.fromEntries(chunks.map((value, i) => [`briefsip_${String(i + 1).padStart(3, '0')}`, { kind: 'application', value }]));
}
