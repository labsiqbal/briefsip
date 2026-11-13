// Briefsip component kit: Radix primitives for behavior, Bot HQ tokens for the look (see kit.css).
import { createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react';
import { AlertDialog, Collapsible as RadixCollapsible, Dialog as RadixDialog, DropdownMenu, Popover, Select as RadixSelect, Switch as RadixSwitch, Tooltip as RadixTooltip } from 'radix-ui';
import { AlertTriangle, Check, ChevronDown, ChevronRight, CircleAlert, Info, X } from 'lucide-react';

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

// ---------- buttons ----------
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'brand'; size?: 'sm' | 'md'; busy?: boolean; icon?: ReactNode };
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', busy, icon, className, children, disabled, type = 'button', ...rest }, ref) {
  return <button ref={ref} type={type} className={cx('k-btn', `k-btn--${variant}`, `k-btn--${size}`, busy && 'is-busy', className)} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
    {busy ? <span className="k-spinner" aria-hidden /> : icon}{children}
  </button>;
});
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(function IconButton({ label, className, children, type = 'button', ...rest }, ref) {
  return <Tooltip content={label}><button ref={ref} type={type} className={cx('k-icon-btn', className)} aria-label={label} {...rest}>{children}</button></Tooltip>;
});

// ---------- fields ----------
type FieldContext = { id: string; hintId: string; errorId: string; describedBy?: string };
const FieldCtx = createContext<FieldContext | null>(null);
export function useField() { return useContext(FieldCtx); }
export function Field({ label, hint, error, children, optional }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; optional?: boolean }) {
  const base = useId(), id = `${base}-input`, hintId = `${base}-hint`, errorId = `${base}-error`;
  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined;
  return <FieldCtx.Provider value={{ id, hintId, errorId, describedBy }}>
    <div className={cx('k-field', !!error && 'is-invalid')}>
      <label className="k-field__label" htmlFor={id}>{label}{optional && <span className="k-field__optional">Opsional</span>}</label>
      {children}
      {hint && <div id={hintId} className="k-field__hint">{hint}</div>}
      {error && <div id={errorId} className="k-field__error" role="alert">{error}</div>}
    </div>
  </FieldCtx.Provider>;
}
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, id, ...rest }, ref) {
  const field = useField();
  return <input ref={ref} id={id ?? field?.id} aria-describedby={field?.describedBy} className={cx('k-input', className)} {...rest} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, id, ...rest }, ref) {
  const field = useField();
  return <textarea ref={ref} id={id ?? field?.id} aria-describedby={field?.describedBy} className={cx('k-input', 'k-textarea', className)} {...rest} />;
});

export type SelectOption = { value: string; label: ReactNode; hint?: ReactNode; disabled?: boolean };
/** Radix Select. Empty-string values are mapped internally because Radix reserves them for "no selection". */
export function Select({ value, onChange, options, disabled, placeholder, name, label, size = 'md' }: { value: string; onChange: (value: string) => void; options: SelectOption[]; disabled?: boolean; placeholder?: string; name?: string; label?: string; size?: 'sm' | 'md' }) {
  const field = useField();
  const encode = (v: string) => v === '' ? '\u0000' : v, decode = (v: string) => v === '\u0000' ? '' : v;
  return <RadixSelect.Root value={encode(value)} onValueChange={next => onChange(decode(next))} disabled={disabled} name={name}>
    <RadixSelect.Trigger id={field?.id} aria-describedby={field?.describedBy} aria-label={label} className={cx('k-input', 'k-select', size === 'sm' && 'k-select--sm')}>
      <RadixSelect.Value placeholder={placeholder} />
      <RadixSelect.Icon className="k-select__chev"><ChevronDown size={14} aria-hidden /></RadixSelect.Icon>
    </RadixSelect.Trigger>
    <RadixSelect.Portal>
      <RadixSelect.Content className="k-pop k-select__content" position="popper" sideOffset={6}>
        <RadixSelect.Viewport className="k-select__viewport">
          {options.map(option => <RadixSelect.Item key={option.value} value={encode(option.value)} disabled={option.disabled} className="k-menu__item k-select__item">
            <span className="k-select__text"><RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>{option.hint && <span className="k-menu__hint">{option.hint}</span>}</span>
            <RadixSelect.ItemIndicator className="k-select__check"><Check size={14} aria-hidden /></RadixSelect.ItemIndicator>
          </RadixSelect.Item>)}
        </RadixSelect.Viewport>
      </RadixSelect.Content>
    </RadixSelect.Portal>
  </RadixSelect.Root>;
}

/** Text input with a suggestion popover; the value stays free text. */
export function Combobox({ value, onChange, suggestions, name, placeholder, readOnly, required, maxLength, emptyText }: { value: string; onChange: (value: string) => void; suggestions: string[]; name?: string; placeholder?: string; readOnly?: boolean; required?: boolean; maxLength?: number; emptyText?: string }) {
  const field = useField();
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const listId = useId();
  const query = value.trim().toLowerCase();
  const items = (query && !suggestions.includes(value) ? suggestions.filter(item => item.toLowerCase().includes(query)) : suggestions).slice(0, 50);
  useEffect(() => { setActive(0); }, [value, open]);
  const choose = (item: string) => { onChange(item); setOpen(false); };
  return <Popover.Root open={open && !readOnly && (items.length > 0 || !!emptyText)} onOpenChange={setOpen}>
    <Popover.Anchor asChild>
      <input id={field?.id} name={name} className="k-input" value={value} placeholder={placeholder} readOnly={readOnly} required={required} maxLength={maxLength} autoComplete="off"
        role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-describedby={field?.describedBy}
        aria-activedescendant={open && items[active] ? `${listId}-${active}` : undefined}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onChange={event => { onChange(event.target.value); setOpen(true); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(index => Math.min(index + 1, items.length - 1)); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
          else if (event.key === 'Enter' && open && items[active]) { event.preventDefault(); choose(items[active]); }
          else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
        }} />
    </Popover.Anchor>
    <Popover.Portal>
      <Popover.Content className="k-pop k-combobox__content" align="start" sideOffset={6} onOpenAutoFocus={event => event.preventDefault()} onInteractOutside={event => { if ((event.target as HTMLElement | null)?.id === field?.id) event.preventDefault(); }}>
        <ul id={listId} role="listbox" className="k-combobox__list">
          {items.map((item, index) => <li key={item} id={`${listId}-${index}`} role="option" aria-selected={item === value} className={cx('k-menu__item', index === active && 'is-active')} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>
            <span className="k-combobox__value">{item}</span>{item === value && <Check size={14} aria-hidden />}
          </li>)}
          {!items.length && emptyText && <li className="k-combobox__empty">{emptyText}</li>}
        </ul>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return <RadixSwitch.Root className="k-switch" checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label}><RadixSwitch.Thumb className="k-switch__thumb" /></RadixSwitch.Root>;
}

export function Segmented<T extends string>({ value, onChange, options, label, disabled }: { value: T; onChange: (value: T) => void; options: { value: T; label: ReactNode; description?: ReactNode }[]; label: string; disabled?: boolean }) {
  return <div className="k-choice" role="radiogroup" aria-label={label}>
    {options.map(option => <button key={option.value} type="button" role="radio" aria-checked={value === option.value} disabled={disabled} className={cx('k-choice__opt', value === option.value && 'is-active')} onClick={() => onChange(option.value)}>
      <span className="k-choice__title">{option.label}</span>{option.description && <span className="k-choice__sub">{option.description}</span>}
    </button>)}
  </div>;
}

// ---------- surfaces ----------
export function Alert({ tone = 'info', title, children, actions }: { tone?: 'info' | 'warn' | 'error'; title?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  const Icon = tone === 'error' ? CircleAlert : tone === 'warn' ? AlertTriangle : Info;
  return <div className={cx('k-alert', `is-${tone}`)} role={tone === 'error' ? 'alert' : 'status'}>
    <Icon size={16} aria-hidden className="k-alert__icon" />
    <div className="k-alert__body">{title && <div className="k-alert__title">{title}</div>}{children && <div className="k-alert__text">{children}</div>}{actions && <div className="k-alert__actions">{actions}</div>}</div>
  </div>;
}
export function Section({ title, actions, children, id }: { title: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return <section className="k-section" aria-labelledby={id}>
    <div className="k-section__head"><h2 className="k-section__title" id={id}>{title}</h2>{actions && <div className="k-section__actions">{actions}</div>}</div>
    {children}
  </section>;
}
export function Card({ children, className }: { children: ReactNode; className?: string }) { return <div className={cx('k-card', className)}>{children}</div>; }
export function Row({ title, meta, leading, trailing, onClick, disabled, children }: { title: ReactNode; meta?: ReactNode; leading?: ReactNode; trailing?: ReactNode; onClick?: () => void; disabled?: boolean; children?: ReactNode }) {
  const body = <>{leading && <span className="k-row__leading">{leading}</span>}<span className="k-row__text"><span className="k-row__title">{title}</span>{meta && <span className="k-row__meta">{meta}</span>}{children}</span></>;
  return <div className={cx('k-row', onClick && 'is-clickable')}>
    {onClick ? <button type="button" className="k-row__main" onClick={onClick} disabled={disabled}>{body}{!trailing && <ChevronRight size={16} aria-hidden className="k-row__chev" />}</button> : <div className="k-row__main">{body}</div>}
    {trailing && <span className="k-row__trailing">{trailing}</span>}
  </div>;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'brand' | 'success' | 'warn' }) { return <span className={cx('k-badge', `is-${tone}`)}>{children}</span>; }
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return <div className="k-empty">{icon && <span className="k-empty__icon" aria-hidden>{icon}</span>}<div className="k-empty__title">{title}</div>{children && <div className="k-empty__text">{children}</div>}{action}</div>;
}
export function SkeletonRows({ count = 3 }: { count?: number }) {
  return <div className="k-card" aria-hidden>{Array.from({ length: count }, (_, index) => <div key={index} className="k-row"><div className="k-row__main"><span className="k-row__text"><span className="k-skeleton" style={{ width: `${46 + (index * 17) % 30}%` }} /><span className="k-skeleton is-small" style={{ width: `${22 + (index * 11) % 20}%` }} /></span></div></div>)}</div>;
}
export function PageHeader({ title, description, actions, headingRef }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; headingRef?: Ref<HTMLHeadingElement> }) {
  return <header className="k-page-head"><div className="k-page-head__text"><h1 ref={headingRef} tabIndex={-1}>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="k-page-head__actions">{actions}</div>}</header>;
}

export function Collapsible({ title, children, defaultOpen = false }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return <RadixCollapsible.Root className="k-collapsible" defaultOpen={defaultOpen}>
    <RadixCollapsible.Trigger className="k-collapsible__trigger"><ChevronRight size={14} aria-hidden className="k-collapsible__chev" />{title}</RadixCollapsible.Trigger>
    {/* Force-mounted so fields inside stay part of their form while collapsed. */}
    <RadixCollapsible.Content forceMount className="k-collapsible__content">{children}</RadixCollapsible.Content>
  </RadixCollapsible.Root>;
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return <RadixTooltip.Provider delayDuration={400}><RadixTooltip.Root><RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger><RadixTooltip.Portal><RadixTooltip.Content className="k-tooltip" sideOffset={6}>{content}</RadixTooltip.Content></RadixTooltip.Portal></RadixTooltip.Root></RadixTooltip.Provider>;
}

export type MenuEntry = { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; icon?: ReactNode } | 'separator';
export function ActionMenu({ trigger, items, align = 'end', label }: { trigger: ReactNode; items: MenuEntry[]; align?: 'start' | 'center' | 'end'; label: string }) {
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild aria-label={label}>{trigger}</DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="k-pop k-menu" align={align} sideOffset={6}>
      {items.map((item, index) => item === 'separator' ? <DropdownMenu.Separator key={index} className="k-menu__sep" /> : <DropdownMenu.Item key={item.label} disabled={item.disabled} onSelect={item.onSelect} className={cx('k-menu__item', item.danger && 'is-danger')}>{item.icon}{item.label}</DropdownMenu.Item>)}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

// ---------- dialogs ----------
export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'md' }: { open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'md' | 'lg' }) {
  return <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="k-overlay" />
      <RadixDialog.Content className={cx('k-dialog', `k-dialog--${size}`)} onOpenAutoFocus={event => {
        const body = (event.currentTarget as HTMLElement).querySelector('.k-dialog__body');
        const first = body?.querySelector<HTMLElement>(':is(input:not([type=hidden]):not([type=number]), textarea):not([readonly]):not(:disabled)') ?? body?.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]');
        if (first) { event.preventDefault(); first.focus(); }
      }}>
        <div className="k-dialog__head">
          <div><RadixDialog.Title className="k-dialog__title">{title}</RadixDialog.Title>{description ? <RadixDialog.Description className="k-dialog__desc">{description}</RadixDialog.Description> : <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>}</div>
          <RadixDialog.Close asChild><button type="button" className="k-icon-btn" aria-label="Tutup"><X size={16} aria-hidden /></button></RadixDialog.Close>
        </div>
        <div className="k-dialog__body">{children}</div>
        {footer && <div className="k-dialog__foot">{footer}</div>}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  </RadixDialog.Root>;
}

type ConfirmRequest = { title: string; description?: ReactNode; confirm?: string; danger?: boolean; resolve: (ok: boolean) => void };
const ConfirmCtx = createContext<((request: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>) | null>(null);
/** Promise-based confirmation that replaces window.confirm with an accessible alert dialog. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const ask = useCallback((next: Omit<ConfirmRequest, 'resolve'>) => new Promise<boolean>(resolve => setRequest({ ...next, resolve })), []);
  const settle = (ok: boolean) => { request?.resolve(ok); setRequest(null); };
  return <ConfirmCtx.Provider value={ask}>
    {children}
    <AlertDialog.Root open={!!request} onOpenChange={open => { if (!open) settle(false); }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="k-overlay" />
        <AlertDialog.Content className="k-dialog k-dialog--sm">
          <div className="k-dialog__head"><div><AlertDialog.Title className="k-dialog__title">{request?.title}</AlertDialog.Title>{request?.description ? <AlertDialog.Description className="k-dialog__desc">{request.description}</AlertDialog.Description> : <AlertDialog.Description className="sr-only">{request?.title}</AlertDialog.Description>}</div></div>
          <div className="k-dialog__foot">
            <AlertDialog.Cancel asChild><Button>Batal</Button></AlertDialog.Cancel>
            <AlertDialog.Action asChild><Button variant={request?.danger ? 'danger' : 'primary'} onClick={() => settle(true)}>{request?.confirm ?? 'Lanjutkan'}</Button></AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  </ConfirmCtx.Provider>;
}
export function useConfirm() {
  const ask = useContext(ConfirmCtx);
  const fallback = useRef((request: Omit<ConfirmRequest, 'resolve'>) => Promise.resolve(window.confirm(request.title)));
  return ask ?? fallback.current;
}
