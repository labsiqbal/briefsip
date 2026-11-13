import { useEffect, useRef, useState } from 'react';
import { parseAgentTemplate, restoreTemplateImport, templateCommand, type AgentTemplate } from '../agent-template';

type Agent = { id: string; name: string; model: string; instructions: string; thread_limit: number; revision: number };
const storage = 'briefsip:agent-template-import';
export function AgentTemplateImport({ request, onCreated, onClose }: { request: <T>(path: string, data?: unknown) => Promise<T>; onCreated: (agent: Agent) => void; onClose: () => void }) {
  const [recovery] = useState(() => { try { return { pending: restoreTemplateImport(sessionStorage.getItem(storage)), invalid: false }; } catch { return { pending: null, invalid: true }; } });
  const [pending, setPending] = useState(recovery.pending), [invalid, setInvalid] = useState(recovery.invalid);
  const [draft, setDraft] = useState<AgentTemplate | null>(recovery.pending?.template ?? null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), generation = useRef(0), inFlight = useRef(false);
  useEffect(() => { heading.current?.focus(); return () => { generation.current++; }; }, []);
  async function choose(file?: File) {
    if (!file || pending || invalid || inFlight.current) return;
    const current = ++generation.current; setError(''); setDraft(null); setBusy(true);
    try {
      if (file.size > 750000) throw new Error('Template must be no larger than 750 KB.');
      const parsed = parseAgentTemplate(JSON.parse(await file.text()));
      if (current === generation.current) setDraft(parsed);
    } catch (error) { if (current === generation.current) setError(error instanceof SyntaxError ? 'File is not valid JSON.' : error instanceof Error ? error.message : 'Template could not be read.'); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function apply() {
    if (inFlight.current || busy || invalid || !draft) return;
    const current = generation.current; setError('');
    try {
      const command = pending ?? { id: crypto.randomUUID(), template: parseAgentTemplate(draft) };
      sessionStorage.setItem(storage, JSON.stringify(command)); setPending(command);
      inFlight.current = true; setBusy(true);
      const agent = await request<Agent>('/api/agents', templateCommand(command.template, command.id));
      if (current !== generation.current) return;
      // Remove only this command; preserve any newer recovery data.
      if (sessionStorage.getItem(storage) === JSON.stringify(command)) sessionStorage.removeItem(storage);
      onCreated(agent);
    } catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Import is not confirmed yet. Try again.'); }
    finally { inFlight.current = false; if (current === generation.current) setBusy(false); }
  }
  function discard() {
    if (inFlight.current || busy || !window.confirm('Ignore import recovery? The agent may already have been created. Check the agent list before importing again.')) return;
    try { sessionStorage.removeItem(storage); setPending(null); setDraft(null); setInvalid(false); setError(''); }
    catch { setError('Browser storage could not be updated. Try again.'); }
  }
  return <section className="setup"><h1 ref={heading} tabIndex={-1}>Import agent template</h1>
    <p>Check the name, model, and instructions before creating a new agent. Templates do not grant tool permissions, change provider credential settings, or replace existing agents.</p>
    <button className="secondary" onClick={onClose}>Back to agent</button>
    {error && <p role="alert" className="error">{error}</p>}
    {invalid ? <p role="alert">Import recovery data could not be read. <button className="secondary" disabled={busy} onClick={discard}>Ignore import recovery</button></p> : <>
      <label>JSON template file<input type="file" accept=".json,application/json" disabled={!!pending || busy} onChange={event => void choose(event.target.files?.[0])} /></label>
      {busy && <p role="status">Processing template...</p>}
      {pending && <p className="notice">Creation is not confirmed yet. Retry with the same request to avoid duplicates.</p>}
      {draft && <form onSubmit={event => { event.preventDefault(); void apply(); }}><fieldset disabled={busy || !!pending}>
        <legend>New profile preview</legend>
        {draft.avatar && <img className="avatar-preview" src={`data:image/png;base64,${draft.avatar}`} alt="Avatar to import" />}
        <button type="button" className="secondary" aria-disabled={!draft.avatar} onClick={() => { if (draft.avatar) { const { avatar, ...profile } = draft; setDraft(profile); } }}>Remove avatar</button>
        <label>Name<input required maxLength={80} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>Model<input required maxLength={160} value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} /></label>
        <label>Fallback model (optional)<input maxLength={160} value={draft.backupModel ?? ''} onChange={event => setDraft({ ...draft, backupModel: event.target.value })} /></label>
        <p className="muted">Models use the provider configured on this computer. Model IDs from another computer may be unavailable.</p>
        <label>Instructions<textarea required maxLength={8000} rows={8} value={draft.instructions} onChange={event => setDraft({ ...draft, instructions: event.target.value })} /></label>
        <label>Concurrent side threads<input type="number" required min={1} max={32} step={1} value={draft.threadLimit} onChange={event => setDraft({ ...draft, threadLimit: Number(event.target.value) })} /></label>
      </fieldset><div className="form-actions"><button disabled={busy}>{pending ? 'Retry creation' : 'Create agent from template'}</button>{pending && <button type="button" className="secondary" disabled={busy} onClick={discard}>Ignore import recovery</button>}</div></form>}
    </>}
  </section>;
}

export function AgentTemplateExport({ id, request }: { id: string; request: <T>(path: string) => Promise<T> }) {
  const [template, setTemplate] = useState<AgentTemplate | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, [id]);
  async function preview() {
    const current = ++version.current; setBusy(true); setError(''); setTemplate(null);
    try { const data = parseAgentTemplate(await request(`/api/agents/${id}/template`)); if (current === version.current) setTemplate(data); }
    catch (error) { if (current === version.current) setError(error instanceof Error ? error.message : 'Template could not load.'); }
    finally { if (current === version.current) setBusy(false); }
  }
  return <section><h2>Export profile template</h2><p>Export includes the saved profile and avatar, without history, conversation files, or provider credential settings. Instructions are included in the download: check for sensitive information before sharing the file.</p>
    <button className="secondary" disabled={busy} onClick={() => void preview()}>{busy ? 'Loading saved profile...' : 'Preview export template'}</button>
    {error && <p className="error" role="alert">{error}</p>}
    {template && <>{template.avatar && <img className="avatar-preview" src={`data:image/png;base64,${template.avatar}`} alt="Template avatar" />}<label>File contents to download<textarea readOnly rows={10} value={JSON.stringify(template, null, 2)} /></label><button className="secondary" onClick={() => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2) + '\n'], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'briefsip-agent-template.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}>Download reviewed template</button></>}
  </section>;
}
