import { useEffect, useState } from 'react';
import { applyPresentation, parsePresentation, presentationKey, readPresentation, type Presentation } from '../presentation';

export function PresentationSettings() {
  const [state, setState] = useState(readPresentation), [notice, setNotice] = useState('');
  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key !== presentationKey && event.key !== null) return;
      try { if (event.storageArea !== localStorage) return; } catch { return; }
      const latest = readPresentation(); applyPresentation(document.documentElement, latest.value); setState(latest); setNotice('Appearance updated from another tab.');
    }
    window.addEventListener('storage', sync);
    const latest = readPresentation(); applyPresentation(document.documentElement, latest.value); setState(latest);
    return () => window.removeEventListener('storage', sync);
  }, []);
  function change(value: Presentation) {
    try {
      const next = parsePresentation(JSON.stringify(value));
      localStorage.setItem(presentationKey, JSON.stringify(next));
      applyPresentation(document.documentElement, next); setState({ value: next, error: '' }); setNotice('Appearance saved in this browser.');
    } catch { setState(current => ({ ...current, error: 'Appearance has not been saved. Allow browser storage and try again.' })); setNotice(''); }
  }
  return <details className="presentation-settings"><summary>Appearance</summary><p>Applies in this browser. Appearance does not change agents or conversations.</p>
    <label>Theme<select value={state.value.theme} onChange={event => change({ ...state.value, theme: event.target.value as Presentation['theme'] })}><option value="dark">Dark</option><option value="light">Light</option><option value="system">Match device</option></select></label>
    <label>Text size<select value={state.value.textSize} onChange={event => change({ ...state.value, textSize: event.target.value as Presentation['textSize'] })}><option value="standard">Standard</option><option value="large">Large</option><option value="larger">Larger</option></select></label>
    {state.error && <p className="error" role="alert">{state.error}</p>}{notice && <p role="status">{notice}</p>}
  </details>;
}
