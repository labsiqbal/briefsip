import { useEffect, useRef, useState } from 'react';
import { HostMetricsSection } from './HostMetricsSection';
import { Alert, Card, EmptyState, IconButton, PageHeader, Row, Section, SkeletonRows } from './ui/kit';
import { ChevronLeft, ChevronRight, RefreshCw, Receipt } from 'lucide-react';

type Call = { account?: string; family: string; seq: number; agent_name: string; model: string; origin: string; purpose: string; phase: string; status: string; created: string; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null };
type Report = { transcription: { calls: number; pending: number; uncertain: number; cancelled: number; unknown: number; input_tokens: string | null; output_tokens: string | null; total_tokens: string | null; seconds: number | null }; summary: { calls: number; pending: number; failed: number; interrupted: number; input_tokens: string | null; output_tokens: string | null; total_tokens: string | null; unknown_input: number; unknown_output: number; unknown_total: number }; calls: Call[]; next_before: number | null };
const statuses: Record<string, string> = { pending: 'Waiting for response', received: 'Response received', failed: 'Failed or canceled', interrupted: 'Disconnected, result unknown' };
const amount = (value: number | string | null) => value === null ? 'Unknown' : BigInt(value).toLocaleString('en-US');
export function UsagePanel({ request }: { request: <T>(path: string) => Promise<T>; onClose: () => void }) {
  const [report, setReport] = useState<Report | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [cursors, setCursors] = useState<number[]>([]), before = cursors.at(-1);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [before]);
  useEffect(() => {
    let stopped = false; setReport(null); setError('');
    void request<Report>(`/api/usage${before ? `?before=${before}` : ''}`).then(data => { if (!stopped) setReport(data); }).catch(error => { if (!stopped) setError(error.message); });
    return () => { stopped = true; };
  }, [before, refresh]);
  return <div className="k-page bs-root">
    <PageHeader headingRef={heading} title="Usage" description="Review provider calls and the host resources used by Briefsip."
      actions={<IconButton label="Reload usage" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden /></IconButton>} />
    <HostMetricsSection request={request} />
    <Section title="Provider usage">
      <p className="k-field__hint">Calls recorded since tracking was enabled. Tokens come from provider reports, not estimates. Cost and remaining quota are unknown.</p>
      {error && <Alert tone="error">{error}</Alert>}
      {!report ? !error && <SkeletonRows count={3} /> : <>
        <Section title="All records">
          <Card><Row title="Calls" trailing={report.summary.calls.toLocaleString('en-US')} /><Row title="Waiting" trailing={report.summary.pending.toLocaleString('en-US')} /><Row title="Failed or canceled" trailing={report.summary.failed.toLocaleString('en-US')} /><Row title="Disconnected" trailing={report.summary.interrupted.toLocaleString('en-US')} /><Row title="Recorded input tokens" meta={`${report.summary.unknown_input} calls without counts`} trailing={amount(report.summary.input_tokens)} /><Row title="Recorded output tokens" meta={`${report.summary.unknown_output} calls without counts`} trailing={amount(report.summary.output_tokens)} /><Row title="Total recorded tokens" meta={`${report.summary.unknown_total} calls without counts`} trailing={amount(report.summary.total_tokens)} /></Card>
          <p className="k-field__hint">Recorded totals may be incomplete. Failed or disconnected calls may still be billed by the provider. Tool responses are counted per call, not per user message.</p>
        </Section>
        <Section title="File transcription">
          <p className="k-field__hint">Separate from chat and image calls. Duration and tokens follow provider reports; missing values are not counted as zero. Cost is unknown. Details for the latest attempt are in the source file.</p>
          <Card><Row title="Calls" trailing={report.transcription.calls} /><Row title="Pending" trailing={report.transcription.pending} /><Row title="Uncertain" trailing={report.transcription.uncertain} /><Row title="Cancelled" trailing={report.transcription.cancelled} /><Row title="Without usage reports" trailing={report.transcription.unknown} /><Row title="Recorded input tokens" trailing={amount(report.transcription.input_tokens)} /><Row title="Recorded output tokens" trailing={amount(report.transcription.output_tokens)} /><Row title="Total recorded tokens" trailing={amount(report.transcription.total_tokens)} /><Row title="Recorded duration" trailing={report.transcription.seconds === null ? 'Unknown' : `${report.transcription.seconds.toLocaleString('en-US')} seconds`} /></Card>
        </Section>
        <Section title="Call history">
          {!report.calls.length ? <EmptyState icon={<Receipt size={18} />} title="No calls on this page yet" /> : <div className="k-table-wrap"><table className="k-table" style={{ minWidth: 1120, tableLayout: 'fixed' }}><colgroup><col style={{ width: 240 }} /><col style={{ width: 220 }} /><col style={{ width: 160 }} /><col style={{ width: 236 }} /><col style={{ width: 88 }} /><col style={{ width: 88 }} /><col style={{ width: 88 }} /></colgroup><thead><tr><th>Agent and model</th><th>Provider</th><th>Purpose</th><th>Status</th><th className="is-num">Input</th><th className="is-num">Output</th><th className="is-num">Total</th></tr></thead><tbody>{report.calls.map(call => <tr key={call.seq}><td style={{ overflowWrap: 'break-word' }}><strong>{call.agent_name}</strong><br /><span className="k-field__hint">{call.model}<br />{call.phase === 'image' ? 'Separate image provider' : call.account || 'Server default'}<br />{new Date(call.created).toLocaleString('en-US')}</span></td><td style={{ whiteSpace: 'nowrap' }}>{call.family === 'codex' ? 'Codex app-server' : call.family === 'claude' ? 'Claude Code' : call.family === 'openai-images' ? 'OpenAI Images-compatible' : call.family === 'gemini' ? 'Gemini GenerateContent' : call.family === 'anthropic' ? 'Anthropic Messages' : 'OpenAI-compatible'}<br /><span className="k-field__hint" title={call.origin} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{call.origin}</span></td><td style={{ overflowWrap: 'normal' }}>{call.phase === 'image' ? 'Image generation' : call.phase === 'compaction' ? 'History summary' : call.purpose === 'routing' ? 'Channel recipient selection' : 'Agent or workflow reply'}</td><td style={{ whiteSpace: 'nowrap' }}>{statuses[call.status]}</td><td className="is-num" style={{ whiteSpace: 'nowrap' }}>{amount(call.input_tokens)}</td><td className="is-num" style={{ whiteSpace: 'nowrap' }}>{amount(call.output_tokens)}</td><td className="is-num" style={{ whiteSpace: 'nowrap' }}>{amount(call.total_tokens)}</td></tr>)}</tbody></table></div>}
          {(cursors.length > 0 || !!report.next_before) && <div className="k-pager"><IconButton label="Newer calls" disabled={!cursors.length} onClick={() => setCursors(value => value.slice(0, -1))}><ChevronLeft size={16} aria-hidden /></IconButton><IconButton label="Older calls" disabled={!report.next_before} onClick={() => setCursors(value => [...value, report.next_before!])}><ChevronRight size={16} aria-hidden /></IconButton></div>}
        </Section>
      </>}
    </Section>
  </div>;
}
