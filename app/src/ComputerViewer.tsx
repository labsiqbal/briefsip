import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { ExternalLink, Monitor } from 'lucide-react';
import { Alert, Badge, Button, Card, Field, Input, useConfirm } from './ui/kit';
import type { ComputerWait } from '../agent-computer';
import type { ComputerRequest, ComputerStatus } from './AgentComputerPanel';
import './computer-viewer.css';

type ControlCommand = { id: string; revision: number; operation: 'take' | 'hand-back' | 'dismiss'; turn?: string };
function useComputerControl(agent: string, request: ComputerRequest) {
  const key = `briefsip-computer-control:${agent}`;
  const [status, setStatus] = useState<ComputerStatus | null>(null), [error, setError] = useState('');
  const [pending, setPending] = useState<ControlCommand | null>(null), [busy, setBusy] = useState(false), [invalid, setInvalid] = useState(false);
  const mounted = useRef(true), flight = useRef(false), confirmed = useRef(false), confirm = useConfirm();
  useEffect(() => {
    mounted.current = true;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      if (saved) {
        if (typeof saved !== 'object' || Object.keys(saved).some(k => !['id','revision','operation','turn'].includes(k)) || typeof saved.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(saved.id) || !Number.isSafeInteger(saved.revision) || saved.revision < 0 || !['take','hand-back','dismiss'].includes(saved.operation) || saved.operation === 'dismiss' && typeof saved.turn !== 'string') throw new Error();
        setPending(saved);
      }
    } catch { setInvalid(true); }
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const value = await request<ComputerStatus>(`/api/agents/${agent}/computer`); if (!stopped && !flight.current) setStatus(value); }
      catch (error) { if (!stopped) setError(error instanceof Error ? error.message : 'Computer status unavailable.'); }
      if (!stopped) timer = setTimeout(refresh, 1000);
    }
    void refresh();
    return () => { mounted.current = false; stopped = true; clearTimeout(timer); };
  }, [agent, request, key]);
  async function control(operation: ControlCommand['operation'], turn?: string) {
    if (!status || flight.current || invalid) return;
    if (!pending && operation === 'take' && !confirmed.current) {
      if (!await confirm({ title: 'Take control?', description: 'Computer tools will pause until you hand control back. Closing this viewer keeps you in control.', confirm: 'Take control' })) return;
      confirmed.current = true;
    }
    if (flight.current || !mounted.current) return;
    const command = pending ?? { id: crypto.randomUUID(), revision: status.control.revision, operation, ...(turn ? { turn } : {}) };
    try { sessionStorage.setItem(key, JSON.stringify(command)); }
    catch { setError('Browser could not save control request. Check site storage.'); return; }
    flight.current = true; setBusy(true); setPending(command); setError('');
    try {
      const value = await request<ComputerStatus>(`/api/agents/${agent}/computer/control`, command);
      sessionStorage.removeItem(key);
      if (mounted.current) { setStatus(value); setPending(null); }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Control change is not confirmed. Retry the saved request.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  async function discard() {
    if (!await confirm({ title: 'Load current control?', description: 'Accepted changes still apply. Check current control before taking another action.', confirm: 'Load current control' })) return;
    try {
      const value = await request<ComputerStatus>(`/api/agents/${agent}/computer`);
      sessionStorage.removeItem(key); setStatus(value); setPending(null); setInvalid(false); setError('');
    } catch (error) { setError(error instanceof Error ? error.message : 'Computer status unavailable.'); }
  }
  const recovery = <>
    {error && <Alert tone="error">{error}</Alert>}
    {pending && <Alert tone="warn" title="Control change not confirmed" actions={<Button size="sm" busy={busy} onClick={() => void control(pending.operation, pending.turn)}>Retry saved request</Button>}>Check control before sending input.</Alert>}
    {(pending || invalid) && <Button size="sm" disabled={busy} onClick={() => void discard()}>Load current control</Button>}
  </>;
  return { status, setStatus, control, setError, locked: busy || !!pending || invalid, recovery };
}

export function ComputerRequestCard({ agent, name, wait, request }: { agent: string; name: string; wait: ComputerWait; request: ComputerRequest }) {
  const controls = useComputerControl(agent, request);
  return <div className="bs-root computer-request"><Card>
    <p><strong>{name} needs you to take over: {wait.reason || 'The user is controlling this computer.'}</strong></p>
    <div className="k-inline">{controls.status?.control.mode === 'user'
      ? <Button size="sm" disabled={controls.locked} onClick={() => void controls.control('hand-back')}>Hand back to agent</Button>
      : <><Button size="sm" variant="primary" disabled={!controls.status || controls.locked} onClick={() => void controls.control('take')}>Take control</Button><Button size="sm" disabled={!controls.status || controls.locked} onClick={() => void controls.control('dismiss', wait.turn)}>Dismiss</Button></>}
    </div>
  </Card>{controls.recovery}</div>;
}

export function ComputerViewer({ agent, name, request, popout = false }: { agent: string; name: string; request: ComputerRequest; popout?: boolean }) {
  const controls = useComputerControl(agent, request), { status } = controls;
  const [visible, setVisible] = useState(!document.hidden), [text, setText] = useState(''), [screenError, setScreenError] = useState(false), [starting, setStarting] = useState(false), [sendingText, setSendingText] = useState(false);
  const [connected, setConnected] = useState(false), [connection, setConnection] = useState(0);
  const screen = useRef<HTMLDivElement>(null), canvas = useRef<HTMLDivElement>(null), rfb = useRef<RFB | null>(null), handBack = useRef<HTMLButtonElement>(null), inputFlight = useRef(0);
  const user = status?.control.mode === 'user', running = !!status && ['running','idle'].includes(status.state);
  useEffect(() => {
    if (!running || !visible || !canvas.current) return;
    let stopped = false, disconnected = false, client: RFB | undefined;
    let clipboard: EventListener | undefined;
    setConnected(false); setScreenError(false);
    const element = canvas.current;
    void request<{ ticket: string }>(`/api/agents/${agent}/computer/vnc-ticket`, { mode: user && !controls.locked ? 'control' : 'watch', revision: status?.control.revision }).then(({ ticket }) => {
      if (stopped) return;
      const url = new URL(`/api/agents/${agent}/computer/vnc`, location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('ticket', ticket);
      client = new RFB(element, url.href, { shared: true, wsProtocols: ['binary'] });
      client.viewOnly = !user || controls.locked; client.scaleViewport = true; client.resizeSession = false; client.background = 'transparent'; client.focusOnClick = !!user;
      client.addEventListener('connect', () => { if (!stopped) setConnected(true); });
      client.addEventListener('disconnect', () => { disconnected = true; if (!stopped) { setConnected(false); setScreenError(true); } });
      client.addEventListener('securityfailure', () => { if (!stopped) setScreenError(true); });
      clipboard = (event: Event) => {
        const value = (event as CustomEvent<{ text?: unknown }>).detail?.text;
        if (stopped || !user || controls.locked || typeof value !== 'string') return;
        if (value.length > 4000) { controls.setError('Clipboard text exceeds 4000 characters. Copy a smaller selection.'); return; }
        setText(value);
      };
      client.addEventListener('clipboard', clipboard);
      rfb.current = client;
    }).catch(() => { if (!stopped) setScreenError(true); });
    return () => {
      stopped = true;
      if (client && !disconnected) client.disconnect();
      if (client && clipboard) client.removeEventListener('clipboard', clipboard);
      rfb.current = null; element.replaceChildren();
    };
  }, [agent, running, visible, connection, user, controls.locked, status?.control.revision, request]);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  async function input(name: string, args: unknown) {
    if (!status || !user || controls.locked) return false;
    if (inputFlight.current >= 8) { controls.setError('Computer input is busy. Wait before sending more input.'); return false; }
    inputFlight.current++;
    try { await request(`/api/agents/${agent}/computer/input`, { revision: status.control.revision, name, args }); return true; }
    catch (error) { controls.setError(error instanceof Error ? error.message : 'Input outcome is not confirmed. Check the screen before sending more input.'); return false; }
    finally { inputFlight.current--; }
  }
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (!user || controls.locked || event.key !== 'Escape' || !(event.target instanceof Node) || !screen.current?.contains(event.target)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.shiftKey) { rfb.current?.blur(); handBack.current?.focus(); }
      else rfb.current?.sendKey(0xff1b, 'Escape');
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [user, controls.locked]);
  async function start() {
    if (starting) return; setStarting(true);
    try { controls.setStatus(await request<ComputerStatus>(`/api/agents/${agent}/computer/start`, {})); }
    catch (error) { controls.setError(error instanceof Error ? error.message : 'Computer did not start.'); }
    finally { setStarting(false); }
  }
  return <div className="computer-viewer bs-root">
    <div className="computer-viewer__toolbar">
      <Badge>{status ? status.state === 'off' ? 'Off' : status.state === 'starting' ? 'Starting' : 'Live' : 'Loading...'}</Badge>
      <span className="computer-viewer__owner">{user ? 'You are in control' : 'Agent in control'}</span>
      {status && <span className="computer-viewer__since">Since {new Date(status.control.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
      <div className="computer-viewer__actions">
        {!running && <Button size="sm" busy={starting} disabled={!status?.enabled || !status.available || controls.locked} onClick={() => void start()}>Start computer</Button>}
        {user ? <Button ref={handBack} size="sm" variant="primary" disabled={controls.locked} onClick={() => void controls.control('hand-back')}>Hand back to agent</Button> : <Button size="sm" variant="primary" disabled={!status?.enabled || controls.locked} onClick={() => void controls.control('take')}>Take control</Button>}
        {!popout && <Button size="sm" icon={<ExternalLink size={14} aria-hidden />} onClick={() => window.open(`/?computer=${encodeURIComponent(agent)}`, '_blank', 'popup,width=1280,height=960,noopener')}>Pop out</Button>}
      </div>
    </div>
    {user && <Alert tone="warn" title="You are in control">Computer tools are paused until you hand control back. Closing this viewer keeps you in control.</Alert>}
    {!!status?.requests.length && <div className="computer-viewer__requests">{status.requests.map(wait => <div key={wait.turn}>
      <p><strong>{name} needs you to take over: {wait.reason || 'Computer access is waiting for you.'}</strong></p>
      {!user && <div className="k-inline"><Button size="sm" disabled={controls.locked} onClick={() => void controls.control('take')}>Take control</Button><Button size="sm" disabled={controls.locked} onClick={() => void controls.control('dismiss', wait.turn)}>Dismiss</Button></div>}
    </div>)}</div>}
    <div ref={screen} className={`computer-viewer__screen${user ? ' is-controlled' : ''}`} role="application" aria-label={`${name}'s computer. Click to send keys. Shift+Escape returns to controls.`}>
      <div ref={canvas} className="computer-viewer__canvas" aria-label={`${name}'s live computer screen`} />
      {(!running || !visible || !connected) && <div className="computer-viewer__empty"><Monitor size={32} aria-hidden /><p>{!visible ? 'Viewer paused while window is hidden.' : running ? 'Connecting to computer...' : status?.state === 'starting' ? 'Starting computer...' : 'Start the computer to see its screen.'}</p></div>}
    </div>
    {screenError && <Alert tone="error" actions={<Button size="sm" onClick={() => setConnection(value => value + 1)}>Reconnect</Button>}>Live screen unavailable. Close another viewer if three are already open, then reconnect.</Alert>}
    {user && <>
      <p className="k-field__hint">Click the screen to send keys, clicks and scrolling. Press Shift+Escape to return to controls. Use Set clipboard before Ctrl+V; copied desktop text appears here.</p>
      <form className="computer-viewer__text" onSubmit={async event => { event.preventDefault(); if (!text || sendingText) return; setSendingText(true); const sent = text; try { if (await input('computer_type', { text: sent })) setText(current => current === sent ? '' : current); } finally { setSendingText(false); } }}>
        <Field label="Type or paste text" hint="Send text types into the focused field. Set clipboard prepares Ctrl+V. Copied desktop text appears here."><Input value={text} maxLength={4000} onChange={event => setText(event.target.value)} disabled={controls.locked} /></Field>
        <Button size="sm" disabled={!connected || controls.locked} onClick={() => rfb.current?.clipboardPasteFrom(text)}>Set clipboard</Button>
        <Button size="sm" type="submit" busy={sendingText} disabled={!text || controls.locked || sendingText}>Send text</Button>
      </form>
    </>}
    {controls.recovery}
  </div>;
}
