import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
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
  const [frame, setFrame] = useState(''), [connection, setConnection] = useState(0);
  const screen = useRef<HTMLDivElement>(null), handBack = useRef<HTMLButtonElement>(null), inputFlight = useRef(0);
  const user = status?.control.mode === 'user', running = !!status && ['running','idle'].includes(status.state);
  useEffect(() => {
    if (!running || !visible) { setFrame(''); return; }
    setScreenError(false);
    const source = new EventSource(`/api/agents/${agent}/computer/stream`);
    source.onmessage = event => setFrame(`data:image/jpeg;base64,${event.data}`);
    source.onerror = () => { setScreenError(true); source.close(); };
    return () => source.close();
  }, [agent, running, visible, connection]);
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
    // Radix observes Escape on document capture. Handle remote Escape earlier so it
    // reaches the sandbox instead of dismissing the viewer underneath the user.
    const escape = (event: globalThis.KeyboardEvent) => {
      if (!user || controls.locked || event.key !== 'Escape' || !(event.target instanceof Node) || !screen.current?.contains(event.target)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.shiftKey) handBack.current?.focus();
      else void input('computer_key', { keys: [...(event.ctrlKey ? ['Control_L'] : []), ...(event.altKey ? ['Alt_L'] : []), ...(event.metaKey ? ['Super_L'] : []), 'Escape'] });
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [user, status?.control.revision, controls.locked]);
  useEffect(() => {
    const element = screen.current;
    const wheel = (event: WheelEvent) => {
      if (!user || controls.locked) return;
      event.preventDefault();
      void input('computer_scroll', { dx: Math.sign(event.deltaX) * Math.min(20, Math.ceil(Math.abs(event.deltaX) / 100)), dy: Math.sign(event.deltaY) * Math.min(20, Math.ceil(Math.abs(event.deltaY) / 100)) });
    };
    element?.addEventListener('wheel', wheel, { passive: false });
    return () => element?.removeEventListener('wheel', wheel);
  }, [user, status?.control.revision, controls.locked]);
  function click(event: MouseEvent<HTMLImageElement>, button: number) {
    if (!user) return;
    screen.current?.focus();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1279, Math.floor((event.clientX - rect.left) * 1280 / rect.width))), y = Math.max(0, Math.min(799, Math.floor((event.clientY - rect.top) * 800 / rect.height)));
    void input('computer_click', { x, y, button });
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (!user) return;
    if (event.key === 'Escape' && event.shiftKey) { event.preventDefault(); event.stopPropagation(); handBack.current?.focus(); return; }
    if (['Control','Alt','Shift','Meta','Dead','Process'].includes(event.key) || event.nativeEvent.isComposing) return;
    const keys: Record<string, string> = { Enter: 'Return', Escape: 'Escape', Backspace: 'BackSpace', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PageUp: 'Page_Up', PageDown: 'Page_Down', ' ': 'space' };
    const keyName = keys[event.key] ?? event.key;
    if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1) { event.preventDefault(); event.stopPropagation(); void input('computer_type', { text: event.key }); return; }
    if (!keys[event.key] && !/^(Tab|Delete|Home|End|F([1-9]|1[0-2])|[a-zA-Z0-9])$/.test(keyName)) return;
    event.preventDefault(); event.stopPropagation();
    void input('computer_key', { keys: [...(event.ctrlKey ? ['Control_L'] : []), ...(event.altKey ? ['Alt_L'] : []), ...(event.shiftKey ? ['Shift_L'] : []), ...(event.metaKey ? ['Super_L'] : []), keyName] });
  }
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
    <div ref={screen} className={`computer-viewer__screen${user ? ' is-controlled' : ''}`} role="application" aria-label={`${name}'s computer. Click to send keys. Shift+Escape returns to controls.`} tabIndex={user && !controls.locked ? 0 : -1} onKeyDown={key} onPaste={event => { if (user) { event.preventDefault(); const text = event.clipboardData.getData('text').slice(0, 4000); if (text) void input('computer_type', { text }); } }}>
      {running && visible && frame ? <img src={frame} width={960} height={600} alt={`${name}'s live computer screen`} draggable={false} onError={() => setScreenError(true)} onClick={event => click(event, 1)} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); click(event, 2); } }} onContextMenu={event => { event.preventDefault(); click(event, 3); }} /> : <div className="computer-viewer__empty"><Monitor size={32} aria-hidden /><p>{!visible ? 'Viewer paused while window is hidden.' : running ? 'Connecting to computer...' : status?.state === 'starting' ? 'Starting computer...' : 'Start the computer to see its screen.'}</p></div>}
    </div>
    {screenError && <Alert tone="error" actions={<Button size="sm" onClick={() => setConnection(value => value + 1)}>Reconnect</Button>}>Live screen unavailable. Close another viewer if three are already open, then reconnect.</Alert>}
    {user && <>
      <p className="k-field__hint">Click the screen to send keys, clicks and scrolling. Press Shift+Escape to return to controls. Ctrl+C and Ctrl+V use the computer's clipboard.</p>
      <form className="computer-viewer__text" onSubmit={async event => { event.preventDefault(); if (!text || sendingText) return; setSendingText(true); const sent = text; try { if (await input('computer_type', { text: sent })) setText(current => current === sent ? '' : current); } finally { setSendingText(false); } }}>
        <Field label="Type or paste text" hint="Text goes to the focused field on the computer."><Input value={text} maxLength={4000} onChange={event => setText(event.target.value)} disabled={controls.locked} /></Field>
        <Button size="sm" type="submit" busy={sendingText} disabled={!text || controls.locked || sendingText}>Send text</Button>
      </form>
    </>}
    {controls.recovery}
  </div>;
}
