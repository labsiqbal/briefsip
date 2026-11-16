// Follow/free-scroll behavior adapted from T3 (MIT); see app/t3/provenance.json.
import { useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from 'react';

export function useTimelineFollow(bottom: RefObject<HTMLDivElement | null>, enabled = true) {
  const transcript = useRef<HTMLElement>(null), nearBottom = useRef(true), lastScrollTop = useRef(0);
  const [showJump, setShowJump] = useState(false);
  function jumpToLatest() {
    const element = transcript.current;
    if (element) { element.scrollTop = element.scrollHeight; lastScrollTop.current = element.scrollTop; }
    nearBottom.current = true; setShowJump(false);
  }
  function onScroll(event: UIEvent<HTMLElement>) {
    const element = event.currentTarget;
    // Delayed programmatic scroll events can arrive after the next streamed block grows.
    if (nearBottom.current && element.scrollTop === lastScrollTop.current) return;
    lastScrollTop.current = element.scrollTop;
    nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
    setShowJump(!nearBottom.current);
  }
  useLayoutEffect(() => {
    const element = transcript.current, content = bottom.current?.parentElement;
    if (!enabled || !element || !content) return;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) { element.scrollTop = element.scrollHeight; lastScrollTop.current = element.scrollTop; }
      else setShowJump(element.scrollHeight - element.scrollTop - element.clientHeight >= 32);
    });
    observer.observe(content); observer.observe(element);
    return () => observer.disconnect();
  }, [bottom, enabled]);
  useLayoutEffect(() => { if (enabled && nearBottom.current) jumpToLatest(); });
  return { transcript, nearBottom, showJump, onScroll, jumpToLatest };
}
