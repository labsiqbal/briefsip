import { useEffect, useRef, useState } from 'react';

type State = { revision: number; present: boolean };
type Command = { id: string; revision: number; image: string | null };
export function AgentAvatar({ agent, size }: { agent: { id: string; name: string; avatar_revision?: number; members?: string[] }; size?: number }) {
  const channel = Array.isArray(agent.members);
  return <span className={`avatar${size ? ' bs-avatar' : ''}${channel ? ' is-channel' : ''}`} style={size ? { width: size, height: size, fontSize: Math.round(size * 0.42) } : undefined} aria-hidden="true">{!channel && agent.avatar_revision ? <img key={agent.avatar_revision} src={`/api/agents/${agent.id}/avatar/image?v=${agent.avatar_revision}`} alt="" /> : channel ? '#' : agent.name.slice(0, 1).toUpperCase()}</span>;
}
export function AvatarEditor({ agent, request, onChanged }: { agent: string; request: <T>(path: string, body?: unknown) => Promise<T>; onChanged: () => Promise<void> }) {
  const path = `/api/agents/${agent}/avatar`, key = `briefsip-avatar:${agent}`;
  const [state, setState] = useState<State | null>(null), [pending, setPending] = useState<Command | null>(null), [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
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
      const raw = sessionStorage.getItem(key);
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
          const selected = file.current?.files?.[0];
          if (!selected || selected.size > 512 * 1024) throw new Error('Choose a PNG, JPEG, or WebP image up to 512 KiB.');
          const bytes = new Uint8Array(await selected.arrayBuffer());
          if (current !== version.current) return;
          let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
          image = btoa(binary);
        }
        command = { id: crypto.randomUUID(), revision: state.revision, image };
        sessionStorage.setItem(key, JSON.stringify(command)); setPending(command);
      }
      await request(path, command);
      const latest = await request<State>(path);
      if (current !== version.current) return;
      await onChanged();
      if (current !== version.current) return;
      sessionStorage.removeItem(key); setPending(null); setState(latest); if (file.current) file.current.value = '';
      setNotice('Avatar updated.');
    } catch (error) { if (current === version.current) setError(error instanceof Error ? error.message : 'Avatar has not been saved. Try again.'); }
    finally { flight.current = false; if (current === version.current) setBusy(false); }
  }
  async function reload() {
    if (busy || flight.current || (pending || invalid) && !window.confirm('Discard the saved avatar request and load the latest version? Changes already accepted by the server still apply.')) return;
    try { sessionStorage.removeItem(key); setPending(null); setInvalid(false); setNotice(''); await load(true); }
    catch { setError('Browser storage is unavailable. Try again.'); }
  }
  return <section className="avatar-editor" aria-label="Agent avatar"><h2>Avatar</h2>
    <p className="muted">Static PNG, JPEG, or WebP, up to 512 KiB and 16 megapixels. Images are cropped to a square; metadata is removed.</p>
    {state?.present && <img className="avatar-preview" src={`${path}/image?v=${state.revision}`} alt="Current agent avatar" />}
    <label>Avatar image<input ref={file} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || !!pending || invalid || !state} /></label>
    {invalid && <p role="alert">Saved request is invalid. Reload the avatar to continue.</p>}
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="form-actions"><button disabled={busy || invalid || !state} onClick={() => void save(false)}>{busy ? 'Processing avatar...' : pending ? 'Retry avatar change' : 'Save avatar'}</button>
      <button className="secondary" aria-disabled={busy || !!pending || invalid || !state?.present} onClick={() => { if (!busy && !pending && !invalid && state?.present) void save(true); }}>Delete avatar</button>
      <button className="secondary" disabled={busy} onClick={() => void reload()}>Reload avatar</button></div>
  </section>;
}
