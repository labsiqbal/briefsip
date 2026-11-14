import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Separator } from 'radix-ui';

const SIDEBAR_DEFAULT_WIDTH = 350;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 480;
const sidebarWidthKey = 'briefsip:sidebar-width';

function viewportWidth() {
  return typeof window === 'undefined' ? 1280 : window.innerWidth;
}

function maxSidebarWidth(viewport: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.floor(viewport * 0.45));
}

function clampWidth(value: number, max: number) {
  // Below 534px, the strict viewport cap takes precedence over the preferred minimum.
  return Math.min(max, Math.max(Math.min(SIDEBAR_MIN_WIDTH, max), Math.round(value)));
}

function readWidth(max: number) {
  try {
    const saved = localStorage.getItem(sidebarWidthKey);
    const value = saved?.trim() ? Number(saved) : NaN;
    return clampWidth(Number.isFinite(value) ? value : SIDEBAR_DEFAULT_WIDTH, max);
  } catch {
    return clampWidth(SIDEBAR_DEFAULT_WIDTH, max);
  }
}

function saveWidth(width: number) {
  try { localStorage.setItem(sidebarWidthKey, String(width)); } catch { /* The width still applies to this page. */ }
}

export function useResizableSidebar() {
  const [viewport, setViewport] = useState(viewportWidth);
  const maxWidth = maxSidebarWidth(viewport);
  const [width, setWidthState] = useState(() => readWidth(maxSidebarWidth(viewportWidth())));
  const [isDragging, setIsDragging] = useState(false);

  const setWidth = useCallback((value: number) => {
    const next = clampWidth(value, maxWidth);
    setWidthState(next);
    saveWidth(next);
  }, [maxWidth]);

  useEffect(() => {
    const resize = () => {
      setViewport(window.innerWidth);
      const nextMax = maxSidebarWidth(window.innerWidth);
      setWidthState(current => {
        const next = clampWidth(current, nextMax);
        if (next !== current) saveWidth(next);
        return next;
      });
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  return { width, maxWidth, isDragging, setWidth, setIsDragging };
}

type SidebarResizeHandleProps = {
  width: number;
  maxWidth: number;
  onWidthChange: (width: number) => void;
  onDraggingChange: (dragging: boolean) => void;
};

export function SidebarResizeHandle({ width, maxWidth, onWidthChange, onDraggingChange }: SidebarResizeHandleProps) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  useEffect(() => () => onDraggingChange(false), [onDraggingChange]);

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    onDraggingChange(false);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    onDraggingChange(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    onWidthChange(drag.current.startWidth + event.clientX - drag.current.startX);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | undefined;
    if (event.key === 'ArrowLeft') next = width - 16;
    else if (event.key === 'ArrowRight') next = width + 16;
    else if (event.key === 'Home') next = SIDEBAR_MIN_WIDTH;
    else if (event.key === 'End') next = maxWidth;
    if (next === undefined) return;
    event.preventDefault();
    onWidthChange(next);
  };

  return <Separator.Root
    className="sidebar__resize-handle"
    decorative={false}
    orientation="vertical"
    aria-label="Resize sidebar"
    aria-orientation="vertical"
    aria-valuemin={Math.min(SIDEBAR_MIN_WIDTH, maxWidth)}
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
    onDoubleClick={() => onWidthChange(SIDEBAR_DEFAULT_WIDTH)}
  />;
}
