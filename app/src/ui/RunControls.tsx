// Queue and primary Stop patterns adapted from T3 (MIT, see app/t3/NOTICE).
import { Ellipsis, Square, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { QueueEditor } from '../QueueEditor';
import { ActionMenu, Button, IconButton, Tooltip } from './kit';

type Request = <T>(path: string, data?: unknown) => Promise<T>;
type QueuedTurn = { id: string; revision: number; status: string; text: string; paused: number; dispatch_mode?: string; dispatch_label?: string | null; editing?: boolean; files?: { id: string; name: string }[] };

export function CancelTurn({ turn, path, request, onCancelled, primary = false, label = 'Remove' }: { turn: string; path: string; request: Request; onCancelled: (id: string) => void; primary?: boolean; label?: string }) {
  const key = `briefsip:cancel:${path}:${turn}`;
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const flight = useRef(false);
  async function cancel() {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError('');
    try {
      const saved = sessionStorage.getItem(key), id = saved ?? crypto.randomUUID();
      if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Stop recovery could not be read. Check browser storage.');
      sessionStorage.setItem(key, id);
      await request(`${path}/${turn}/cancel`, { id });
      sessionStorage.removeItem(key); onCancelled(turn);
    } catch (error) { setError(error instanceof Error ? error.message : 'Stop not confirmed. Retry Stop.'); }
    finally { flight.current = false; setBusy(false); }
  }
  const title = busy ? 'Stopping…' : error ? `Retry ${primary ? 'Stop' : label}` : primary ? 'Stop' : label;
  return <span data-turn={turn} className={primary ? 'composer-stop' : 'queue-remove'}>
    {primary ? <Tooltip content={title}><button type="button" className="composer__cta composer__cta--stop" aria-label={title} disabled={busy} onClick={() => void cancel()}><Square size={14} fill="currentColor" aria-hidden /></button></Tooltip> : <IconButton label={title} disabled={busy} onClick={() => void cancel()}><X size={14} aria-hidden /></IconButton>}
    {error && <span role="alert" className="message-error">{error}</span>}
  </span>;
}

function QueuedRun({ turn, path, target, request, archived, onChanged }: { turn: QueuedTurn; path: string; target?: { id: string; capabilities: { steer: boolean } }; request: Request; archived: boolean; onChanged: () => void }) {
  const key = `briefsip:queue-dispatch:${path}:${turn.id}`;
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [retry, setRetry] = useState(() => { try { return !!sessionStorage.getItem(key); } catch { return false; } });
  const flight = useRef(false);
  async function dispatch(mode: 'steer' | 'restart') {
    if ((!target && !retry) || flight.current) return;
    flight.current = true; setBusy(true); setError('');
    try {
      const saved = sessionStorage.getItem(key);
      const command = saved ? JSON.parse(saved) : { id: crypto.randomUUID(), revision: turn.revision, mode, targetTurn: target!.id };
      if (!command || !/^[a-f0-9-]{36}$/i.test(command.id) || !/^[a-f0-9-]{36}$/i.test(command.targetTurn) || !Number.isSafeInteger(command.revision) || !['steer', 'restart'].includes(command.mode)) throw new Error('Queue recovery could not be read. Check browser storage.');
      sessionStorage.setItem(key, JSON.stringify(command)); setRetry(true);
      await request(`${path}/${turn.id}/dispatch`, command);
      sessionStorage.removeItem(key); setRetry(false); onChanged();
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && error.status < 500) { sessionStorage.removeItem(key); setRetry(false); onChanged(); }
      setError(error instanceof Error ? error.message : 'Change not confirmed. Try again.');
    } finally { flight.current = false; setBusy(false); }
  }
  const guidance = turn.dispatch_mode === 'steer', restarting = turn.dispatch_mode === 'restart';
  return <li className="queued-run" aria-label={`Queued message: ${turn.text}`}>
    <div className="queued-run__line"><span className="queued-run__text" title={turn.text}>{turn.text}</span><div className="queued-run__actions">
      {!archived && !guidance && !restarting && <QueueEditor compact turn={{ ...turn, files: turn.files ?? [] }} path={path} archived={archived} request={request} />}
      {retry && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void dispatch('steer')}>Retry change</Button>}
      {!archived && !retry && !guidance && !restarting && target?.capabilities.steer && !turn.files?.length && !turn.editing && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void dispatch('steer')}>Steer</Button>}
      {!archived && !retry && !guidance && !restarting && target && !turn.editing && <ActionMenu label="Queued message actions" trigger={<IconButton label="Queued message actions"><Ellipsis size={14} aria-hidden /></IconButton>} items={[{ label: 'Restart', disabled: busy, onSelect: () => void dispatch('restart') }]} />}
      {!archived && <CancelTurn turn={turn.id} path={path} request={request} onCancelled={onChanged} />}
    </div></div>
    {(guidance || restarting || turn.dispatch_label === 'Queued after active turn') && <span className="queued-run__status">{guidance ? 'Steering…' : restarting ? 'Restarting…' : 'Queued for next turn'}</span>}
    {error && <span role="alert" className="message-error">{error}</span>}
  </li>;
}

export function QueuedRunsControl({ turns, ...props }: { turns: QueuedTurn[]; path: string; target?: { id: string; capabilities: { steer: boolean } }; request: Request; archived: boolean; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  if (!turns.length) return null;
  return <section className="queued-runs" aria-label="Queued messages"><div className="queued-runs__heading">Queued <span>{turns.length}</span></div><ol>{(expanded ? turns : turns.slice(0, 3)).map(turn => <QueuedRun key={turn.id} turn={turn} {...props} />)}</ol>{turns.length > 3 && <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : `Show ${turns.length - 3} more`}</Button>}</section>;
}
