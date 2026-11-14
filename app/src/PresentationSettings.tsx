import { useEffect, useState, type ReactNode } from 'react';
import { applyPresentation, parsePresentation, presentationKey, readPresentation, type Presentation } from '../presentation';
import { colorThemes } from './ui/themes';
import { Alert, Card, PageHeader, Row, Section, Segmented, Switch } from './ui/kit';

export function PresentationSettings({ children }: { children?: ReactNode }) {
  const [autoArchive, setAutoArchive] = useState<boolean | null>(null), [chatError, setChatError] = useState(''), [chatBusy, setChatBusy] = useState(false);
  useEffect(() => { let stopped = false; void fetch('/api/conversations/settings').then(async response => { if (!response.ok) throw new Error(); const value = await response.json(); if (!stopped) setAutoArchive(value.autoArchive); }).catch(() => { if (!stopped) setChatError('Conversation settings could not be loaded. Reopen Appearance to retry.'); }); return () => { stopped = true; }; }, []);
  async function changeArchive(value: boolean) { setChatBusy(true); setChatError(''); try { const response = await fetch('/api/conversations/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: crypto.randomUUID(), autoArchive: value }) }); if (!response.ok) throw new Error(); setAutoArchive((await response.json()).autoArchive); } catch { setChatError('Conversation settings could not be saved. Reopen Appearance to check the current value.'); } finally { setChatBusy(false); } }
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
    <PageHeader title="Appearance" description="Color theme, mode and text size apply in this browser. Chat cleanup applies to this installation." />
    <Section title="Color theme"><div className="color-theme-picker" role="group" aria-label="Color theme">{colorThemes.map(theme => <button type="button" key={theme.id} className="color-theme-card" aria-pressed={state.value.colorTheme === theme.id} onClick={() => change({ ...state.value, colorTheme: theme.id })}>
      <span className="theme-preview" data-color-theme={theme.id} data-theme={state.value.theme} aria-hidden="true"><span className="theme-preview__sidebar"><i /><i /><i /></span><span className="theme-preview__chat"><i /><b /><i /></span></span>
      <span className="color-theme-card__name">{theme.label}<span aria-hidden="true">{state.value.colorTheme === theme.id ? 'Selected' : ''}</span></span>
    </button>)}</div></Section>
    <Section title="Mode"><Segmented<Presentation['theme']> label="Mode" value={state.value.theme} onChange={theme => change({ ...state.value, theme })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'Match device' }]} /></Section>
    <Section title="Text size"><Segmented<Presentation['textSize']> label="Text size" value={state.value.textSize} onChange={textSize => change({ ...state.value, textSize })} options={[{ value: 'standard', label: 'Standard' }, { value: 'large', label: 'Large' }, { value: 'larger', label: 'Larger' }]} /></Section>
    <Section title="Chats"><Card><Row title="Auto-archive conversations from other agents" meta="Hide delivery conversations seven days after work settles. History stays saved and can be restored." trailing={<Switch label="Auto-archive conversations from other agents" checked={autoArchive ?? true} disabled={autoArchive === null || chatBusy} onChange={value => void changeArchive(value)} />} /></Card>{chatError && <Alert tone="error">{chatError}</Alert>}</Section>
    {children}
    {state.error && <Alert tone="error">{state.error}</Alert>}{notice && <Alert>{notice}</Alert>}
  </div>;
}
