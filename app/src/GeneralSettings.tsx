import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { VoiceSettings } from './SpeechPlayback';
import { Alert, Card, IconButton, PageHeader, Row, Section, Switch } from './ui/kit';

export function GeneralSettings({ notificationsMuted, notificationError, onNotificationsChange }: { notificationsMuted: boolean; notificationError: string; onNotificationsChange: (enabled: boolean) => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const [autoArchive, setAutoArchive] = useState<boolean | null>(null), [chatError, setChatError] = useState(''), [chatBusy, setChatBusy] = useState(false);
  useEffect(() => { let stopped = false; void fetch('/api/conversations/settings').then(async response => { if (!response.ok) throw new Error(); const value = await response.json(); if (!stopped) setAutoArchive(value.autoArchive); }).catch(() => { if (!stopped) setChatError('Conversation settings could not be loaded. Reopen General to retry.'); }); return () => { stopped = true; }; }, []);
  async function changeArchive(value: boolean) { setChatBusy(true); setChatError(''); try { const response = await fetch('/api/conversations/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: crypto.randomUUID(), autoArchive: value }) }); if (!response.ok) throw new Error(); setAutoArchive((await response.json()).autoArchive); } catch { setChatError('Conversation settings could not be saved. Reopen General to check the current value.'); } finally { setChatBusy(false); } }
  return <div className="k-page bs-root">
    <PageHeader headingRef={heading} title="General" />
    <Section title="Notifications"><Card><Row title="Workflow results" trailing={<><Switch label="Workflow results" checked={!notificationsMuted} onChange={onNotificationsChange} /></>} /></Card>{notificationError && <Alert tone="error">{notificationError}</Alert>}</Section>
    <VoiceSettings />
    <Section title="Conversations"><Card><Row title="Auto-archive agent deliveries" trailing={<><span className="settings-fact">7 days</span><IconButton label="After work settles; history stays saved." aria-label="About auto-archive"><Info size={14} aria-hidden /></IconButton><Switch label="Auto-archive agent deliveries" checked={autoArchive ?? true} disabled={autoArchive === null || chatBusy} onChange={value => void changeArchive(value)} /></>} /></Card>{chatError && <Alert tone="error">{chatError}</Alert>}</Section>
  </div>;
}
