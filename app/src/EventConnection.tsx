import { useEffect, useRef, useState } from 'react';

export function EventConnection({ path, request }: { path: string; request: <T>(path: string) => Promise<T> }) {
  const [connection, setConnection] = useState<{ event: string; deadline: number; url: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function reveal() {
    if (busy) return;
    const version = generation.current; setBusy(true); setError('');
    try { const value = await request<NonNullable<typeof connection>>(path); if (version === generation.current) setConnection(value); }
    catch (error) { if (version === generation.current) setError(error instanceof Error ? error.message : 'Event connection is unavailable. Try again.'); }
    finally { if (version === generation.current) setBusy(false); }
  }
  return <section><h3>Waiting for event</h3><p>The event applies only to this request. Local URLs require Briefsip to keep running.</p>
    {error && <p role="alert" className="error">{error}</p>}
    <button className="secondary" disabled={busy} aria-expanded={!!connection} onClick={() => connection ? setConnection(null) : void reveal()}>{busy ? 'Loading connection...' : connection ? 'Hide connection' : 'Show event connection'}</button>
    {connection && <>
      <p>Event name: {connection.event}. Deadline: {new Date(connection.deadline).toLocaleString('en-US')}.</p>
      <label>Event URL<input readOnly value={connection.url} /></label><label>Signing secret<input readOnly value={connection.secret} autoComplete="off" spellCheck={false} /></label>
      <p className="notice">The secret grants permission to resume this step. Store it only in trusted integrations; do not enter it in conversations.</p>
      <p>Send JSON with event, optional eventTime, and payload. The X-Briefsip-Time header contains Unix time in seconds, X-Briefsip-Id contains a unique delivery ID, and X-Briefsip-Signature contains the hexadecimal HMAC-SHA256 of the time, newline, ID, newline, then the exact JSON bytes. Use the secret as UTF-8 text.</p>
    </>}
  </section>;
}
