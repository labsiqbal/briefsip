// Adapted from T3 useCopyToClipboard.ts (MIT); see app/t3/provenance.json.
export async function copyText(value: string): Promise<void> {
  if (typeof window !== 'undefined' && window.top !== window) throw new Error('Copy is unavailable in embedded views. Open Minarbot directly.');
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  } catch { /* Native editing remains available when the async API is denied. */ }
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') throw new Error('Text could not be copied. Select it to copy.');
  const active = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const inputSelection = typeof HTMLInputElement !== 'undefined' && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) ? [active.selectionStart, active.selectionEnd, active.selectionDirection] as const : null;
  const textarea = document.createElement('textarea');
  textarea.value = value; textarea.className = 'sr-only'; textarea.tabIndex = -1;
  textarea.setAttribute('readonly', ''); textarea.setAttribute('aria-hidden', 'true');
  // Keep fallback inside Radix's focus trap when copying from a dialog.
  (active?.closest('[role="dialog"], [role="alertdialog"]') ?? document.body).appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true }); textarea.select();
    if (!document.execCommand('copy')) throw new Error('Copy failed');
  } catch { throw new Error('Text could not be copied. Select it to copy.'); }
  finally {
    textarea.remove(); active?.focus({ preventScroll: true });
    if (inputSelection && (typeof HTMLInputElement !== 'undefined' && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) && inputSelection[0] !== null && inputSelection[1] !== null) active.setSelectionRange(inputSelection[0], inputSelection[1], inputSelection[2] ?? undefined);
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
}

export async function readClipboardText(): Promise<string> {
  if (typeof window !== 'undefined' && window.top !== window) throw new Error('Clipboard is unavailable in embedded views. Open Minarbot directly.');
  try { return await navigator.clipboard.readText(); }
  catch { throw new Error('Clipboard could not be read. Use Paste text to enter it manually.'); }
}
