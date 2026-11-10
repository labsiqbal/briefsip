import { useEffect, useState } from 'react';
import { applyPresentation, parsePresentation, presentationKey, readPresentation, type Presentation } from '../presentation';

export function PresentationSettings() {
  const [state, setState] = useState(readPresentation), [notice, setNotice] = useState('');
  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key !== presentationKey && event.key !== null) return;
      try { if (event.storageArea !== localStorage) return; } catch { return; }
      const latest = readPresentation(); applyPresentation(document.documentElement, latest.value); setState(latest); setNotice('Tampilan diperbarui dari tab lain.');
    }
    window.addEventListener('storage', sync);
    const latest = readPresentation(); applyPresentation(document.documentElement, latest.value); setState(latest);
    return () => window.removeEventListener('storage', sync);
  }, []);
  function change(value: Presentation) {
    try {
      const next = parsePresentation(JSON.stringify(value));
      localStorage.setItem(presentationKey, JSON.stringify(next));
      applyPresentation(document.documentElement, next); setState({ value: next, error: '' }); setNotice('Tampilan tersimpan di browser ini.');
    } catch { setState(current => ({ ...current, error: 'Tampilan belum disimpan. Izinkan penyimpanan browser lalu coba lagi.' })); setNotice(''); }
  }
  return <details className="presentation-settings"><summary>Tampilan</summary><p>Berlaku di browser ini. Tampilan tidak mengubah agent atau percakapan.</p>
    <label>Tema<select value={state.value.theme} onChange={event => change({ ...state.value, theme: event.target.value as Presentation['theme'] })}><option value="dark">Gelap</option><option value="light">Terang</option><option value="system">Ikuti perangkat</option></select></label>
    <label>Ukuran teks<select value={state.value.textSize} onChange={event => change({ ...state.value, textSize: event.target.value as Presentation['textSize'] })}><option value="standard">Standar</option><option value="large">Besar</option><option value="larger">Lebih besar</option></select></label>
    {state.error && <p className="error" role="alert">{state.error}</p>}{notice && <p role="status">{notice}</p>}
  </details>;
}
