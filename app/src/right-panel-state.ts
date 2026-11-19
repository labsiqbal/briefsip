export const rightPanelKey = (scope: string) => `briefsip:right-panel:${scope}`;
export const rightPanelWidthKey = (scope: string) => `briefsip:right-panel-width:${scope}`;
export type RunTarget = { turnId: string; stepId?: string };
export type RightPanelState = { tab: string; width: number };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export function parseRightPanelState(tab: string | null, width: string | null): RightPanelState {
  let selected = 'chats';
  try { const value: unknown = JSON.parse(tab ?? 'null'); if (typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value)) selected = value; } catch { /* Invalid preferences use defaults. */ }
  const pixels = width?.trim() ? Number(width) : NaN;
  return { tab: selected === 'browser' ? 'computer' : ['details', 'activity', 'run'].includes(selected) ? 'chats' : selected, width: Number.isFinite(pixels) ? Math.max(280, Math.round(pixels)) : 360 };
}
export function createRightPanelStore(storage: Storage) {
  return {
    read(scope: string): RightPanelState { try { return parseRightPanelState(storage.getItem(rightPanelKey(scope)), storage.getItem(rightPanelWidthKey(scope))); } catch { return { tab: 'chats', width: 360 }; } },
    select(scope: string, tab: string) { try { storage.setItem(rightPanelKey(scope), JSON.stringify(tab)); } catch { /* Selection remains in memory. */ } },
  };
}

export const detailsDockMinWidth = 920;
export function restoreDetailsOpen(viewport: number, sidebar: number, saved: string | null): boolean {
  return viewport - sidebar >= detailsDockMinWidth && (saved === null ? viewport >= 1280 : saved === '1');
}
