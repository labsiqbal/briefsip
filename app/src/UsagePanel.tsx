import { useEffect, useRef, useState } from 'react';
import './machines-data.css';
import { Alert, Card, EmptyState, IconButton, PageHeader, Row, Section, SkeletonRows, Tabs, TabPanel, Tooltip } from './ui/kit';
import { ChevronLeft, ChevronRight, RefreshCw, Receipt } from 'lucide-react';

type Call = { account?: string; family: string; seq: number; agent_name: string; model: string; origin: string; purpose: string; phase: string; status: string; created: string; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null };
type Report = { transcription: { calls: number; pending: number; uncertain: number; cancelled: number; unknown: number; input_tokens: string | null; output_tokens: string | null; total_tokens: string | null; seconds: number | null }; summary: { calls: number; pending: number; failed: number; interrupted: number; input_tokens: string | null; output_tokens: string | null; total_tokens: string | null; unknown_input: number; unknown_output: number; unknown_total: number }; calls: Call[]; next_before: number | null };
const statuses: Record<string, string> = { pending: 'Waiting for response', received: 'Response received', failed: 'Failed or canceled', interrupted: 'Disconnected, result unknown' };
const amount = (value: number | string | null) => value === null ? 'Unknown' : BigInt(value).toLocaleString('en-US');
export function UsagePanel({ request }: { request: <T>(path: string) => Promise<T>; onClose: () => void }) {
  const [report, setReport] = useState<Report | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [tab, setTab] = useState('calls');
  const [cursors, setCursors] = useState<number[]>([]), before = cursors.at(-1);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [before]);
  useEffect(() => {
    let stopped = false; setReport(null); setError('');
    void request<Report>(`/api/usage${before ? `?before=${before}` : ''}`).then(data => { if (!stopped) setReport(data); }).catch(error => { if (!stopped) setError(error.message); });
    return () => { stopped = true; };
  }, [before, refresh]);
  return <div className="k-page bs-root set4-page">
    <PageHeader headingRef={heading} title="Usage"
      actions={<IconButton label="Reload usage" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden /></IconButton>} />
    {error && <Alert tone="error">{error}</Alert>}
    <Tabs value={tab} onChange={setTab} label="Usage" tabs={[{ value: 'calls', label: 'Calls' }, { value: 'transcription', label: 'Transcription' }]}>
      {!report ? !error && <SkeletonRows count={3} /> : <>
        <TabPanel value="calls">
          <Tooltip content={<span className="bs-root set4-tooltip">{"Provider-reported counts since tracking began. Totals may be incomplete; failed or disconnected calls may still be billed. Tool responses count per call, not per message."}</span>}><span className="k-field__hint" tabIndex={0}>Cost unknown · Quota unknown</span></Tooltip>
          <Card className="set4-totals"><Row title="Calls" trailing={report.summary.calls.toLocaleString('en-US')} /><Row title="Waiting" trailing={report.summary.pending.toLocaleString('en-US')} /><Row title="Failed or canceled" trailing={report.summary.failed.toLocaleString('en-US')} /><Row title="Disconnected" trailing={report.summary.interrupted.toLocaleString('en-US')} /><Row title="Input tokens" meta={<Tooltip content={<span className="bs-root set4-tooltip">{`${report.summary.unknown_input} calls without counts`}</span>}><span tabIndex={0}>{report.summary.unknown_input} unreported</span></Tooltip>} trailing={amount(report.summary.input_tokens)} /><Row title="Output tokens" meta={<Tooltip content={<span className="bs-root set4-tooltip">{`${report.summary.unknown_output} calls without counts`}</span>}><span tabIndex={0}>{report.summary.unknown_output} unreported</span></Tooltip>} trailing={amount(report.summary.output_tokens)} /><Row title="Total tokens" meta={<Tooltip content={<span className="bs-root set4-tooltip">{`${report.summary.unknown_total} calls without counts`}</span>}><span tabIndex={0}>{report.summary.unknown_total} unreported</span></Tooltip>} trailing={amount(report.summary.total_tokens)} /></Card>
        <Section title="Call history">
          {!report.calls.length ? <EmptyState icon={<Receipt size={18} />} title="No calls" /> : <div className="k-table-wrap"><table className="k-table" style={{ minWidth: 1120, tableLayout: 'fixed' }}><colgroup><col style={{ width: 240 }} /><col style={{ width: 220 }} /><col style={{ width: 160 }} /><col style={{ width: 236 }} /><col style={{ width: 88 }} /><col style={{ width: 88 }} /><col style={{ width: 88 }} /></colgroup><thead><tr><th>Agent and model</th><th>Provider</th><th>Purpose</th><th>Status</th><th className="is-num">Input</th><th className="is-num">Output</th><th className="is-num">Total</th></tr></thead><tbody>{report.calls.map(call => <tr key={call.seq}><td style={{ overflowWrap: 'break-word' }}><strong>{call.agent_name}</strong><br /><span className="k-field__hint">{call.model}<br />{call.phase === 'image' ? 'Separate image provider' : call.account || 'Server default'}<br />{new Date(call.created).toLocaleString('en-US')}</span></td><td style={{ whiteSpace: 'nowrap' }}>{call.family === 'codex' ? 'Codex app-server' : call.family === 'claude' ? 'Claude Code' : call.family === 'openai-images' ? 'OpenAI Images-compatible' : call.family === 'gemini' ? 'Gemini GenerateContent' : call.family === 'anthropic' ? 'Anthropic Messages' : 'OpenAI-compatible'}<br /><span className="k-field__hint" title={call.origin} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{call.origin}</span></td><td style={{ overflowWrap: 'normal' }}>{call.phase === 'image' ? 'Image generation' : call.phase === 'compaction' ? 'History summary' : call.purpose === 'routing' ? 'Channel recipient selection' : 'Agent or workflow reply'}</td><td style={{ whiteSpace: 'nowrap' }}>{statuses[call.status]}</td><td className="is-num" style={{ whiteSpace: 'nowrap' }}>{amount(call.input_tokens)}</td><td className="is-num" style={{ whiteSpace: 'nowrap' }}>{amount(call.output_tokens)}</td><td className="is-num" style={{ whiteSpace: 'nowrap' }}>{amount(call.total_tokens)}</td></tr>)}</tbody></table></div>}
          {(cursors.length > 0 || !!report.next_before) && <div className="k-pager"><IconButton label="Newer calls" disabled={!cursors.length} onClick={() => setCursors(value => value.slice(0, -1))}><ChevronLeft size={16} aria-hidden /></IconButton><IconButton label="Older calls" disabled={!report.next_before} onClick={() => setCursors(value => [...value, report.next_before!])}><ChevronRight size={16} aria-hidden /></IconButton></div>}
        </Section>
        </TabPanel>
        <TabPanel value="transcription">
          <Tooltip content={<span className="bs-root set4-tooltip">{"Provider-reported duration and tokens; missing values remain unknown. Latest attempt details are in the source file."}</span>}><span className="k-field__hint" tabIndex={0}>Cost unknown</span></Tooltip>
          <Card className="set4-totals"><Row title="Calls" trailing={report.transcription.calls} /><Row title="Pending" trailing={report.transcription.pending} /><Row title="Uncertain" trailing={report.transcription.uncertain} /><Row title="Cancelled" trailing={report.transcription.cancelled} /><Row title="Usage unknown" trailing={report.transcription.unknown} /><Row title="Input tokens" trailing={amount(report.transcription.input_tokens)} /><Row title="Output tokens" trailing={amount(report.transcription.output_tokens)} /><Row title="Total tokens" trailing={amount(report.transcription.total_tokens)} /><Row title="Duration" trailing={report.transcription.seconds === null ? 'Unknown' : `${report.transcription.seconds.toLocaleString('en-US')} seconds`} /></Card>
        </TabPanel>
      </>}
    </Tabs>
  </div>;
}
