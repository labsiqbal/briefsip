import { useEffect, useRef, useState } from 'react';
import { applyPresentation, parsePresentation, presentationKey, readPresentation, type Presentation } from '../presentation';
import { colorThemes } from './ui/themes';
import { Alert, Card, PageHeader, Row, Section, Segmented } from './ui/kit';

export function PresentationSettings() {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
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
    <PageHeader headingRef={heading} title="Appearance" />
    <Section title="Theme"><div className="color-theme-picker" role="group" aria-label="Color theme">{colorThemes.map(theme => <button type="button" key={theme.id} className="color-theme-card" aria-pressed={state.value.colorTheme === theme.id} onClick={() => change({ ...state.value, colorTheme: theme.id })}>
      <span className="theme-preview" data-color-theme={theme.id} data-theme={state.value.theme} aria-hidden="true"><span className="theme-preview__sidebar"><i /><i /><i /></span><span className="theme-preview__chat"><i /><b /><i /></span></span>
      <span className="color-theme-card__name">{theme.label}<span aria-hidden="true">{state.value.colorTheme === theme.id ? 'Selected' : ''}</span></span>
    </button>)}</div></Section>
    <Card><Row title="Mode" trailing={<Segmented<Presentation['theme']> label="Mode" value={state.value.theme} onChange={theme => change({ ...state.value, theme })} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' }]} />} />
    <Row title="Text size" trailing={<Segmented<Presentation['textSize']> label="Text size" value={state.value.textSize} onChange={textSize => change({ ...state.value, textSize })} options={[{ value: 'standard', label: 'Default' }, { value: 'large', label: 'Large' }, { value: 'larger', label: 'Larger' }]} />} /></Card>
    {state.error && <Alert tone="error">{state.error}</Alert>}{notice && <span className="sr-only" role="status">{notice}</span>}
  </div>;
}
