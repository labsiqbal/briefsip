import { applyColorTheme, colorThemes, type ColorTheme } from './ui/themes.ts';
export type Presentation = { version: 1; colorTheme: ColorTheme; theme: 'dark' | 'light' | 'system'; textSize: 'compact' | 'standard' | 'large' | 'larger' };
export const presentationKey = 'minarbot-presentation-v1';
export const defaultPresentation: Presentation = { version: 1, colorTheme: 'minarbot', theme: 'dark', textSize: 'standard' };
export function parsePresentation(raw: string | null): Presentation {
  if (raw === null) return { ...defaultPresentation };
  const value = JSON.parse(raw);
  const colorTheme = value?.colorTheme;
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !['version', 'theme', 'textSize', 'colorTheme'].includes(key))
    || (value.colorTheme !== undefined && !colorThemes.some(theme => theme.id === colorTheme)) || value.version !== 1 || !['dark', 'light', 'system'].includes(value.theme) || !['compact', 'standard', 'large', 'larger'].includes(value.textSize)) throw new Error('Saved display settings are invalid. Choose a view to save them again.');
  return { version: 1, colorTheme: (colorTheme ?? 'minarbot') as ColorTheme, theme: value.theme, textSize: value.textSize };
}
export function readPresentation(storage?: Pick<Storage, 'getItem'>): { value: Presentation; error: string } {
  try { return { value: parsePresentation((storage ?? localStorage).getItem(presentationKey)), error: '' }; }
  catch { return { value: { ...defaultPresentation }, error: 'Cannot read saved settings. Using the default view; choose a view to try saving again.' }; }
}
export function applyPresentation(root: HTMLElement, value: Presentation) {
  root.dataset.theme = value.theme;
  root.dataset.textSize = value.textSize;
  applyColorTheme(root, value.colorTheme);
}
