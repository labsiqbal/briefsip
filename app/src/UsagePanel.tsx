import { useEffect, useRef, useState } from 'react';
import { HostMetricsSection } from './HostMetricsSection';

type Call = { account?: string; family: string; seq: number; agent_name: string; model: string; origin: string; purpose: string; phase: string; status: string; created: string; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null };
type Report = { summary: { calls: number; pending: number; failed: number; interrupted: number; input_tokens: string | null; output_tokens: string | null; total_tokens: string | null; unknown_input: number; unknown_output: number; unknown_total: number }; calls: Call[]; next_before: number | null };
const statuses: Record<string, string> = { pending: 'Waiting for response', received: 'Response received', failed: 'Failed or canceled', interrupted: 'Disconnected, result unknown' };
const amount = (value: number | string | null) => value === null ? 'Unknown' : BigInt(value).toLocaleString('en-US');
export function UsagePanel({ request, onClose }: { request: <T>(path: string) => Promise<T>; onClose: () => void }) {
  const [report, setReport] = useState<Report | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [cursors, setCursors] = useState<number[]>([]), before = cursors.at(-1);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [before]);
  useEffect(() => {
    let stopped = false; setReport(null); setError('');
    void request<Report>(`/api/usage${before ? `?before=${before}` : ''}`).then(data => { if (!stopped) setReport(data); }).catch(error => { if (!stopped) setError(error.message); });
    return () => { stopped = true; };
  }, [before, refresh]);
  return <section className="setup workflow-panel"><h1 ref={heading} tabIndex={-1}>Usage</h1>
    <div className="form-actions routine-actions"><button className="secondary" onClick={onClose}>Back to conversation</button><button className="secondary" onClick={() => setRefresh(value => value + 1)}>Reload usage</button></div>
    <HostMetricsSection request={request} />
    <h2>Provider usage</h2>
    <p>Calls recorded since tracking was enabled. Tokens come from provider reports, not estimates. Cost and remaining quota are unknown.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {!report ? !error && <p role="status">Loading usage...</p> : <><h2>All records</h2><p>{report.summary.calls} calls · {report.summary.pending} waiting · {report.summary.failed} failed or canceled · {report.summary.interrupted} disconnected</p>
      <dl><dt>Recorded input tokens</dt><dd>{amount(report.summary.input_tokens)} ({report.summary.unknown_input} calls without counts)</dd><dt>Recorded output tokens</dt><dd>{amount(report.summary.output_tokens)} ({report.summary.unknown_output} calls without counts)</dd><dt>Total recorded tokens</dt><dd>{amount(report.summary.total_tokens)} ({report.summary.unknown_total} calls without counts)</dd></dl>
      <p className="muted">Recorded totals may be incomplete. Failed or disconnected calls may still be billed by the provider. Tool responses are counted per call, not per user message.</p>
      <h2>Call history</h2>{!report.calls.length ? <p>No calls on this page yet.</p> : <ul className="routine-list">{report.calls.map(call => <li key={call.seq}><h3>{call.agent_name} · {call.model}</h3><p>{call.family === 'openai-images' ? 'OpenAI Images-compatible' : call.family === 'gemini' ? 'Gemini GenerateContent' : call.family === 'anthropic' ? 'Anthropic Messages' : 'OpenAI-compatible'} · {call.origin}</p><p>Account: {call.phase === 'image' ? 'Separate image provider' : call.account || 'Server default'}</p><p>{new Date(call.created).toLocaleString('en-US')} · {call.phase === 'image' ? 'Image generation' : call.phase === 'compaction' ? 'History summary' : call.purpose === 'routing' ? 'Channel recipient selection' : 'Agent or workflow reply'}</p><p>{statuses[call.status]}</p><p>Input: {amount(call.input_tokens)} · Output: {amount(call.output_tokens)} · Total: {amount(call.total_tokens)}</p></li>)}</ul>}
      <div className="form-actions routine-actions"><button className="secondary" disabled={!cursors.length} onClick={() => setCursors(value => value.slice(0, -1))}>Newer calls</button><button className="secondary" disabled={!report.next_before} onClick={() => setCursors(value => [...value, report.next_before!])}>Older calls</button></div>
    </>}
  </section>;
}
