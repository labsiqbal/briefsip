import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Separator } from 'radix-ui';

/** A side panel whose width the user drags, kept per browser. `edge` is where the handle sits. */
export type PanelSpec = { key: string; label: string; edge: 'left' | 'right'; defaultWidth: number; minWidth: number; maxWidth: number; maxFraction: number };

export const sidebarPanel: PanelSpec = { key: 'briefsip:sidebar-width', label: 'Resize sidebar', edge: 'right', defaultWidth: 350, minWidth: 240, maxWidth: 480, maxFraction: 0.45 };
export const detailsPanel: PanelSpec = { key: 'briefsip:details-width', label: 'Resize details', edge: 'left', defaultWidth: 360, minWidth: 280, maxWidth: 560, maxFraction: 0.4 };

function viewportWidth() {
  return typeof window === 'undefined' ? 1280 : window.innerWidth;
}

function maxPanelWidth(spec: PanelSpec, viewport: number) {
  return Math.min(spec.maxWidth, Math.floor(viewport * spec.maxFraction));
}

function clampWidth(spec: PanelSpec, value: number, max: number) {
  // On narrow windows the viewport cap takes precedence over the preferred minimum.
  return Math.min(max, Math.max(Math.min(spec.minWidth, max), Math.round(value)));
}

function readWidth(spec: PanelSpec, max: number) {
  try {
    const saved = localStorage.getItem(spec.key);
    const value = saved?.trim() ? Number(saved) : NaN;
    return clampWidth(spec, Number.isFinite(value) ? value : spec.defaultWidth, max);
  } catch {
    return clampWidth(spec, spec.defaultWidth, max);
  }
}

function saveWidth(spec: PanelSpec, width: number) {
  try { localStorage.setItem(spec.key, String(width)); } catch { /* The width still applies to this page. */ }
}

export function useResizablePanel(spec: PanelSpec) {
  const [viewport, setViewport] = useState(viewportWidth);
  const maxWidth = maxPanelWidth(spec, viewport);
  const [width, setWidthState] = useState(() => readWidth(spec, maxPanelWidth(spec, viewportWidth())));

  const setWidth = useCallback((value: number) => {
    const next = clampWidth(spec, value, maxWidth);
    setWidthState(next);
    saveWidth(spec, next);
  }, [spec, maxWidth]);

  useEffect(() => {
    const resize = () => {
      setViewport(window.innerWidth);
      const nextMax = maxPanelWidth(spec, window.innerWidth);
      setWidthState(current => {
        const next = clampWidth(spec, current, nextMax);
        if (next !== current) saveWidth(spec, next);
        return next;
      });
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [spec]);

  return { spec, width, maxWidth, setWidth };
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
