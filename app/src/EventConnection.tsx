import { useEffect, useRef, useState } from 'react';

import { Alert, Button, Field, Input } from './ui/kit';

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
  return <section className="k-stack bs-root"><h3 className="k-section__title">Waiting for event</h3><p className="k-field__hint" style={{ margin: 0 }}>The event applies only to this request. Local URLs require Briefsip to keep running.</p>
    {error && <Alert tone="error">{error}</Alert>}
    <Button size="sm" style={{ alignSelf: 'flex-start' }} disabled={busy} aria-expanded={!!connection} onClick={() => connection ? setConnection(null) : void reveal()}>{busy ? 'Loading connection...' : connection ? 'Hide connection' : 'Show event connection'}</Button>
    {connection && <>
      <p className="k-field__hint" style={{ margin: 0 }}>Event name: {connection.event}. Deadline: {new Date(connection.deadline).toLocaleString('en-US')}.</p>
      <Field label="Event URL"><Input readOnly value={connection.url} /></Field><Field label="Signing secret"><Input readOnly value={connection.secret} autoComplete="off" spellCheck={false} /></Field>
      <Alert tone="warn">The secret grants permission to resume this step. Store it only in trusted integrations; do not enter it in conversations.</Alert>
      <p className="k-field__hint" style={{ margin: 0 }}>Send JSON with event, optional eventTime, and payload. The X-Briefsip-Time header contains Unix time in seconds, X-Briefsip-Id contains a unique delivery ID, and X-Briefsip-Signature contains the hexadecimal HMAC-SHA256 of the time, newline, ID, newline, then the exact JSON bytes. Use the secret as UTF-8 text.</p>
    </>}
  </section>;
}
