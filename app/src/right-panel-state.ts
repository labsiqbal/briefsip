export const rightPanelKey = (scope: string) => `briefsip:right-panel:${scope}`;
export const rightPanelWidthKey = (scope: string) => `briefsip:right-panel-width:${scope}`;
export type RightPanelState = { tab: string; width: number };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export function parseRightPanelState(tab: string | null, width: string | null): RightPanelState {
  let selected = 'details';
  try { const value: unknown = JSON.parse(tab ?? 'null'); if (typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value)) selected = value; } catch { /* Invalid preferences use defaults. */ }
  const pixels = width?.trim() ? Number(width) : NaN;
  return { tab: selected, width: Number.isFinite(pixels) ? Math.max(280, Math.min(560, Math.round(pixels))) : 360 };
}
export function createRightPanelStore(storage: Storage) {
  return {
    read(scope: string): RightPanelState { try { return parseRightPanelState(storage.getItem(rightPanelKey(scope)), storage.getItem(rightPanelWidthKey(scope))); } catch { return { tab: 'details', width: 360 }; } },
    select(scope: string, tab: string) { try { storage.setItem(rightPanelKey(scope), JSON.stringify(tab)); } catch { /* Selection remains in memory. */ } },
  };
}
