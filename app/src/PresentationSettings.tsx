import { useEffect, useState } from 'react';
import { applyPresentation, parsePresentation, presentationKey, readPresentation, type Presentation } from '../presentation';
import { Alert, PageHeader, Section, Segmented } from './ui/kit';

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
  return <div className="k-page bs-root">
    <PageHeader title="Appearance" description="Applies in this browser. Appearance does not change agents or conversations." />
    <Section title="Theme"><Segmented<Presentation['theme']> label="Theme" value={state.value.theme} onChange={theme => change({ ...state.value, theme })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'Match device' }]} /></Section>
    <Section title="Text size"><Segmented<Presentation['textSize']> label="Text size" value={state.value.textSize} onChange={textSize => change({ ...state.value, textSize })} options={[{ value: 'standard', label: 'Standard' }, { value: 'large', label: 'Large' }, { value: 'larger', label: 'Larger' }]} /></Section>
    {state.error && <Alert tone="error">{state.error}</Alert>}{notice && <Alert>{notice}</Alert>}
  </div>;
}
