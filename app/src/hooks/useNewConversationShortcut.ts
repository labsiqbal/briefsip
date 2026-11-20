import { useEffect } from 'react';

export function useNewConversationShortcut(create: () => void) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || !event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'o' || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      event.preventDefault(); create();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('minarbot:new-conversation', create);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('minarbot:new-conversation', create); };
  }, [create]);
}
