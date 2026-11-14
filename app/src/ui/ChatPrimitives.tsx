import { ArrowUp, ChevronDown, Paperclip } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type ComponentProps, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { AgentAvatar } from '../AgentAvatar';

type ChatAgent = ComponentProps<typeof AgentAvatar>['agent'];

export function ChatHeader({ agent, title = agent.name, onToggle, expanded, menu, pillRef, tooltip, right }: {
  agent: ChatAgent; title?: string; onToggle?: () => void; expanded?: boolean; menu?: ReactNode; pillRef?: RefObject<HTMLDivElement | null>; tooltip?: string; right: ReactNode;
}) {
  const identity = <><AgentAvatar agent={agent} size={24} /><span className="chat__pill-name">{title}</span></>;
  return <header className="chat__header">
    <span className="chat__pill-anchor">
      {onToggle ? <button type="button" className="chat__pill" onClick={onToggle} aria-haspopup="menu" aria-expanded={expanded}>{identity}<ChevronDown size={14} aria-hidden className="chat__pill-chev" /></button>
        : <div ref={pillRef} tabIndex={-1} className="chat__pill" title={tooltip}>{identity}</div>}
      {menu}
    </span>
    <div className="chat__header-right">{right}</div>
  </header>;
}

export function ChatTranscript({ children, ...props }: ComponentProps<'section'>) {
  return <div className="transcript-wrap"><section className="transcript" aria-label="Conversation history" {...props}><div className="transcript__col">{children}</div></section></div>;
}

export function ChatEmptyState({ agent, title = `Start with ${agent.name}`, children }: { agent: ChatAgent; title?: string; children: ReactNode }) {
  return <div className="empty-chat"><AgentAvatar agent={agent} size={64} /><div className="empty-chat__title">{title}</div><div className="empty-chat__sub">{children}</div></div>;
}

export function HumanMessage({ text, label = 'Your message', attachments, children }: { text: string; label?: string; attachments?: ReactNode; children: ReactNode }) {
  return <div className="human-message" tabIndex={0} aria-label={label}><div className="human-bubble message-plain">{text}</div>{attachments}<div className="turn-meta human-meta">{children}</div></div>;
}

export function AgentMessage({ identity, children }: { identity?: ReactNode; children: ReactNode }) {
  return <div className="agent-message">{identity}<div className="message-column">{children}</div></div>;
}

export function TurnStatus({ tone, label, model }: { tone: string; label: string; model?: string | null }) {
  return <div className="turn-meta agent-meta"><span className={`turn-status is-${tone}`}><i aria-hidden />{label}</span>{model && <span className="turn-model" title="Answering model">{model}</span>}</div>;
}

export function ChatComposer({ label, input, inputRef, onSubmit, onSendKey, onAttach, attachmentDisabledReason, recipient, busy, retry, sendDisabled, sendLabel, sendTitle, multiline, mentions = [], onMention }: {
  mentions?: { id: string; name: string; role: string }[]; onMention?: (value: string) => void;
  label: string; input: ComponentProps<'textarea'>; inputRef?: RefObject<HTMLTextAreaElement | null>; onSubmit: (event: FormEvent) => void; onSendKey: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onAttach?: () => void; attachmentDisabledReason?: string; recipient?: ReactNode; busy: boolean; retry: boolean; sendDisabled: boolean; sendLabel: string; sendTitle: string; multiline?: boolean;
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null), ref = inputRef ?? ownRef;
  const listId = useId();
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
  return <form className={`composer${(multiline ?? String(input.value ?? '').includes('\n')) ? ' is-multiline' : ''}`} onSubmit={onSubmit}>
    {!!candidates.length && <div id={listId} className="mention-list" role="listbox" aria-label="Mention a room member">{candidates.map((member, index) => <button id={`${listId}-${index}`} type="button" role="option" aria-selected={index === current} key={member.id} tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}><AgentAvatar agent={member} size={22} /><span><strong>{member.name}</strong><small>{member.role}</small></span></button>)}</div>}
    <div className="composer__left">
      <span className="composer__plus-anchor" title={attachmentDisabledReason}><button type="button" className="composer__btn" onClick={onAttach} disabled={!onAttach} aria-label="Attach conversation file" title={attachmentDisabledReason ?? 'Attach file'}><Paperclip size={14} aria-hidden /></button></span>
      {recipient}
      <label className="sr-only" htmlFor={input.id}>{label}</label>
      <textarea ref={ref} className="composer__input" rows={1} placeholder={label} maxLength={16000} {...input} aria-autocomplete={mentions.length ? 'list' : undefined} aria-controls={candidates.length ? listId : undefined} aria-activedescendant={candidates.length ? `${listId}-${current}` : undefined} onSelect={event => setCaret(event.currentTarget.selectionStart)} onChange={event => { setCaret(event.currentTarget.selectionStart); setSelected(0); setDismissed(false); input.onChange?.(event); }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (candidates.length) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected((current + (event.key === 'ArrowDown' ? 1 : candidates.length - 1)) % candidates.length); return; }
          if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); choose(current); return; }
          if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return; }
        }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSendKey(event); }
      }} />
    </div>
    <div className="composer__right">
      {retry && !busy && <span className="composer__retry">Retry send</span>}
      <button type="submit" className="composer__cta" disabled={sendDisabled} aria-label={sendLabel} title={sendTitle}>{busy ? <span className="step__spin" aria-hidden /> : <ArrowUp size={16} aria-hidden />}</button>
    </div>
  </form>;
}
