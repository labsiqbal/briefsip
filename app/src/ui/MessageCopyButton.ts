// MessageCopyButton pattern adapted from T3 (MIT); see app/t3/provenance.json.
import { createElement as h, Fragment, useEffect, useRef, useState } from 'react';
import { Tooltip } from 'radix-ui';
import { Check, Copy } from 'lucide-react';
import { copyText } from './clipboard.ts';

// Keep this component erasable TypeScript so the native Markdown renderer checks can import it.
export function MessageCopyButton({ text, label = 'Copy reply' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const button = h('button', { type: 'button', className: 'k-icon-btn', 'aria-label': label, onClick: async () => {
    try {
      await copyText(text); setError(''); setCopied(true);
      clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 2000);
    } catch { setCopied(false); setError('Text could not be copied. Select it to copy.'); }
  } }, h(copied ? Check : Copy, { size: 14, 'aria-hidden': true }));
  return h(Fragment, null,
    h(Tooltip.Provider, { delayDuration: 400, children: h(Tooltip.Root, null, h(Tooltip.Trigger, { asChild: true }, button), h(Tooltip.Portal, null, h(Tooltip.Content, { className: 'k-tooltip', sideOffset: 6 }, label))) }),
    h('span', { className: 'sr-only', role: 'status' }, copied ? 'Copied' : ''),
    error && h('span', { className: 'message-error', role: 'alert' }, error));
}
