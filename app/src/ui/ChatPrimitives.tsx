import { ArrowUp, ChevronDown, Plus } from 'lucide-react';
import { forwardRef, useId, useLayoutEffect, useRef, useState, type ComponentProps, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { AgentAvatar } from '../AgentAvatar';
import { Tooltip } from './kit';

type ChatAgent = ComponentProps<typeof AgentAvatar>['agent'];

export function ChatHeader({ agent, title = agent.name, onToggle, expanded, menu, pillRef, tooltip, right, editing }: {
  editing?: ReactNode;
  agent: ChatAgent; title?: string; onToggle?: () => void; expanded?: boolean; menu?: ReactNode; pillRef?: RefObject<HTMLDivElement | null>; tooltip?: string; right: ReactNode;
}) {
  const identity = <><AgentAvatar agent={agent} size={24} /><span className="chat__pill-name">{title}</span></>;
  return <header className="chat__header">
    <span className="chat__pill-anchor">
      {editing ?? (onToggle ? <button type="button" className="chat__pill" onClick={onToggle} aria-haspopup="menu" aria-expanded={expanded}>{identity}<ChevronDown size={14} aria-hidden className="chat__pill-chev" /></button>
        : <div ref={pillRef} tabIndex={-1} className="chat__pill" title={tooltip}>{identity}</div>)}
      {menu}
    </span>
    <div className="chat__header-right">{right}</div>
  </header>;
}

export const ChatTranscript = forwardRef<HTMLElement, ComponentProps<'section'> & { jump?: ReactNode; minimap?: ReactNode }>(function ChatTranscript({ children, jump, minimap, ...props }, ref) {
  return <div className="transcript-wrap"><section ref={ref} className="transcript" aria-label="Conversation history" {...props}><div className="transcript__col">{children}</div></section>{minimap}{jump && <div className="transcript-jump">{jump}</div>}</div>;
});

export function ChatEmptyState({ agent, title = agent.name, children }: { agent: ChatAgent; title?: string; children?: ReactNode }) {
  return <div className="empty-chat"><AgentAvatar agent={agent} size={64} /><div className="empty-chat__title">{title}</div>{children && <div className="empty-chat__sub">{children}</div>}</div>;
}

export function HumanMessage({ text, label = 'Your message', attachments, children }: { text: string; label?: string; attachments?: ReactNode; children: ReactNode }) {
  return <div className="human-message" tabIndex={-1} aria-label={label}>{text.trim() && <div className="human-bubble message-plain">{text}</div>}{attachments}<div className="turn-meta human-meta">{children}</div></div>;
}

export function AgentMessage({ identity, children }: { identity?: ReactNode; children: ReactNode }) {
  return <div className="agent-message">{identity}<div className="message-column">{children}</div></div>;
}

export function TurnStatus({ tone, label, model }: { tone: string; label: string; model?: string | null }) {
  return <div className="turn-meta agent-meta"><span className={`turn-status is-${tone}`}><i aria-hidden />{label}</span>{model && <span className="turn-model" title="Answering model">{model}</span>}</div>;
}

export function ChatComposer({ label, input, inputRef, onSubmit, onSendKey, onAttach, attachmentDisabledReason, recipient, actions, busy, retry, sendDisabled, sendLabel, sendTitle, stopAction, multiline, mentions = [], onMention, onPasteFiles, attachments, hasAttachments = false }: {
  attachments?: ReactNode; hasAttachments?: boolean;
  onPasteFiles?: (files: File[]) => void; stopAction?: ReactNode;
  mentions?: { id: string; name: string; role: string }[]; onMention?: (value: string) => void;
  label: string; input: ComponentProps<'textarea'>; inputRef?: RefObject<HTMLTextAreaElement | null>; onSubmit: (event: FormEvent) => void; onSendKey: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onAttach?: () => void; attachmentDisabledReason?: string; recipient?: ReactNode; actions?: ReactNode; busy: boolean; retry: boolean; sendDisabled: boolean; sendLabel: string; sendTitle: string; multiline?: boolean;
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null), ref = inputRef ?? ownRef;
  const listId = useId();
  const [dragging, setDragging] = useState(false);
  const [caret, setCaret] = useState(0), [selected, setSelected] = useState(0), [dismissed, setDismissed] = useState(false);
  const value = String(input.value ?? '');
  const match = value.slice(0, caret).match(/(?:^|[^\p{L}\p{N}_@])@([^@\n]*)$/u);
  const candidates = !input.readOnly && !dismissed && match ? mentions.filter(member => member.name.toLocaleLowerCase('en-US').startsWith(match[1].toLocaleLowerCase('en-US'))) : [];
  const current = Math.min(selected, Math.max(0, candidates.length - 1));
  function choose(index: number) {
    const member = candidates[index];
    if (!member || !match || !onMention) return;
    const prefix = value.slice(0, caret - match[1].length - 1), next = `${prefix}@${member.name} `;
    onMention(next + value.slice(caret)); setDismissed(true);
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(next.length, next.length); setCaret(next.length); });
  }
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
    element.style.overflowY = element.scrollHeight > 200 ? 'auto' : 'hidden';
  }, [input.value, ref]);
  return <form className={`composer${(multiline ?? String(input.value ?? '').includes('\n')) ? ' is-multiline' : ''}${dragging ? ' is-dragging' : ''}`} onSubmit={onSubmit} onDragOver={event => { if (onPasteFiles && !input.readOnly && !input.disabled && Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); setDragging(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={event => { setDragging(false); if (!onPasteFiles || input.readOnly || input.disabled || !event.dataTransfer.files.length) return; event.preventDefault(); onPasteFiles(Array.from(event.dataTransfer.files)); }}>
    {dragging && <div className="composer__drop-target" role="status">Drop files to attach</div>}
    {attachments}
    {!!candidates.length && <div id={listId} className="mention-list" role="listbox" aria-label="Mention a section member">{candidates.map((member, index) => <button id={`${listId}-${index}`} type="button" role="option" aria-selected={index === current} key={member.id} tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}><AgentAvatar agent={member} size={22} /><span><strong>{member.name}</strong><small>{member.role}</small></span></button>)}</div>}
    <div className="composer__left">
      <label className="sr-only" htmlFor={input.id}>{label}</label>
      <textarea ref={ref} className="composer__input" rows={1} placeholder={label} maxLength={16000} {...input} aria-autocomplete={mentions.length ? 'list' : undefined} aria-controls={candidates.length ? listId : undefined} aria-activedescendant={candidates.length ? `${listId}-${current}` : undefined} onPaste={event => {
        input.onPaste?.(event);
        if (event.defaultPrevented || input.readOnly || input.disabled) return;
        const files = Array.from(event.clipboardData.files);
        if (files.length && onPasteFiles) {
          onPasteFiles(files);
          // Let Chromium insert text from mixed/rich clipboards normally.
          if (!event.clipboardData.getData('text/plain')) event.preventDefault();
        }
      }} onSelect={event => setCaret(event.currentTarget.selectionStart)} onChange={event => { setCaret(event.currentTarget.selectionStart); setSelected(0); setDismissed(false); input.onChange?.(event); }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (candidates.length) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected((current + (event.key === 'ArrowDown' ? 1 : candidates.length - 1)) % candidates.length); return; }
          if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); choose(current); return; }
          if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return; }
        }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSendKey(event); }
      }} />
    </div>
    <div className="composer__toolbar">
      <Tooltip content={attachmentDisabledReason ?? 'Attach file'}><span className="composer__plus-anchor"><button type="button" className="composer__btn" onClick={onAttach} disabled={!onAttach || !!attachmentDisabledReason} aria-label="Attach conversation file" title={attachmentDisabledReason ?? 'Attach file'}><Plus size={16} aria-hidden /></button></span></Tooltip>
      {recipient}
      <div className="composer__right">
        {retry && !busy && <span className="composer__retry">Retry send</span>}
        {actions}
        {(!stopAction || value.trim() || hasAttachments || retry) && <Tooltip content={sendTitle}><button type="submit" className="composer__cta" disabled={sendDisabled} aria-label={sendLabel} title={sendTitle}>{busy ? <span className="step__spin" aria-hidden /> : <ArrowUp size={16} aria-hidden />}</button></Tooltip>}
        {stopAction}
      </div>
    </div>
  </form>;
}

// One tab stop per turn; arrows reach its links and actions without delaying composer access.
export function ChatTurn({ children, ...props }: ComponentProps<'article'>) {
  const ref = useRef<HTMLElement>(null);
  const selector = 'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"]';
  useLayoutEffect(() => { ref.current?.querySelectorAll<HTMLElement>(selector).forEach(element => { if (!element.closest('form')) element.tabIndex = -1; }); }, [children]);
  return <article {...props} ref={ref} tabIndex={0} onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], [role="listbox"]')) return;
    const actions = Array.from(ref.current?.querySelectorAll<HTMLElement>(selector) ?? []).filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    if (!actions.length) return;
    event.preventDefault();
    const current = actions.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? actions.length - 1 : current < 0 ? event.key === 'ArrowRight' ? 0 : actions.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : actions.length - 1)) % actions.length;
    actions[next]?.focus();
  }}>{children}</article>;
}
