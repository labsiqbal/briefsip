// Adapted from Bot HQ web/src/components/modals/Modal.tsx (MIT, see NOTICE).
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Scrim plus centered dialog. Escape and scrim click close; focus returns to the opener. */
export function Modal({ onClose, children, className, label, title }: { onClose: () => void; children: ReactNode; className?: string; label: string; title?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close.current(); } };
    window.addEventListener('keydown', key);
    const timer = setTimeout(() => ref.current?.querySelector<HTMLElement>('[autofocus], input:not([type="checkbox"]), textarea, select, button:not(.modal__close)')?.focus());
    return () => { window.removeEventListener('keydown', key); clearTimeout(timer); previous?.focus?.(); };
  }, []);
  return createPortal(
    <div className="modal-root">
      <div className="modal-scrim" onMouseDown={onClose} />
      <div ref={ref} className={`modal ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={label}>
        {title !== undefined && <div className="modal__header"><span className="modal__title">{title}</span></div>}
        <button type="button" className="modal__close" onClick={onClose} aria-label="Tutup"><X size={16} aria-hidden /></button>
        {children}
      </div>
    </div>,
    document.body,
  );
}
