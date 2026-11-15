// Adapted from T3 DesktopWindow.ts / ContextMenuImage.ts (MIT); see ../provenance.json.
import { Menu, clipboard, dialog } from 'electron';
import { isAllowedExternal, isAllowedNavigation } from './policy.mjs';

export function installContextMenu(window, contents, configuredUrl, connectUrl) {
  contents.on('context-menu', (event, params) => {
    event.preventDefault();
    const frame = params.frame;
    const trusted = () => frame && !frame.isDestroyed() && !window.isDestroyed() && !contents.isDestroyed() && frame === contents.mainFrame &&
      (isAllowedNavigation(frame.url, configuredUrl()) || frame.url === connectUrl || frame.url.startsWith(`${connectUrl}?`));
    if (!trusted()) return;
    contents.focus();
    const items = [];
    if (params.isEditable && params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) items.push({ label: suggestion, click: () => { if (trusted()) contents.replaceMisspelling(suggestion); } });
      if (!params.dictionarySuggestions.length) items.push({ label: 'No suggestions', enabled: false });
      items.push({ type: 'separator' });
    }
    if (isAllowedExternal(params.linkURL)) items.push({ label: 'Copy Link', click: async () => { if (trusted()) { try { await clipboard.writeText(params.linkURL); } catch { dialog.showErrorBox('Copy failed', 'Link could not be copied. Select it to copy manually.'); } } } }, { type: 'separator' });
    // ponytail: main-frame images use Chromium's decoded pixels; add a bounded fetch only if trusted guest frames are introduced.
    if (params.mediaType === 'image') items.push({ label: 'Copy Image', click: () => { if (trusted()) contents.copyImageAt(params.x, params.y); } }, { type: 'separator' });
    items.push(...['cut', 'copy', 'paste', 'selectAll'].map(role => ({ role, enabled: params.editFlags[`can${role[0].toUpperCase()}${role.slice(1)}`] })));
    Menu.buildFromTemplate(items).popup({ window });
  });
}
