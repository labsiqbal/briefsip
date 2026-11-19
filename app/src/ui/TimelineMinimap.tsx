// Adapted from T3 (MIT); source hashes and notices: app/t3/provenance.json.
import { useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { IconButton } from './kit';
import { forwardWheelToTimeline } from './timelineMinimapWheel';
import { resolveTimelineMinimapHeightStyle, resolveTimelineMinimapIndexFromPointer, resolveTimelineMinimapPreview, resolveTimelineMinimapTopPercent, TIMELINE_MINIMAP_MIN_ITEMS, type TimelineMinimapItem } from './timelineMinimapItems';

export function TimelineMinimap({ items, viewport, onNavigate }: {
  items: readonly TimelineMinimapItem[]; viewport: RefObject<HTMLElement | null>; onNavigate: () => void;
}) {
  const strips = useRef(new Map<string, HTMLSpanElement>());
  const [active, setActive] = useState<number | null>(null);
  const [metrics, setMetrics] = useState({ width: 0, persistent: false, current: 0, atEnd: true, scrollable: false });
  const pressed = useRef(false), release = useRef<(() => void) | null>(null);
  const [passThrough, setPassThrough] = useState(false);
  useLayoutEffect(() => () => release.current?.(), []);
  useLayoutEffect(() => {
    const timeline = viewport.current, content = timeline?.firstElementChild;
    if (!timeline || !content) return;
    let frame = 0;
    const refresh = () => {
      frame = 0;
      const bounds = timeline.getBoundingClientRect();
      const gutter = Math.max(0, (timeline.clientWidth - content.getBoundingClientRect().width) / 2);
      let current = 0, found = false;
      for (const [index, item] of items.entries()) {
        const row = document.getElementById(`turn-${item.id}`), strip = strips.current.get(item.id);
        const rect = row?.querySelector('.human-message')?.getBoundingClientRect();
        const visible = !!rect && rect.top < bounds.bottom && rect.bottom > bounds.top;
        if (strip && strip.dataset.inView !== String(visible)) strip.dataset.inView = String(visible);
        if (!found && visible) { current = index; found = true; }
        else if (!found && rect && rect.top < bounds.top) current = index;
      }
      const scrollRange = timeline.scrollHeight - timeline.clientHeight;
      const next = { width: Math.max(8, Math.min(40, Math.floor(gutter) - 12)), persistent: gutter >= 64, current, atEnd: scrollRange - timeline.scrollTop <= 1, scrollable: scrollRange > 1 };
      setMetrics(old => old.width === next.width && old.persistent === next.persistent && old.current === next.current && old.atEnd === next.atEnd && old.scrollable === next.scrollable ? old : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(refresh); };
    const observer = new ResizeObserver(schedule);
    observer.observe(timeline); observer.observe(content);
    timeline.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => { observer.disconnect(); timeline.removeEventListener('scroll', schedule); cancelAnimationFrame(frame); };
  }, [items, viewport]);

  const preview = resolveTimelineMinimapPreview(active === null ? null : items[active] ?? null);
  const select = (item: TimelineMinimapItem | undefined) => {
    const timeline = viewport.current, row = item && document.getElementById(`turn-${item.id}`);
    if (!timeline || !row) return;
    onNavigate();
    timeline.scrollTop += row.getBoundingClientRect().top - timeline.getBoundingClientRect().top - parseFloat(getComputedStyle(timeline).scrollPaddingTop);
  };
  const pointerIndex = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return resolveTimelineMinimapIndexFromPointer(items.length, rect.top, rect.height, event.clientY);
  };
  const trackRelease = () => {
    release.current?.();
    const controller = new AbortController();
    const check = (event: globalThis.MouseEvent) => {
      if (event.buttons) return;
      controller.abort(); pressed.current = false; setPassThrough(false);
    };
    window.addEventListener('mouseup', check, { signal: controller.signal });
    window.addEventListener('mousemove', check, { signal: controller.signal });
    release.current = () => controller.abort();
  };
  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS || !metrics.persistent || !metrics.scrollable) return null;
  return <div className="timeline-minimap" data-persistent-gutter={metrics.persistent} data-testid="timeline-minimap" ref={node => {
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!viewport.current || event.defaultPrevented || event.ctrlKey || !event.deltaY) return;
      onNavigate(); forwardWheelToTimeline(event, viewport.current);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }}>
    <div className="timeline-minimap__rail" style={{ height: resolveTimelineMinimapHeightStyle(items.length), width: metrics.width, pointerEvents: passThrough ? 'none' : undefined }}
      onMouseDown={() => { pressed.current = true; trackRelease(); }}
      onMouseMove={event => { if (event.buttons && !pressed.current && !passThrough) { setActive(null); setPassThrough(true); trackRelease(); } }}>
      {metrics.width >= 14 && <IconButton className="timeline-minimap__previous" label="Previous turn" disabled={metrics.current === 0} onClick={() => select(items[metrics.current - 1])}><ChevronUp size={16} aria-hidden /></IconButton>}
      <button type="button" className="timeline-minimap__hit" aria-label={`Jump to message: ${preview?.userText ?? 'User message'}`}
        onFocus={() => setActive(value => value ?? metrics.current)} onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)} onMouseMove={event => { if (!event.buttons || pressed.current) setActive(pointerIndex(event)); }}
        onMouseDown={event => event.preventDefault()}
        onClick={event => { const index = pointerIndex(event); if (index !== null) select(items[index]); event.currentTarget.blur(); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(value => Math.max(0, Math.min(items.length - 1, (value ?? metrics.current) + (event.key === 'ArrowDown' ? 1 : -1)))); }
          else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setActive(event.key === 'Home' ? 0 : items.length - 1); }
          else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (active !== null) select(items[active]); }
          else if (event.key === 'Escape') { setActive(null); event.currentTarget.blur(); }
        }}>
        {items.map((item, index) => {
          const distance = active === null ? Infinity : Math.abs(index - active);
          return <span key={item.id} aria-hidden="true" data-minimap-strip data-turn={item.id} data-in-view="false" className="timeline-minimap__tick"
            ref={node => { if (node) strips.current.set(item.id, node); else strips.current.delete(item.id); }}
            style={{ top: `${resolveTimelineMinimapTopPercent(index, items.length)}%`, transform: `translateY(-50%) scaleX(${distance === 0 ? 1 : distance === 1 ? .667 : distance === 2 ? .417 : .333})` }} />;
        })}
        {preview && active !== null && <span className="timeline-minimap__preview" style={{ top: `${resolveTimelineMinimapTopPercent(active, items.length)}%` }}>
          <strong>{preview.userText ?? 'User message'}</strong>{preview.assistantText && <span>{preview.assistantText}</span>}
        </span>}
      </button>
      {metrics.width >= 14 && <IconButton className="timeline-minimap__next" label="Next turn" disabled={metrics.atEnd || metrics.current >= items.length - 1} onClick={() => select(items[metrics.current + 1])}><ChevronDown size={16} aria-hidden /></IconButton>}
    </div>
  </div>;
}
