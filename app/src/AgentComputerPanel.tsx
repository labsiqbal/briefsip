import { useCallback, useState } from 'react';
import { Alert, Badge, Button } from './ui/kit';
import { Monitor } from 'lucide-react';
import { useVisiblePolling } from './useVisiblePolling';
import type { DesktopStatus } from '../agent-desktop';
import type { ComputerControl, ComputerWait } from '../agent-computer';
export type ComputerStatus = DesktopStatus & { enabled: boolean; revision: number; control: ComputerControl; requests: ComputerWait[] };
export type ComputerRequest = <T>(path: string, body?: unknown) => Promise<T>;

export function AgentComputerPanel({ agent, request, onOpen }: { agent: string; request: ComputerRequest; onOpen: () => void }) {
  const [status, setStatus] = useState<ComputerStatus | null>(null), [error, setError] = useState(''), [frame, setFrame] = useState('');
  const running = !!status && ['running', 'idle'].includes(status.state);
  const root = useVisiblePolling(useCallback(async current => {
    try {
      const next = await request<ComputerStatus>(`/api/agents/${agent}/computer`);
      if (!current()) return;
      setStatus(next); setError('');
      if (next.enabled && ['running', 'idle'].includes(next.state)) {
        const response = await fetch(`/api/agents/${agent}/computer/screenshot`);
        if (!response.ok) throw new Error('Screen not updated.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!current()) return;
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        setFrame(`data:image/jpeg;base64,${btoa(binary)}`);
      } else setFrame('');
    } catch (error) { if (current()) setError(error instanceof Error ? error.message : 'Computer status unavailable.'); }
  }, [agent, request]));
  const label = running ? status?.requests.length ? 'Waiting for you' : 'Live' : status?.state === 'starting' ? 'Starting' : 'Off';
  return <div ref={root} className="bs-root k-stack computer-hero">
    {status?.available && <section aria-label="Computer"><div className="computer-compact-row">
      {running && frame ? <img src={frame} alt="Agent computer screen" className="computer-compact-thumb" /> : <Monitor size={16} aria-hidden />}
      <span className="computer-compact-info">Computer</span><Badge tone={running ? 'success' : 'neutral'}>{label}</Badge>
      <Button size="sm" variant="ghost" onClick={onOpen}>Open</Button>
    </div>{error && <Alert tone="error">{error}</Alert>}</section>}
  </div>;
}
