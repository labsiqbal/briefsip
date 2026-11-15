import { useEffect, useRef, useState } from 'react';
import { parseAgentTemplate, restoreTemplateImport, templateCommand, type AgentTemplate } from '../agent-template';
import { Alert, Button, Card, CodeBlock, Field, Input, Section, Textarea, useConfirm, RecoveryAlert } from './ui/kit';

type Agent = { id: string; name: string; role: string; model: string; instructions: string; thread_limit: number; revision: number };
const storage = 'briefsip:agent-template-import';
export function AgentTemplateImport({ request, onCreated }: { request: <T>(path: string, data?: unknown) => Promise<T>; onCreated: (agent: Agent) => void; onClose: () => void }) {
  const [recovery] = useState(() => { try { return { pending: restoreTemplateImport(sessionStorage.getItem(storage)), invalid: false }; } catch { return { pending: null, invalid: true }; } });
  const [pending, setPending] = useState(recovery.pending), [invalid, setInvalid] = useState(recovery.invalid);
  const [draft, setDraft] = useState<AgentTemplate | null>(recovery.pending?.template ?? null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const generation = useRef(0), inFlight = useRef(false), fileInput = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();
  useEffect(() => () => { generation.current++; }, []);
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
  async function discard() {
    if (inFlight.current || busy || !await confirm({ title: 'Ignore import recovery?', description: 'The agent may already have been created. Check the agent list before importing again.', confirm: 'Ignore', danger: true })) return;
    try { sessionStorage.removeItem(storage); setPending(null); setDraft(null); setInvalid(false); setError(''); }
    catch { setError('Browser storage could not be updated. Try again.'); }
  }
  return <div className="k-page bs-root">
    {error && <Alert tone="error">{error}</Alert>}
    {invalid ? <Alert tone="error" title="Import recovery data could not be read." actions={<Button size="sm" disabled={busy} onClick={() => void discard()}>Ignore import recovery</Button>} /> : <>
      <Section title="Template file"><input ref={fileInput} hidden type="file" accept=".json,application/json" disabled={!!pending || busy} onChange={event => void choose(event.target.files?.[0])} /><div><Button autoFocus disabled={!!pending || busy} onClick={() => fileInput.current?.click()}>Choose file</Button></div>{busy && <p className="k-field__hint" role="status">Processing template...</p>}{pending && <RecoveryAlert inFlight={busy} tone="warn" title="Creation is not confirmed yet">Retry with the same request to avoid duplicates.</RecoveryAlert>}</Section>
      {draft && <form onSubmit={event => { event.preventDefault(); void apply(); }}>
        <Section title="New profile preview">
          <Card><fieldset disabled={busy || !!pending} className="k-fieldset" style={{ padding: 12 }}>
            <div className="k-inline">
              {draft.avatar && <img src={`data:image/png;base64,${draft.avatar}`} alt="Avatar to import" width={64} height={64} style={{ borderRadius: 12, objectFit: 'cover' }} />}
              <Button type="button" size="sm" variant="ghost" disabled={!draft.avatar} onClick={() => { if (draft.avatar) { const { avatar, ...profile } = draft; setDraft(profile); } }}>Omit avatar</Button>
            </div>
            <Field label="Name"><Input required maxLength={80} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></Field>
            <Field label="Role" optional hint="Shown under the agent's name, e.g. Orchestration agent"><Input maxLength={60} value={draft.role ?? ''} onChange={event => setDraft({ ...draft, role: event.target.value })} /></Field>
            <Field label="Model"><Input required maxLength={160} value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} /></Field>
            <Field label="Fallback model" optional><Input maxLength={160} value={draft.backupModel ?? ''} onChange={event => setDraft({ ...draft, backupModel: event.target.value })} /></Field>
            <p className="k-field__hint">Models use the provider configured on this computer. Model IDs from another computer may be unavailable.</p>
            <Field label="Instructions"><Textarea required maxLength={8000} rows={8} value={draft.instructions} onChange={event => setDraft({ ...draft, instructions: event.target.value })} /></Field>
            <Field label="Parallel chats"><Input type="number" required min={1} max={32} step={1} value={draft.threadLimit} onChange={event => setDraft({ ...draft, threadLimit: Number(event.target.value) })} /></Field>
          </fieldset></Card>
          <div className="k-row-actions"><Button type="submit" variant="primary" busy={busy} disabled={busy}>{pending ? 'Retry creation' : 'Create agent'}</Button>{pending && <Button type="button" disabled={busy} onClick={() => void discard()}>Ignore import recovery</Button>}</div>
        </Section>
      </form>}
    </>}
  </div>;
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
  return <div className="k-page bs-root"><Section title="Export template"><p className="k-field__hint">Export includes the saved profile and avatar, without history, conversation files, or provider credential settings. Instructions are included in the download: check for sensitive information before sharing the file.</p>
    <div className="k-row-actions"><Button size="sm" disabled={busy} onClick={() => void preview()}>{busy ? 'Loading saved profile...' : 'Preview export template'}</Button></div>
    {error && <Alert tone="error">{error}</Alert>}
    {template && <>{template.avatar && <img src={`data:image/png;base64,${template.avatar}`} alt="Template avatar" width={64} height={64} style={{ borderRadius: 12, objectFit: 'cover' }} />}<CodeBlock label="File contents to download">{JSON.stringify(template, null, 2)}</CodeBlock><div className="k-row-actions"><Button size="sm" variant="secondary" onClick={() => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2) + '\n'], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'briefsip-agent-template.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}>Download reviewed template</Button></div></>}
  </Section></div>;
}
