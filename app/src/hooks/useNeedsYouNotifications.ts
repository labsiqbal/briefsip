import { readProductStorage } from '../rename-storage.ts';
import { createContext, useContext, useEffect, useRef, useState } from 'react';

export const notificationMuteKey = 'minarbot:workflow-notifications-muted';

export type TurnDestination = {
  agent: string;
  thread: string | null;
  channel: string | null;
  turn: string;
  focus: string;
};

export type PendingInput = TurnDestination & {
  kind: 'question' | 'app' | 'harness' | 'computer';
  request: string;
};

export const NeedsYouFocus = createContext<{ scope: string; turn: string; card?: string; consume: () => void } | null>(null);

export function focusNeedsYouTarget(target: HTMLElement) {
  target.scrollIntoView({ block: 'start', behavior: 'instant' });
  target.focus({ preventScroll: true });
}

export function useNeedsYouFocus(scope: string, onFocus: (turn: string, card?: string) => void) {
  const attention = useContext(NeedsYouFocus);
  const focus = useRef(onFocus);
  focus.current = onFocus;

  useEffect(() => {
    if (attention?.scope !== scope) return;
    focus.current(attention.turn, attention.card);
    // Clicking a selected agent can refocus the same card without reloading history.
    const target = attention.card && document.getElementById(attention.card);
    if (target) focusNeedsYouTarget(target);
    attention.consume();
  }, [attention, scope]);
}

type FinishedTurn = TurnDestination & { status: 'done' | 'failed' };
type AttentionSnapshot = { pending: PendingInput[]; finished: FinishedTurn[] };

export function requestKey(input: Pick<PendingInput, 'turn' | 'kind' | 'request'>) {
  return `${input.kind}:${input.turn}:${input.request}`;
}

const deliveredKey = 'minarbot:needs-you-delivered';

export function claimNotification(storage: Pick<Storage, 'getItem' | 'setItem'>, id: string) {
  try {
    const saved: unknown = JSON.parse(readProductStorage(storage, deliveredKey) ?? '[]');
    const ids = Array.isArray(saved) ? saved.filter((value): value is string => typeof value === 'string') : [];
    if (ids.includes(id)) return false;
    // ponytail: bounded browser history. Use server receipts if delivery spans devices.
    storage.setItem(deliveredKey, JSON.stringify([...ids.slice(-999), id]));
    return true;
  } catch {
    return false;
  }
}

export function useNeedsYouNotifications(onOpen: (target: TurnDestination, input?: PendingInput) => void) {
  const [pending, setPending] = useState<PendingInput[] | null>(null);
  const open = useRef(onOpen);
  open.current = onOpen;

  useEffect(() => {
    const stream = new EventSource('/api/sidebar/stream');
    let previous: Set<string> | undefined;
    stream.onmessage = event => {
      const snapshot = JSON.parse(event.data) as AttentionSnapshot;
      const notices = [
        ...snapshot.pending.map(input => ({ id: requestKey(input), target: input, input, title: 'An agent needs you' })),
        ...snapshot.finished.map(target => ({ id: `finished:${target.turn}`, target, input: undefined, title: target.status === 'failed' ? 'An agent turn failed' : 'An agent finished' })),
      ];
      const before = previous;
      previous = new Set(notices.map(notice => notice.id));
      setPending(snapshot.pending);
      if (!before || !document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      for (const notice of notices) {
        if (before.has(notice.id)) continue;
        try {
          if (readProductStorage(localStorage, notificationMuteKey) === '1' || !claimNotification(localStorage, notice.id)) continue;
          const notification = new Notification(notice.title, { body: 'Open Minarbot to view the conversation.', tag: `minarbot:${notice.id}` });
          notification.onclick = () => { window.focus(); open.current(notice.target, notice.input); notification.close(); };
        } catch { /* Browser permissions and storage can change while the app is open. */ }
      }
    };
    stream.onerror = () => setPending(null);
    return () => stream.close();
  }, []);

  return pending;
}
