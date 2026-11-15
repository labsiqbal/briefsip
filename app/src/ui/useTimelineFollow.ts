// Follow/free-scroll behavior adapted from T3 (MIT); see app/t3/provenance.json.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from 'react';

export function useTimelineFollow(bottom: RefObject<HTMLDivElement | null>, enabled = true) {
  const transcript = useRef<HTMLElement>(null), nearBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  function jumpToLatest() {
    const element = transcript.current;
    if (element) element.scrollTop = element.scrollHeight;
    nearBottom.current = true; setShowJump(false);
  }
  function onScroll(event: UIEvent<HTMLElement>) {
    const element = event.currentTarget;
    nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
    setShowJump(!nearBottom.current);
  }
  useLayoutEffect(() => {
    const element = transcript.current, content = bottom.current?.parentElement;
    if (!enabled || !element || !content) return;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) element.scrollTop = element.scrollHeight;
      else setShowJump(element.scrollHeight - element.scrollTop - element.clientHeight >= 32);
    });
    observer.observe(content); observer.observe(element);
    return () => observer.disconnect();
  }, [bottom, enabled]);
  useEffect(() => { if (enabled && nearBottom.current) jumpToLatest(); }, []);
  return { transcript, nearBottom, showJump, onScroll, jumpToLatest };
}
