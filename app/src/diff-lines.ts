export function diffLines(text: string) {
  let old = 0, next = 0;
  let inHunk = false;
  return text.replace(/\n$/, '').split('\n').map(text => {
    if (text.startsWith('diff --git ')) inHunk = false;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true; return { text, kind: 'hunk', old: '', next: '' }; }
    if (!inHunk) return { text, kind: 'meta', old: '', next: '' };
    if (text.startsWith('\\')) return { text, kind: 'meta', old: '', next: '' };
    if (text.startsWith('+')) return { text, kind: 'add', old: '', next: String(next++) };
    if (text.startsWith('-')) return { text, kind: 'remove', old: String(old++), next: '' };
    if (text.startsWith(' ')) return { text, kind: 'context', old: String(old++), next: String(next++) };
    return { text, kind: 'meta', old: '', next: '' };
  });
}

export type DiffLine = ReturnType<typeof diffLines>[number];
export function splitDiffLines(text: string): { left?: DiffLine; right?: DiffLine; heading?: string }[] {
  const result: { left?: DiffLine; right?: DiffLine; heading?: string }[] = [];
  const lines = diffLines(text);
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.kind === 'meta' || line.kind === 'hunk') { result.push({ heading: line.text }); index++; }
    else if (line.kind === 'context') { result.push({ left: line, right: line }); index++; }
    else {
      const removed: DiffLine[] = [], added: DiffLine[] = [];
      while (lines[index]?.kind === 'remove') removed.push(lines[index++]);
      while (lines[index]?.kind === 'add') added.push(lines[index++]);
      for (let row = 0; row < Math.max(removed.length, added.length); row++) result.push({ left: removed[row], right: added[row] });
    }
  }
  return result;
}
