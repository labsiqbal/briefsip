import { readProductStorage, removeProductStorage } from './rename-storage.ts';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Dialog, Field, IconButton, Input, Row, Section, useConfirm, RecoveryAlert, Tooltip } from './ui/kit';
import { RefreshCw } from 'lucide-react';
import { AvatarPicker, avatarPng, type AvatarLook } from './ui/avatar-shapes';

type State = { revision: number; present: boolean };
type Command = { id: string; revision: number; image: string | null };
export function AgentAvatar({ agent, size }: { agent: { id: string; name: string; avatar_revision?: number; members?: string[] }; size?: number }) {
  const channel = Array.isArray(agent.members);
  return <span className={`avatar${size ? ' bs-avatar' : ''}${channel ? ' is-channel' : ''}`} style={size ? { width: size, height: size, fontSize: Math.round(size * 0.42) } : undefined} aria-hidden="true">{!channel && agent.avatar_revision ? <img key={agent.avatar_revision} src={`/api/agents/${agent.id}/avatar/image?v=${agent.avatar_revision}`} alt="" /> : channel ? '#' : agent.name.slice(0, 1).toUpperCase()}</span>;
}
export function AvatarEditor({ agent, request, onChanged, onClose }: { agent: string; request: <T>(path: string, body?: unknown) => Promise<T>; onChanged: () => Promise<void>; onClose?: () => void }) {
  const path = `/api/agents/${agent}/avatar`, key = `minarbot-avatar:${agent}`;
  const [state, setState] = useState<State | null>(null), [pending, setPending] = useState<Command | null>(null), [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<File | null>(null);
  const [look, setLook] = useState<AvatarLook | null>(null);
  const validFile = !!selected && selected.size > 0 && selected.size <= 512 * 1024 && ['image/png', 'image/jpeg', 'image/webp'].includes(selected.type);
  const version = useRef(0), flight = useRef(false), file = useRef<HTMLInputElement>(null);
  async function load(syncDirectory = false) {
    const current = ++version.current; setBusy(true); setError('');
    try {
      const value = await request<State>(path);
      if (current !== version.current) return;
      if (syncDirectory) await onChanged();
      if (current === version.current) setState(value);
    }
    catch { if (current === version.current) setError('Avatar could not load. Try reloading.'); }
    finally { if (current === version.current) setBusy(false); }
  }
  useEffect(() => {
    try {
      const raw = readProductStorage(sessionStorage, key);
      if (raw) {
        const value = JSON.parse(raw);
        if (!value || Object.keys(value).some(key => !['id','revision','image'].includes(key)) || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.id) || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.image !== null && (typeof value.image !== 'string' || value.image.length > 699052 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.image))) throw new Error();
        setPending(value);
      }
    } catch { setInvalid(true); }
    void load(); return () => { version.current++; };
  }, [agent, request]);
  async function save(remove: boolean) {
    if (flight.current || busy || !state || invalid) return;
    flight.current = true; setBusy(true); setError(''); setNotice(''); const current = ++version.current;
    try {
      let command = pending;
      if (!command) {
        let image: string | null = null;
        if (!remove) {
          if (look) image = await avatarPng(look);
          else {
            const selected = file.current?.files?.[0];
            if (!selected || selected.size > 512 * 1024) throw new Error('Choose a PNG, JPEG, or WebP image up to 512 KiB.');
            const bytes = new Uint8Array(await selected.arrayBuffer());
            let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
            image = btoa(binary);
          }
          if (current !== version.current) return;
        }
        command = { id: crypto.randomUUID(), revision: state.revision, image };
        sessionStorage.setItem(key, JSON.stringify(command)); setPending(command);
      }
      await request(path, command);
      const latest = await request<State>(path);
      if (current !== version.current) return;
      await onChanged();
      if (current !== version.current) return;
      removeProductStorage(sessionStorage, key); setPending(null); setState(latest); setSelected(null); setLook(null); if (file.current) file.current.value = '';
      setNotice('Avatar updated.');
    } catch (error) { if (current === version.current) setError(error instanceof Error ? error.message : 'Avatar has not been saved. Try again.'); }
    finally { flight.current = false; if (current === version.current) setBusy(false); }
  }
  const confirm = useConfirm();
  async function reload() {
    if (busy || flight.current || (pending || invalid) && !await confirm({ title: 'Discard the saved avatar request and load the latest version?', description: 'Changes already accepted by the server still apply.', confirm: 'Discard and reload', danger: true })) return;
    try { removeProductStorage(sessionStorage, key); setPending(null); setInvalid(false); setNotice(''); await load(true); }
    catch { setError('Browser storage is unavailable. Try again.'); }
  }
  return <Dialog open size="md" title="Avatar" onOpenChange={open => { if (!open) onClose?.(); }} footer={<>
    <Button className="k-dialog__foot-start" variant="ghost" disabled={busy || !!pending || invalid || !state?.present} onClick={async () => { if (!busy && !pending && !invalid && state?.present && await confirm({ title: 'Remove avatar?', confirm: 'Remove avatar', danger: true })) void save(true); }}>Remove avatar</Button>
    <Button onClick={onClose}>Done</Button>
    <Button variant="primary" busy={busy} disabled={busy || invalid || !state || !pending && !validFile && !look} onClick={() => void save(false)}>{busy ? 'Saving...' : pending ? 'Try again' : 'Save'}</Button>
  </>}>
    <Section title="Image" actions={<IconButton label="Reload avatar" disabled={busy} onClick={() => void reload()}><RefreshCw size={15} aria-hidden /></IconButton>}>
      <Card><Row title={<Tooltip content="PNG, JPEG, or WebP. Up to 512 KiB and 16 megapixels. Cropped to a square; metadata removed."><span tabIndex={0}>Current avatar</span></Tooltip>}
        trailing={state?.present && <img src={`${path}/image?v=${state.revision}`} alt="Current agent avatar" width={64} height={64} style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8 }} />} /></Card>
      <AvatarPicker value={look} disabled={busy || !!pending || invalid || !state} onChange={next => { setLook(next); setSelected(null); setError(''); if (file.current) file.current.value = ''; }} />
      <Field label="Upload image"><Input ref={file} hidden style={{ display: 'none' }} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || !!pending || invalid || !state} onChange={event => {
        const chosen = event.target.files?.[0] ?? null; setSelected(chosen); if (chosen) setLook(null); setError('');
        if (chosen && (!chosen.size || chosen.size > 512 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(chosen.type))) setError('Choose a PNG, JPEG, or WebP image up to 512 KiB.');
      }} /><div className="k-row-actions"><Button size="sm" aria-label="Choose avatar image" disabled={busy || !!pending || invalid || !state} onClick={() => file.current?.click()}>Choose image</Button><span className="k-field__hint" role="status" style={{ alignSelf: 'center', overflowWrap: 'anywhere' }}>{selected?.name ?? 'No image chosen'}</span></div></Field>
      {invalid && <Alert tone="error">Saved request is invalid. Reload the avatar to continue.</Alert>}
      {error && <Alert tone="error">{error}</Alert>}{notice && <span className="sr-only" role="status">{notice}</span>}
      {pending && <RecoveryAlert inFlight={busy} tone="warn" title="Not confirmed" />}
    </Section>
  </Dialog>;
}
