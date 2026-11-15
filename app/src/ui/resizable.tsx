import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Separator } from 'radix-ui';
import { clampPanelWidth, maxPanelWidth } from '../../panel-width';

/** A side panel whose width the user drags, kept per browser. `edge` is where the handle sits. */
export type PanelSpec = { key: string; label: string; edge: 'left' | 'right'; defaultWidth: number; minWidth: number };

export const sidebarPanel: PanelSpec = { key: 'briefsip:sidebar-width', label: 'Resize sidebar', edge: 'right', defaultWidth: 300, minWidth: 240 };
export const detailsPanel: PanelSpec = { key: 'briefsip:details-width', label: 'Resize details', edge: 'left', defaultWidth: 360, minWidth: 280 };

function readWidth(spec: PanelSpec) {
  try {
    const saved = localStorage.getItem(spec.key);
    const value = saved?.trim() ? Number(saved) : NaN;
    return Number.isFinite(value) ? value : spec.defaultWidth;
  } catch {
    return spec.defaultWidth;
  }
}

function saveWidth(spec: PanelSpec, width: number) {
  try { localStorage.setItem(spec.key, String(width)); } catch { /* The width still applies to this page. */ }
}

export function useResizablePanel(spec: PanelSpec, reservedWidth = 0) {
  const [element, ref] = useState<HTMLElement | null>(null);
  const [available, setAvailable] = useState(() => typeof window === 'undefined' ? 1280 : window.innerWidth);
  const maxWidth = maxPanelWidth(available, reservedWidth);
  const [saved, setSaved] = useState(() => ({ key: spec.key, width: readWidth(spec) }));
  // Read each conversation's preference on navigation, even if this hook stays mounted.
  if (saved.key !== spec.key) setSaved({ key: spec.key, width: readWidth(spec) });
  const width = clampPanelWidth(saved.key === spec.key ? saved.width : readWidth(spec), spec.minWidth, maxWidth);
  const setWidth = useCallback((value: number) => {
    const next = clampPanelWidth(value, spec.minWidth, maxWidth);
    setSaved({ key: spec.key, width: next });
    saveWidth(spec, next);
  }, [spec, maxWidth]);

  useLayoutEffect(() => {
    const parent = element?.parentElement;
    if (!parent) return;
    const measure = () => setAvailable(parent.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [element]);

  // Viewport clamping never overwrites the preferred width; growing the window restores it.
  return { ref, spec, width, maxWidth, setWidth };
}

/** While any panel drags, the document carries `is-panel-resizing` so text selection and transitions pause. */
function setResizing(on: boolean) {
  document.documentElement.classList.toggle('is-panel-resizing', on);
}

export function PanelResizeHandle({ panel }: { panel: ReturnType<typeof useResizablePanel> }) {
  const { spec, width, maxWidth, setWidth } = panel;
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  useEffect(() => () => setResizing(false), []);
  // A handle on the panel's left edge grows the panel when dragged left.
  const direction = spec.edge === 'right' ? 1 : -1;

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    event.currentTarget.removeAttribute('data-dragging');
    setResizing(false);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.setAttribute('data-dragging', '');
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    setResizing(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    setWidth(drag.current.startWidth + direction * (event.clientX - drag.current.startX));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | undefined;
    if (event.key === 'ArrowLeft') next = width - 16 * direction;
    else if (event.key === 'ArrowRight') next = width + 16 * direction;
    else if (event.key === 'Home') next = spec.minWidth;
    else if (event.key === 'End') next = maxWidth;
    if (next === undefined) return;
    event.preventDefault();
    setWidth(next);
  };

  return <Separator.Root
    className={`panel-resize-handle panel-resize-handle--${spec.edge}`}
    decorative={false}
    orientation="vertical"
    aria-label={spec.label}
    aria-orientation="vertical"
    aria-valuemin={Math.min(spec.minWidth, maxWidth)}
    aria-valuemax={maxWidth}
    aria-valuenow={width}
    aria-valuetext={`${width} pixels`}
    tabIndex={0}
    onKeyDown={handleKeyDown}
    onPointerDown={handlePointerDown}
    onPointerMove={handlePointerMove}
    onPointerUp={endDrag}
    onPointerCancel={endDrag}
    onLostPointerCapture={endDrag}
    onDoubleClick={() => setWidth(spec.defaultWidth)}
  />;
}
