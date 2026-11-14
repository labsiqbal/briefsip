import { UpdatesPanel, useUpdateBadge } from './UpdatesPanel';
import { HarnessApprovalCard, type HarnessApproval } from './HarnessApprovalCard';
import './ui/csp-nonce';
import { SourceControl, RestoreCheckpoint } from './SourceControl';
import { ComputerViewer, ComputerRequestCard } from './ComputerViewer';
import type { ComputerWait } from '../agent-computer';
import { AgentComputerPanel } from './AgentComputerPanel';
import { AgentComputerSettings } from './AgentComputerSettings';
import { restoreChatCommand, restoreChannelCommand, type ChatCommand, type ChannelCommand } from '../conversation-command';
import { restoreAgentCreation, type AgentCreation } from '../agent-create';
import { AgentAvatar, AvatarEditor } from './AgentAvatar';
import { QueuePanel } from './QueuePanel';
import { QueueEditor } from './QueueEditor';
import { AgentVisibility } from './AgentVisibility';
import { Markdown } from './Markdown';
import { SpeechPlayback } from './SpeechPlayback';
import { AudioRecorder } from './AudioRecorder';
import { TranscriptionPanel } from './TranscriptionPanel';
import { TurnActivity } from './ui/TurnActivity';
import { livePartial, turnPollDelay, type TurnActivityData } from './ui/transcript';
import { EventConnection } from './EventConnection';
import { applyPresentation, readPresentation } from '../presentation';
import { AgentSidebar } from './AgentSidebar';
import { MachinesPanel, MachinesSidebar, RemoteAgentDetail, useMachines } from './MachinesPanel';
import { HtmlPreview } from './HtmlPreview';
import { QuestionCard, type Question } from './QuestionCard';
import { ApprovalCard, type AppApproval } from './ApprovalCard';
import { CompactionPanel } from './CompactionPanel';
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, useId, type FormEvent, type ReactNode } from 'react';
import { ArrowUp, Brain, CircleAlert, ChevronDown, ChevronLeft, ChevronRight, Clock, Ellipsis, FolderOpen, Hash, MessageSquare, PanelLeft, PanelRight, Paperclip, Plus, RefreshCw, Route, Settings, Workflow as WorkflowIcon, X } from 'lucide-react';
import { Menu, type MenuItem } from './ui/Menu';
import { PageView, useDetailsOpen } from './ui/layout';
import { PanelResizeHandle, detailsPanel, sidebarPanel, useResizablePanel } from './ui/resizable';
import { ActionMenu, Alert, Badge, Button, Card, Checkbox, CodeBlock, Collapsible, Combobox, ConfirmProvider, Dialog, EmptyState, Field, IconButton, Input, PageHeader, Row, Section, Segmented, Select, SkeletonRows, Textarea, useConfirm, type SelectOption } from './ui/kit';
import { createRoot } from 'react-dom/client';
import { Dialog as RadixDialog } from 'radix-ui';
import { validateFlow, type FlowGraph, type FlowLink } from '../flows.ts';
import './ui/tokens.css';
import './ui/base.css';
import './ui/shell.css';
import './ui/chat.css';
import './ui/details.css';
import './ui/modals.css';
import './ui/config.css';
import './ui/legacy.css';
import './ui/briefsip.css';
import './ui/kit.css';
import '@fontsource-variable/inter';

const panelLoadFailure = () => ({ default: () => <section className="empty"><h1>Panel could not be loaded</h1><p role="alert">Check your connection, then reload the app.</p><button onClick={() => window.location.reload()}>Reload app</button></section> });
const WorkspacePanel = lazy(() => import('./WorkspacePanel').then(module => ({ default: module.WorkspacePanel })).catch(panelLoadFailure));
const MemoryPanel = lazy(() => import('./MemoryPanel').then(module => ({ default: module.MemoryPanel })).catch(panelLoadFailure));
const WorkflowPanel = lazy(() => import('./WorkflowPanel').then(module => ({ default: module.WorkflowPanel })).catch(panelLoadFailure));
const WorkflowDirectory = lazy(() => import('./WorkflowDirectory').then(module => ({ default: module.WorkflowDirectory })).catch(panelLoadFailure));
const PresentationSettings = lazy(() => import('./PresentationSettings').then(module => ({ default: module.PresentationSettings })).catch(panelLoadFailure));
const SharedDataPanel = lazy(() => import('./SharedDataPanel').then(module => ({ default: module.SharedDataPanel })).catch(panelLoadFailure));
const UsagePanel = lazy(() => import('./UsagePanel').then(module => ({ default: module.UsagePanel })).catch(panelLoadFailure));
const BackupPanel = lazy(() => import('./BackupPanel').then(module => ({ default: module.BackupPanel })).catch(panelLoadFailure));
const AgentTemplateImport = lazy(() => import('./AgentTemplateImport').then(module => ({ default: module.AgentTemplateImport })).catch(panelLoadFailure));
const AgentTemplateExport = lazy(() => import('./AgentTemplateImport').then(module => ({ default: module.AgentTemplateExport })).catch(panelLoadFailure));
const SitesPanel = lazy(() => import('./SitesPanel').then(module => ({ default: module.SitesPanel })).catch(panelLoadFailure));
const McpServerPanel = lazy(() => import('./McpServerPanel').then(module => ({ default: module.McpServerPanel })).catch(panelLoadFailure));
const McpPanel = lazy(() => import('./McpPanel').then(module => ({ default: module.McpPanel })).catch(panelLoadFailure));
const ConnectedAppsPanel = lazy(() => import('./ConnectedAppsPanel').then(module => ({ default: module.ConnectedAppsPanel })).catch(panelLoadFailure));
const SkillsPanel = lazy(() => import('./SkillsPanel').then(module => ({ default: module.SkillsPanel })).catch(panelLoadFailure));

type Agent = { runtime?: 'api' | 'codex' | 'claude'; computer_waiting?: boolean; avatar_revision?: number; hidden?: boolean; visibility_revision?: number; provider_account?: string; provider_available?: boolean; backup_model?: string; thread_limit: number; revision: number; id: string; name: string; model: string; instructions: string };
type Channel = { activity: number; read_position: number; revision: number; archived: number; id: string; name: string; instructions: string; members: string[]; lead: string | null };
type Thread = { id: string; agent: string; name: string; revision: number; archived: number; deleted: number };
type AgentMessage = { taskId?: string; task?: string; wait?: boolean; generatedFiles?: { id: string; name: string; size: number; thread: string }[]; paused: number; request: string; expects_reply: number; settled: number; id: string; agent: string; thread: string; name: string; status: string; error: string | null; reply: string | null; truncated: boolean };
type Turn = { harnessApprovals?: HarnessApproval[]; computerWait?: ComputerWait; checkpoint?: { turn: string; restorable: boolean } | null; approvals?: AppApproval[]; recipient?: string | null; activity?: TurnActivityData; editing?: boolean; events?: { id: string; event: string; deadline: number; status: string }[]; receivedAgentReplies?: (AgentMessage & { source: string })[]; messageOrigin?: { kind?: 'peer'; name: string; agent: string | null; channel: string | null; thread: string | null } | null; agentMessages?: AgentMessage[]; partial?: { text: string; model: string; status: string } | null; answer_model?: string | null; questions?: Question[]; workflow_run?: string | null; no_update: number; generatedFiles?: { id: string; name: string; size: number }[]; seq: number; files?: { id: string; name: string; size: number }[]; revision: number; paused: number; agent: string; parent?: string | null; waiting_for?: string | null; coordination?: { kind: string; child: string | null; prompt: string; owner_name: string; target_name: string }[]; routing?: string | null; agent_name?: string; id: string; text: string; reply: string | null; status: string; error: string | null; created: string };
type Directory = { agents: Agent[]; configured: boolean; defaultModel: string };
type Pending = ChatCommand;
const statusNames: Record<string, string> = { queued: 'Queued', running: 'Replying', done: 'Done', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Cancelled' };
class HttpError extends Error { status: number; constructor(status: number, text: string) { super(text); this.status = status; } }
async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : undefined)
    .catch(() => { throw new Error('Briefsip connection lost. Check your connection, then try again.'); });
  const body = await response.json();
  if (!response.ok) throw new HttpError(response.status, body.error ?? `HTTP ${response.status}`);
  return body;
}
const message = (error: unknown) => error instanceof Error ? error.message : 'Connection failed. Try again.';

function ConversationFiles({ path, archived, attached, onAttach, locked, open, onOpenChange }: { path: string; archived: boolean; attached: string[]; onAttach: (ids: string[]) => void; locked: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  type StoredFile = { seq: number; id: string; name: string; size: number };
  type Upload = { id: string; name: string; size: number; digest: string; file?: File };
  const storageKey = `briefsip:upload:${path}`;
  const [recovered] = useState<Upload | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      return value && /^[0-9a-f-]{36}$/i.test(value.id) && typeof value.name === 'string' && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= 10 * 1024 * 1024 && /^[0-9a-f]{64}$/.test(value.digest) ? { id: value.id, name: value.name, size: value.size, digest: value.digest } : null;
    } catch { return null; }
  });
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false), [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<File | null>(null), [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState<StoredFile | null>(null), [previewText, setPreviewText] = useState<string | null>(null), [previewError, setPreviewError] = useState('');
  const pending = useRef<Upload | null>(recovered);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function clearUpload(id: string) {
    if (JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')?.id === id) sessionStorage.removeItem(storageKey);
    if (pending.current?.id === id) pending.current = null;
  }
  useEffect(() => {
    setPreviewText(null); setPreviewError('');
    if (!preview) return;
    let stopped = false;
    void api<{ text: string }>(`${path}/${preview.id}?preview=text`).then(result => { if (!stopped) setPreviewText(result.text); }).catch(error => { if (!stopped) setPreviewError(message(error)); });
    return () => { stopped = true; };
  }, [path, preview]);
  useEffect(() => {
    if (!open || busy) return;
    let stopped = false;
    setLoading(true);
    void api<StoredFile[]>(path).then(rows => { if (!stopped) { setFiles(rows); setMore(rows.length === 100); setError(''); } }).catch(error => { if (!stopped) setError(message(error)); }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [open, path, reload]);
  async function upload(event: FormEvent) {
    event.preventDefault(); if (busy || loading || recording) return;
    const file = pending.current?.file ?? selected;
    if (!file) { setError('Select the same file again to continue the upload.'); return; }
    if (file.size > 10 * 1024 * 1024) { setError('Maximum file size is 10 MiB.'); return; }
    setBusy(true); setError('');
    try {
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (!mounted.current) return;
      if (pending.current && (pending.current.name !== file.name || pending.current.size !== file.size || pending.current.digest !== digest)) throw new Error('File differs from the pending upload. Select the original file or check upload status.');
      const request = pending.current ?? { id: crypto.randomUUID(), name: file.name, size: file.size, digest };
      sessionStorage.setItem(storageKey, JSON.stringify({ id: request.id, name: request.name, size: request.size, digest: request.digest }));
      pending.current = { ...request, file };
      const response = await fetch(`${path}/${request.id}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file }).catch(() => { throw new Error('Connection lost. Try the same upload again.'); });
      const result = await response.json();
      if (!response.ok) throw new HttpError(response.status, result.error ?? 'Upload failed.');
      setFiles(current => [result, ...current.filter(file => file.id !== result.id)]);
      clearUpload(request.id); setSelected(null); if (input.current) input.current.value = '';
    } catch (error) {
      if (error instanceof HttpError && error.status < 500 && error.status !== 409) {
        try { if (pending.current) clearUpload(pending.current.id); } catch { /* Retain retry identity if browser storage is unavailable. */ }
      }
      setError(message(error));
    }
    finally { setBusy(false); }
  }
  async function checkPending() {
    const request = pending.current; if (!request || busy || loading) return;
    setBusy(true); setError('');
    try {
      const result = await api<StoredFile & { digest: string }>(`${path}/${request.id}?metadata=1`);
      if (result.name !== request.name || result.size !== request.size || result.digest !== request.digest) throw new Error('Receipt does not match the pending upload.');
      setFiles(current => [result, ...current.filter(file => file.id !== result.id)]);
      clearUpload(request.id); setSelected(null); if (input.current) input.current.value = '';
    } catch (error) { setError(error instanceof HttpError && error.status === 404 ? 'Upload was not saved. Select the original file again to continue.' : message(error)); }
    finally { setBusy(false); }
  }
  async function loadMore() {
    if (busy) return; setBusy(true); setError('');
    try {
      const rows = await api<StoredFile[]>(`${path}?before=${files.at(-1)!.seq}`);
      setFiles(current => [...current, ...rows.filter(row => !current.some(file => file.id === row.id))]); setMore(rows.length === 100);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  return <div className="k-stack bs-root"><Collapsible title="Conversation files" open={open} onOpenChange={onOpenChange}>
    <div className="k-stack">
      <p className="k-field__hint">Maximum 10 MiB per file. Select attachments to send with your next message. Up to four attachments: 32 KiB total UTF-8 text and 4 MiB total PNG/JPEG/WebP images. Select a model that supports images.</p>
      {open && <AudioRecorder disabled={archived || busy || loading || !!pending.current || !!selected} onRecording={setRecording} onReady={file => { setSelected(file); if (input.current) input.current.value = ''; }} />}
      <form className="k-stack" onSubmit={upload}>
        <input ref={input} type="file" hidden disabled={recording || busy || loading || !!pending.current?.file || (archived && !pending.current)} onChange={event => setSelected(event.target.files?.[0] ?? null)} />
        <div className="k-row-actions"><Button size="sm" disabled={recording || busy || loading || !!pending.current?.file || (archived && !pending.current)} onClick={() => input.current?.click()}>Choose file</Button><Button type="submit" size="sm" busy={busy} disabled={recording || busy || loading || (archived && !pending.current) || (!selected && !pending.current?.file)}>{busy ? 'Processing...' : pending.current ? 'Retry upload' : 'Upload file'}</Button></div>
        {selected && <span className="k-field__hint">{selected.name}</span>}
      </form>
      {pending.current && <Alert tone="warn" title={`Upload ${pending.current.name} is not confirmed yet`} actions={<Button size="sm" disabled={busy || loading} onClick={() => void checkPending()}>Check upload status</Button>}>Select the same file again or check upload status.</Alert>}
      {error && <Alert tone="error" actions={!pending.current && <Button size="sm" disabled={busy || loading} onClick={() => setReload(value => value + 1)}>Reload files</Button>}>{error}</Alert>}
      {loading ? <><span className="sr-only" role="status">Loading files...</span><SkeletonRows /></> : !error && files.length === 0 && <EmptyState title="No files yet" />}
      {files.length > 0 && <Card>{files.map(file => <Row key={file.id} title={<a className="k-link" href={`${path}/${file.id}`} download={file.name}>{file.name}</a>} meta={`${file.size.toLocaleString('en-US')} byte`}>
        <div className="k-stack"><Checkbox label={`Attach ${file.name}`} checked={attached.includes(file.id)} disabled={locked || archived || (!attached.includes(file.id) && attached.length >= 4)} onChange={checked => onAttach(checked ? [...attached, file.id] : attached.filter(id => id !== file.id))} />
        <div className="k-row-actions"><Button size="sm" variant="ghost" aria-label={`View text: ${file.name}`} onClick={() => setPreview(file)}>View text</Button><HtmlPreview path={`${path}/${file.id}`} name={file.name} request={api} /><TranscriptionPanel path={`${path}/${file.id}`} request={api} /></div></div>
      </Row>)}</Card>}
      {preview && <Section title={preview.name} actions={<Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Close preview</Button>}>{previewError ? <Alert tone="error">{previewError}</Alert> : previewText === null ? <p role="status">Loading preview...</p> : <CodeBlock label={`Preview ${preview.name}`}>{previewText || '(Empty file)'}</CodeBlock>}</Section>}
      {more && <Button size="sm" disabled={busy} onClick={() => void loadMore()}>Earlier files</Button>}
    </div>
  </Collapsible></div>;
}

function TaskControls({ turn, path, members, archived }: { turn: Turn; path: string; members: Agent[]; archived: boolean }) {
  const [recipient, setRecipient] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef<{ action: string; data: { id: string; revision: number; recipient?: string; acknowledgeUncertain?: boolean } } | null>(null);
  if (turn.computerWait || turn.approvals?.some(approval => approval.state === 'approval' || approval.state === 'ready' && !['failed','interrupted'].includes(turn.status)) || ['done','cancelled'].includes(turn.status) || turn.questions?.some(question => question.answer === null)) return null;
  const resumable = !!turn.paused || ['failed','interrupted'].includes(turn.status);
  async function control(action: string) {
    if (busy) return;
    const request = pending.current ?? { action, data: { id: crypto.randomUUID(), revision: turn.revision, ...(action === 'reassign' ? { recipient } : {}), ...(action !== 'pause' ? { acknowledgeUncertain: confirmed } : {}) } };
    pending.current = request; setBusy(true); setError('');
    try { await api(`${path}/${turn.id}/${request.action}`, request.data); pending.current = null; }
    catch (error) { if (error instanceof HttpError && error.status < 500) pending.current = null; setError(message(error)); }
    finally { setBusy(false); }
  }
  return <div className="turn-task-controls bs-root">
    {pending.current ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void control(pending.current!.action)}>Retry control</Button> : resumable ? <Collapsible title="Resume or reassign">
      <div className="k-stack">
        <p className="k-field__hint">Check previous results and effects in the provider. Resuming may resend steps that are not confirmed yet.</p>
        <Checkbox checked={confirmed} onChange={setConfirmed} label="I have checked previous results and effects" />
        <div><Button size="sm" variant="ghost" disabled={busy || archived || !confirmed} onClick={() => void control('resume')}>Resume task</Button></div>
        {members.length > 0 && !turn.approvals?.some(approval => approval.state === 'ready') && <><Field label="New owner"><Select value={recipient} onChange={setRecipient} options={[{ value: '', label: 'Select agent' }, ...members.map(member => ({ value: member.id, label: member.name }))]} /></Field><div><Button size="sm" variant="ghost" disabled={busy || archived || !confirmed || !recipient} onClick={() => void control('reassign')}>Reassign task</Button></div></>}
      </div>
    </Collapsible> : <div><Button size="sm" variant="ghost" disabled={busy || archived} onClick={() => void control('pause')}>Pause task</Button></div>}
    {error && <Alert tone="error">{error}</Alert>}
  </div>;
}

function Chat({ agent, configured, channel, thread, members = [], onRead, onEdit, onOpenAgent, onOpenChannel, menuItems = [], detailsExtra }: { menuItems?: MenuItem[]; detailsExtra?: ReactNode; onOpenChannel?: (channel: string) => void; onOpenAgent?: (agent: string, thread: string) => void; onRead?: () => Promise<void>; onEdit?: () => void; agent: Agent | Channel; configured: boolean; channel?: Channel; thread?: Thread; members?: Agent[] }) {
  const confirm = useConfirm();
  const archived = !!(channel?.archived || thread?.archived || (!channel && (agent as Agent).hidden));
  const scope = thread ? `thread:${thread.id}` : channel ? `channel:${agent.id}` : agent.id;
  const path = thread ? `/api/threads/${thread.id}/turns` : `/api/${channel ? 'channels' : 'agents'}/${agent.id}/turns`;
  const [showMemory, setShowMemory] = useState(false);
  const memoryButton = useRef<HTMLButtonElement>(null);
  const [focusedTask, setFocusedTask] = useState('');
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState('');
  const [historyPages, setHistoryPages] = useState<number[]>([]);
  const before = historyPages.at(-1);
  const historyTop = useRef<HTMLDivElement>(null);
  const focusHistory = useRef(false);
  const focusedOnce = useRef('');
  const loadedTask = useRef<string | null>(null);
  const recipientKey = `briefsip:recipient:${scope}`;
  const [recipient, setRecipient] = useState(() => {
    try { const saved = sessionStorage.getItem(recipientKey); if (saved !== null) return ((saved === '@automatic' && channel?.lead) || members.some(member => member.id === saved)) ? saved : ''; } catch { /* Keep the visible default when storage is unavailable. */ }
    return channel?.lead ?? (members.length === 1 ? members[0].id : '');
  });
  const attachmentKey = `briefsip:attachments:${scope}`;
  const [attached, setAttached] = useState<string[]>(() => { try { const ids = JSON.parse(sessionStorage.getItem(attachmentKey) ?? '[]'); return Array.isArray(ids) && ids.length <= 4 && ids.every(id => typeof id === 'string') ? ids : []; } catch { return []; } });
  function attach(ids: string[]) { try { sessionStorage.setItem(attachmentKey, JSON.stringify(ids)); setAttached(ids); } catch { setError('Attachment selection was not saved. Check browser storage.'); } }
  const storageKey = `briefsip:pending:${scope}`;
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const draftKey = `briefsip:draft:${scope}`;
  const [draft, setDraft] = useState(() => { try { return sessionStorage.getItem(draftKey) ?? ''; } catch { return ''; } });
  const [recovery] = useState(() => {
    try { return { command: restoreChatCommand(sessionStorage.getItem(storageKey), !!channel), blocked: false }; }
    catch { return { command: null, blocked: true }; }
  });
  const [pending, setPending] = useState<Pending | null>(recovery.command), [blocked, setBlocked] = useState(recovery.blocked);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [markingRead, setMarkingRead] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const requestActive = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let stopped = false;
    loadedTask.current = null;
    setTurns(null);
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      let delay = 1200;
      try { const data = await api<Turn[]>(focusedTask ? `${path}?focus=${focusedTask}` : `${path}?${new URLSearchParams({ ...(before ? { before: String(before) } : {}), ...(query ? { q: query } : {}) })}`); if (!stopped) { loadedTask.current = focusedTask; setTurns(data); setReadError(''); delay = turnPollDelay(data); } }
      catch (error) { if (!stopped) setReadError(message(error)); }
      if (!stopped) timer = setTimeout(refresh, delay);
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [path, focusedTask, before, query]);
  useEffect(() => {
    if (focusedTask && loadedTask.current === focusedTask && turns && focusedOnce.current !== focusedTask) {
      const target = document.getElementById(`turn-${focusedTask}`);
      if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start' }); focusedOnce.current = focusedTask; }
    }
    if (!focusedTask && loadedTask.current === '' && turns && focusHistory.current) {
      const target = !query && !before && turns.length ? document.getElementById(`turn-${turns.at(-1)!.id}`) : historyTop.current;
      if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: before ? 'start' : 'end' }); focusHistory.current = false; }
    }
    if (!focusedTask && !before && !query && nearBottom.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [focusedTask, turns, before, query]);
  useEffect(() => {
    if (!requestActive.current && pending && turns?.some(turn => turn.id === pending.id)) {
      try { sessionStorage.removeItem(storageKey); sessionStorage.removeItem(draftKey); sessionStorage.removeItem(attachmentKey); } catch { /* The same ID remains safe to retry. */ }
      setPending(null); setDraft(''); setAttached([]); setError('');
    }
  }, [turns, pending, storageKey, draftKey, attachmentKey]);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (requestActive.current || blocked || (!pending && !draft.trim())) return;
    if (archived) { setError('Restore the conversation before sending a new message.'); return; }
    const automatic = pending ? pending.automatic === true : recipient === '@automatic';
    if (channel && !pending && (automatic ? !channel.lead : !members.some(member => member.id === recipient))) {
      setError('Select a recipient agent before sending.'); return;
    }
    const request = pending ?? { id: crypto.randomUUID(), text: draft.trim(), ...(attached.length ? { files: attached } : {}), ...(channel ? automatic ? { automatic: true } : { recipient } : {}) };
    try { sessionStorage.setItem(storageKey, JSON.stringify(request)); }
    catch { setError('The browser could not save send status. Enable site storage before sending.'); return; }
    requestActive.current = true; setBusy(true); setPending(request); setError(''); nearBottom.current = true;
    try {
      await api(path, request);
      // A remounted conversation owns recovery and any newer draft after navigation.
      if (!mounted.current) return;
      sessionStorage.removeItem(storageKey); sessionStorage.removeItem(draftKey); sessionStorage.removeItem(attachmentKey); setPending(null); setDraft(''); setAttached([]); setFocusedTask(''); setHistoryPages([]); setQuery('');
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof HttpError && (error.status < 500 || error.status === 503)) {
        try { sessionStorage.removeItem(storageKey); sessionStorage.setItem(draftKey, request.text); } catch { /* Keep the draft in memory if storage fails. */ }
        setPending(null); setDraft(request.text);
      }
      setError(message(error));
    }
    finally { requestActive.current = false; setBusy(false); }
  }
  async function cancel(turn: Turn) {
    try { await api(`${path}/${turn.id}/cancel`, { id: crypto.randomUUID() }); setError(''); }
    catch (error) { setError(message(error)); }
  }
  const [menuOpen, setMenuOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useDetailsOpen();
  const details = useResizablePanel(detailsPanel);
  const [filesOpen, setFilesOpen] = useState(false);
  const filesSection = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = composer.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
    element.style.overflowY = element.scrollHeight > 200 ? 'auto' : 'hidden';
  }, [draft, pending, showMemory]);
  if (showMemory) return <PageView><Suspense fallback={<p className="empty" role="status">Loading memory...</p>}><MemoryPanel key={scope} path={`/api/${channel ? 'channels' : 'agents'}/${agent.id}/memory`} channel={!!channel} archived={!!channel?.archived} request={api} onClose={() => { setShowMemory(false); requestAnimationFrame(() => memoryButton.current?.focus()); }} /></Suspense></PageView>;
  const active = turns?.filter(turn => turn.status === 'queued' || turn.status === 'running').length ?? 0;
  const title = thread?.name ?? agent.name;
  const subtitle = channel ? `${members.length} members${channel.archived ? ' · Archived' : ''}` : thread ? `Side thread · ${agent.name}` : (agent as Agent).runtime && (agent as Agent).runtime !== 'api' ? `${(agent as Agent).runtime === 'codex' ? 'Codex' : 'Claude Code'} runtime` : (agent as Agent).model;
  const editLabel = channel ? 'Channel settings' : thread ? 'Conversation settings' : 'Edit profile';
  const openFiles = () => { setDetailsOpen(true); setFilesOpen(true); requestAnimationFrame(() => filesSection.current?.querySelector<HTMLButtonElement>('.k-collapsible__trigger')?.focus()); };
  const items: MenuItem[] = [
    ...menuItems,
    ...(onEdit ? [{ label: editLabel, onSelect: onEdit }] : []),
    { label: `${channel ? 'Channel' : 'Agent'} memory`, onSelect: () => setShowMemory(true) },
    { label: detailsOpen ? 'Hide details' : 'Show details', onSelect: () => setDetailsOpen(!detailsOpen) },
  ];
  const statusLabel = (turn: Turn) => turn.computerWait ? 'Waiting for you' : (turn.approvals?.some(approval => approval.state === 'approval') || turn.harnessApprovals?.some(approval => approval.state === 'approval')) && !['done','cancelled'].includes(turn.status) ? 'Waiting for approval' : turn.editing ? 'Editing' : turn.questions?.some(question => question.answer === null) && !['done','cancelled'].includes(turn.status) ? 'Waiting for your answer' : turn.no_update ? 'No updates' : turn.paused && !['done','cancelled'].includes(turn.status) ? 'Paused' : turn.agentMessages?.some(item => item.expects_reply && !item.settled) && turn.status === 'queued' ? 'Waiting for agent reply' : turn.waiting_for && turn.status === 'queued' ? 'Waiting for delegation' : turn.routing === 'pending' && turn.status === 'running' ? 'Selecting recipient' : turn.routing === 'clarify' ? 'Needs clarification' : turn.routing === 'none' ? 'No task needed' : turn.status === 'running' ? 'Running' : statusNames[turn.status] ?? turn.status;
  const tone = (turn: Turn) => turn.questions?.some(question => question.answer === null) && !['done','cancelled'].includes(turn.status) || turn.paused && !['done','cancelled'].includes(turn.status) ? 'attention' : ['failed','interrupted'].includes(turn.status) ? 'error' : ['queued','running'].includes(turn.status) ? 'working' : 'done';
  const time = (value: string) => new Date(value).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const openFocused = (id: string) => { focusedOnce.current = ''; setQuery(''); setFocusedTask(id); };
  return <div className="chat-row bs-root">
    <main className="chat" aria-label={`Conversation ${title}`}>
      <div className="transcript-wrap">
        <section className="transcript" aria-label="Conversation history" onScroll={event => { const el = event.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
          <div className="transcript__col">
            {(focusedTask || before || query) && <div className="history-banner" role="status"><span>{focusedTask ? channel ? 'Task family' : 'Selected message' : query ? `Search results: ${query}` : 'Older history'}</span><button type="button" className="link-btn" onClick={() => { focusHistory.current = true; setTurns(null); setFocusedTask(''); setHistoryPages([]); setQuery(''); focusedOnce.current = ''; nearBottom.current = true; }}>Back to latest messages</button></div>}
            {!focusedTask && <div ref={historyTop} tabIndex={-1} className="history-navigation" aria-label="History navigation">
              {!!turns && turns.length >= 100 && <button type="button" className="link-btn" onClick={() => { if (turns?.length) { focusHistory.current = true; setTurns(null); setHistoryPages([...historyPages, turns[0].seq]); } }}>Older messages</button>}
              {!!before && <button type="button" className="link-btn" onClick={() => { focusHistory.current = true; setTurns(null); setHistoryPages(historyPages.slice(0, -1)); nearBottom.current = true; }}>Newer messages</button>}
            </div>}
            {readError && <p role="alert" className="chat-notice is-error">{readError} History will be retried.</p>}
            {turns === null ? <p className="empty-chat__sub" role="status">Loading conversation...</p>
              : turns.length === 0 && query ? <p className="empty-chat__sub" role="status">No results on this page. Change your search term or return to the previous page.</p>
              : turns.length === 0 && before ? <p className="empty-chat__sub" role="status">Start of history reached. Select Newer messages to return.</p>
              : turns.length === 0 ? <div className="empty-chat"><AgentAvatar agent={agent} size={64} /><div className="empty-chat__title">Start with {agent.name}</div><div className="empty-chat__sub">Send your first task or question. The conversation is saved on this computer.</div></div>
              : turns.map(turn => <article key={turn.id} id={`turn-${turn.id}`} tabIndex={-1} className="turn-block">
                {query && <button type="button" className="link-btn" onClick={() => { setQuery(''); setHistoryPages([]); focusedOnce.current = ''; setFocusedTask(turn.id); }}>Open this message</button>}
                <div className="human-message" tabIndex={0} aria-label={turn.messageOrigin?.kind === 'peer' ? `Message from ${turn.messageOrigin.name}` : 'Your message'}>
                  <div className="human-bubble message-plain">{turn.text}</div>
                  {!!turn.files?.length && <ul className="chip-list" aria-label="Message attachments">{turn.files.map(file => <li key={file.id}><a className="cite-chip" href={`${path.replace(/\/turns$/, '/files')}/${file.id}`} download={file.name}><Paperclip size={12} aria-hidden /> {file.name}</a></li>)}</ul>}
                  <div className="turn-meta human-meta">
                    <time className="message-time" dateTime={turn.created} title={new Date(turn.created).toLocaleString('en-US')}>{time(turn.created)}</time>
                    {turn.messageOrigin?.kind === 'peer' ? <span className="message-origin">From {turn.messageOrigin.name}</span> : turn.workflow_run ? <span className="message-origin">Workflow</span> : turn.parent ? <span className="message-origin">Subtask</span> : null}
                    <button type="button" className="link-btn link-btn--small" onClick={async () => { try { await navigator.clipboard.writeText(turn.text); } catch { setError('Message could not be copied. Select the text to copy it.'); } }}>Copy</button>
                    <a className="link-btn link-btn--small" href={`#turn-${turn.id}`} onClick={event => { event.preventDefault(); openFocused(turn.id); }}>View task</a>
                    {turn.parent && !turn.messageOrigin && <a className="link-btn link-btn--small" href={`#turn-${turn.parent}`} onClick={event => { event.preventDefault(); openFocused(turn.parent!); }}>View parent task</a>}
                    {turn.messageOrigin && turn.messageOrigin.kind !== 'peer' && <button type="button" className="link-btn link-btn--small" onClick={() => turn.messageOrigin!.channel ? onOpenChannel?.(turn.messageOrigin!.channel) : onOpenAgent?.(turn.messageOrigin!.agent!, turn.messageOrigin!.thread ?? '')}>Open requester conversation</button>}
                  </div>
                </div>
                <div className="agent-message">
                  {channel && members.length > 1 && <div className="agent-identity"><AgentAvatar agent={members.find(member => member.id === turn.agent) ?? { id: turn.agent, name: turn.agent_name ?? agent.name }} size={24} /><strong className="message-name">{turn.agent_name ?? agent.name}</strong></div>}
                  <div className="message-column">
                    <TurnActivity turn={turn} agentName={agent.name} onOpenTask={openFocused} onOpenAgent={onOpenAgent} />
                    {!channel && turn.checkpoint?.restorable && ['done', 'failed', 'cancelled', 'interrupted'].includes(turn.status) && <RestoreCheckpoint agent={turn.agent} turn={turn.id} request={api} />}
                    <div className="message-body">
                      {turn.reply ? <div className="legacy"><Markdown text={turn.reply} scope={path.slice(0, -6)} origin={window.location.origin} /></div>
                        : livePartial(turn) ? <div className="live-answer" aria-label="Streaming answer"><div className="legacy"><Markdown text={turn.partial!.text} scope={path.slice(0, -6)} origin={window.location.origin} /></div><span className="stream-caret" aria-hidden /></div>
                        : <p className={turn.error ? 'message-error' : 'message-muted'}>{turn.error && <CircleAlert size={14} aria-hidden />}{turn.error ?? <span>{(turn.approvals?.some(approval => approval.state === 'approval') || turn.harnessApprovals?.some(approval => approval.state === 'approval')) ? 'Review the connected app action to continue.' : turn.questions?.some(question => question.answer === null) ? 'Answer the question to continue the task.' : turn.workflow_run ? 'Workflow finished without a text result.' : turn.agentMessages?.some(item => item.expects_reply && !item.settled) ? 'Results will be combined after all recipients finish. New messages include results already available.' : turn.events?.some(event => event.status === 'waiting') ? 'Waiting for a signed event.' : turn.waiting_for ? 'Waiting for child task results.' : turn.status === 'queued' ? 'Waiting for turn.' : 'Waiting for provider response...'}</span>}</p>}
                      {!turn.reply && turn.partial?.text && !livePartial(turn) && <div className="message-partial"><p className="message-muted">Text from a previous attempt from {turn.partial.model}. Not a final result.</p><div className="legacy"><Markdown text={turn.partial.text} scope={path.slice(0, -6)} origin={window.location.origin} /></div></div>}
                    </div>
                    <div className="turn-meta agent-meta">
                      <span className={`turn-status is-${tone(turn)}`}><i aria-hidden />{statusLabel(turn)}</span>
                      {(turn.answer_model || turn.partial?.model) && <span className="turn-model" title="Answering model">{turn.answer_model ?? turn.partial?.model}</span>}
                    </div>
                    <div className="turn-controls">
                      <TaskControls key={`${turn.id}:${turn.revision}`} turn={turn} path={path} members={channel ? members : []} archived={archived || !!turn.editing} />
                      {(!['done','cancelled'].includes(turn.status)) && <Button size="sm" variant="ghost" onClick={() => void cancel(turn)}>{turn.waiting_for ? 'Cancel task and delegation' : turn.status === 'running' ? 'Stop' : turn.status === 'queued' && !turn.paused ? 'Cancel queued task' : 'Cancel task'}</Button>}
                    </div>
                    <div className="turn-extras k-stack">
                      {turn.reply && <SpeechPlayback key={`${path}:${turn.id}`} owner={`${path}:${turn.id}`} text={turn.reply} />}
                      {turn.events?.map(event => <section className="k-stack" key={event.id}><Row title={`Event ${event.event}: ${event.status === 'waiting' ? 'Waiting' : event.status === 'received' ? 'Received' : event.status === 'expired' ? 'Expired' : 'Closed'}`} meta={new Date(event.deadline).toLocaleString('en-US')} />{event.status === 'waiting' && !archived && <EventConnection path={`/api/turn-waits/${event.id}`} request={api} />}</section>)}
                      {turn.harnessApprovals?.map(approval => <HarnessApprovalCard key={approval.id} approval={approval} path={`${path}/${turn.id}`} status={turn.status} archived={archived} request={api} />)}
                      {turn.approvals?.map(approval => <ApprovalCard key={approval.id} approval={approval} path={`${path}/${turn.id}`} status={turn.status} archived={archived} request={api} />)}
                      {turn.computerWait && <ComputerRequestCard agent={turn.agent} name={turn.agent_name ?? agent.name} wait={turn.computerWait} request={api} />}
                      {turn.questions?.map(question => <QuestionCard key={question.id} question={question} path={`${path}/${turn.id}`} status={turn.status} archived={archived} request={api} />)}
                      {!!turn.generatedFiles?.length && <section aria-label="Agent output files"><Card>{turn.generatedFiles.map(file => <Row key={file.id} title={<a className="k-link" href={`${path.replace(/\/turns$/, '/files')}/${file.id}`} download={file.name}>{file.name}</a>} meta={`${file.size} byte`}><HtmlPreview path={`${path.replace(/\/turns$/, '/files')}/${file.id}`} name={file.name} request={api} /></Row>)}</Card></section>}
                      {!!turn.receivedAgentReplies?.length && <Collapsible title={`Agent results received with this message (${turn.receivedAgentReplies.length})`}>{turn.receivedAgentReplies.map(item => <div className="k-stack" key={item.id}><div className="k-section__title message-plain"><strong>{item.name}</strong>: {statusNames[item.status] ?? item.status}</div>{item.error && <div className="k-field__error">{item.error}</div>}{item.reply && <div className="message-plain">{item.reply}</div>}{!!item.generatedFiles?.length && <Card>{item.generatedFiles.map(file => <Row key={file.id} title={<a className="k-link" href={`/api/threads/${file.thread}/files/${file.id}`} download={file.name}>{file.name}</a>} meta={`${file.size} bytes`} />)}</Card>}{item.truncated && <div className="k-field__hint">Result excerpt. Open the conversation for the full text.</div>}{onOpenAgent && <div className="k-row-actions"><Button size="sm" variant="ghost" onClick={() => onOpenAgent(item.agent, item.thread)}>Open conversation {item.name}</Button></div>}</div>)}</Collapsible>}
                      {!!turn.agentMessages?.length && <Collapsible title={`Inter-agent messages (${turn.agentMessages.length})`}>{turn.agentMessages.map(item => <div className="k-stack" key={item.id}><div className="k-section__title message-plain"><strong>{item.name}</strong>: {item.paused && !['done','cancelled'].includes(item.status) ? 'Paused' : statusNames[item.status] ?? item.status}{!item.expects_reply && ' (no reply)'}</div>{item.error && <div className="k-field__error">{item.error}</div>}{item.reply && <div className="message-plain">{item.reply.slice(0, 1000)}</div>}{!!item.generatedFiles?.length && <Card>{item.generatedFiles.map(file => <Row key={file.id} title={<a className="k-link" href={`/api/threads/${file.thread}/files/${file.id}`} download={file.name}>{file.name}</a>} meta={`${file.size} bytes`} />)}</Card>}{(item.truncated || (item.reply?.length ?? 0) > 1000) && <div className="k-field__hint">Result excerpt. Open the conversation for the full text.</div>}{onOpenAgent && <div className="k-row-actions"><Button size="sm" variant="ghost" onClick={() => onOpenAgent(item.agent, item.thread)}>Open conversation {item.name}</Button></div>}</div>)}</Collapsible>}
                      {!!turn.coordination?.length && <Collapsible title={`Task coordination (${turn.coordination.length})`}>{turn.coordination.map((action, index) => <div className="k-stack" key={index}><div className="k-section__title">{action.owner_name} {action.kind === 'delegate_task' ? 'delegated to' : 'reassigned to'} {action.target_name}.</div><div className="message-plain">{action.prompt}</div>{action.child && <div className="k-row-actions"><Button size="sm" variant="ghost" onClick={() => openFocused(action.child!)}>View subtask</Button></div>}</div>)}</Collapsible>}
                      {!turn.approvals?.length && <QueueEditor turn={{ ...turn, files: turn.files ?? [] }} path={path} archived={archived} request={api} />}
                    </div>
                  </div>
                </div>
              </article>)}
            <div ref={bottom} />
          </div>
        </section>
      </div>
      <footer className="composer-area">
        {archived && <p className="composer__note">{!channel && (agent as Agent).hidden ? 'Agent is hidden. Restore it through Edit profile to resume the queue and receive new messages.' : 'Conversation is archived. History remains available. Restore it through settings to send new messages.'}</p>}
        {!configured && <p className="composer__note">{!channel && 'provider_account' in agent && !!agent.provider_account && agent.provider_available === false ? 'This agent provider account is unavailable. Select a connected account in the agent profile, or restore the account configuration on the server.' : 'Provider not connected. Check provider account configuration on the server, then restart the app.'} Agent and history remain saved.</p>}
        {error && <div className="composer__error" role="alert"><span>{error} {pending && 'Use Retry send to check the same request without creating a duplicate message.'}</span></div>}
        {blocked && <div className="composer__error" role="alert"><span>Message recovery data could not be read. Sending is blocked. Check history to confirm the previous message was not sent.</span><Button size="sm" variant="ghost" onClick={async () => { if (!await confirm({ title: 'Discard recovery data?', description: 'The previous message may already have been received. Check history before sending another message.', confirm: 'Discard message recovery', danger: true })) return; try { sessionStorage.removeItem(storageKey); setBlocked(false); setError(''); requestAnimationFrame(() => composer.current?.focus()); } catch { setError('Recovery data could not be deleted. Check site storage.'); } }}>Discard message recovery</Button></div>}
        {(pending?.files ?? attached).length > 0 && <p className="composer__note"><Paperclip size={12} aria-hidden /> {(pending?.files ?? attached).length} attachments will be sent to the provider with the message.</p>}
        <form className={`composer${draft.includes('\n') ? ' is-multiline' : ''}`} onSubmit={send}>
          <div className="composer__left">
            <span className="composer__plus-anchor"><button type="button" className="composer__btn" onClick={openFiles} aria-label="Attach conversation file" title="Attach file"><Paperclip size={14} aria-hidden /></button></span>
            {channel && <span className="composer__recipient"><input type="hidden" id="recipient" value={pending?.automatic ? '@automatic' : pending?.recipient ?? recipient} disabled={!!pending || busy} /><Select size="sm" label="Reply from" value={pending?.automatic ? '@automatic' : pending?.recipient ?? recipient} disabled={!!pending || busy} onChange={value => { setRecipient(value); try { sessionStorage.setItem(recipientKey, value); } catch { setError('Recipient selection was not saved. Check again before sending.'); } }} options={[{ value: '', label: 'Select agent' }, ...(channel.lead ? [{ value: '@automatic', label: 'Automatic via lead' }] : []), ...members.map(member => ({ value: member.id, label: `${member.name}${member.id === channel.lead ? ' (lead)' : ''}` }))]} /></span>}
            <label className="sr-only" htmlFor="message">Message {agent.name}</label>
            <textarea ref={composer} id="message" className="composer__input" rows={1} placeholder={`Message ${agent.name}`} maxLength={16000} value={pending?.text ?? draft} readOnly={blocked || !!pending || busy} onChange={event => { setDraft(event.target.value); try { sessionStorage.setItem(draftKey, event.target.value); } catch { setError('Draft was not saved in the browser. Copy the message before switching agents.'); } }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          </div>
          <div className="composer__right">
            {pending && !busy && <span className="composer__retry">Retry send</span>}
            <button type="submit" className="composer__cta" disabled={blocked || archived || !configured || busy || (!pending && !draft.trim()) || (!!channel && !recipient && !pending)} aria-label={busy ? 'Sending...' : pending ? 'Retry send' : 'Send message'} title={pending ? 'Retry send' : 'Send (Enter)'}>{busy ? <span className="step__spin" aria-hidden /> : <ArrowUp size={16} aria-hidden />}</button>
          </div>
        </form>
        <p className="composer__foot" title="Provider receives up to 40 previous conversations.">{focusedTask ? channel ? 'Task family shown · ' : 'Selected message shown · ' : query ? 'Up to 100 results per page · ' : before ? 'Up to 100 older messages per page · ' : ''}Enter to send, Shift+Enter for a new line</p>
      </footer>
      <header className="chat__header">
        <span className="chat__pill-anchor">
          <button type="button" className="chat__pill" onClick={() => setMenuOpen(!menuOpen)} aria-haspopup="menu" aria-expanded={menuOpen}>
            <AgentAvatar agent={agent} size={24} />
            <span className="chat__pill-name">{title}</span>
            <ChevronDown size={14} aria-hidden className="chat__pill-chev" />
          </button>
          {menuOpen && <Menu align="center" label={`Menu ${title}`} onClose={() => setMenuOpen(false)} items={items} />}
        </span>
        <div className="chat__header-right">
          <span className={`activity-chip${active ? ' is-working' : ''}`} role="status">{active ? `${active} ${active === 1 ? 'message' : 'messages'} processing` : channel ? 'Shared channel' : 'Direct conversation'}</span>
          {!detailsOpen && <button type="button" className="icon-btn icon-btn--bordered" onClick={() => setDetailsOpen(true)} aria-label="Show details" title="Show details"><PanelRight size={16} aria-hidden /></button>}
        </div>
      </header>
    </main>
    {detailsOpen && <aside className="details" style={{ width: `${details.width}px` }} aria-label="Conversation details">
      <PanelResizeHandle panel={details} />
      <div className="details__top">
        {onEdit && <button type="button" className="icon-btn icon-btn--bordered details__gear" onClick={onEdit} aria-label={editLabel} title={editLabel}><Settings size={16} aria-hidden /></button>}
        <button type="button" className="icon-btn icon-btn--bordered" onClick={() => setDetailsOpen(false)} aria-label="Close details"><X size={16} aria-hidden /></button>
      </div>
      <div className="details__scroll">
        <div className="details__identity">
          <AgentAvatar agent={agent} size={64} />
          <div className="details__name" title={title}>{title}</div>
          <div className="details__who-sub">{subtitle}</div>
        </div>
        <div className="details__sections">
          {detailsExtra}
          {!channel && <SourceControl key={agent.id} agent={agent.id} request={api} />}
          {!channel && <AgentComputerPanel key={agent.id} agent={agent.id} name={agent.name} request={api} />}
          {channel && <section><div className="section-label">Read status</div><div className="panel-card"><div className="panel-row panel-row--setting"><span>{channel.activity > channel.read_position ? 'Unread activity' : 'All activity read'}</span><button type="button" className="cfg-btn cfg-btn--secondary" disabled={markingRead || channel.activity <= channel.read_position} onClick={() => { setMarkingRead(true); void onRead?.().catch(error => setError(message(error))).finally(() => setMarkingRead(false)); }}>Mark as read</button></div></div></section>}
          <section>
            <div className="section-label">Search conversation</div>
            <form className="details-search" role="search" onSubmit={event => { event.preventDefault(); if (!searchText.trim()) return; focusHistory.current = true; nearBottom.current = false; setQuery(searchText); setFocusedTask(''); setHistoryPages([]); focusedOnce.current = ''; }}>
              <label className="sr-only" htmlFor="history-search">Search this conversation</label>
              <input id="history-search" className="text-input" type="search" maxLength={200} value={searchText} onChange={event => setSearchText(event.target.value)} aria-describedby="history-search-help" placeholder="Message or reply" />
              <button type="submit" className="cfg-btn cfg-btn--secondary" disabled={!searchText.trim()}>Search</button>
            </form>
            <p id="history-search-help" className="details-hint">Case-sensitive.</p>
          </section>
          <section>
            <div className="section-label">Memory and context</div>
            <div className="panel-card"><button ref={memoryButton} type="button" className="panel-row panel-row--action" onClick={() => setShowMemory(true)}><Brain size={16} aria-hidden /> {channel ? 'Channel' : 'Agent'} memory</button></div>
            <CompactionPanel path={path.replace(/\/turns$/, '/compaction')} request={api} />
          </section>
          <section ref={filesSection}><ConversationFiles path={path.replace(/\/turns$/, '/files')} archived={archived} attached={pending?.files ?? attached} onAttach={attach} locked={blocked || !!pending || busy} open={filesOpen} onOpenChange={setFilesOpen} /></section>
          <section><QueuePanel path={path} request={api} onOpen={id => { setQuery(''); setHistoryPages([]); focusedOnce.current = ''; setFocusedTask(id); }} /></section>
        </div>
      </div>
    </aside>}
  </div>;
}

function WorkflowConversation({ agent, threadId, configured, onOpenAgent, onOpenChannel }: { agent?: Agent; threadId: string; configured: boolean; onOpenAgent: (agent: string, thread: string) => void; onOpenChannel: (channel: string) => void }) {
  const [thread, setThread] = useState<Thread | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => {
    if (!agent) return;
    let stopped = false; setThread(null); setError('');
    void api<Thread[]>(`/api/agents/${agent.id}/threads`).then(rows => {
      if (stopped) return;
      const current = rows.find(item => item.id === threadId);
      if (current) setThread(current); else setError('Step conversation is no longer available. Return to the run to view saved results.');
    }).catch(error => { if (!stopped) setError(message(error)); });
    return () => { stopped = true; };
  }, [agent?.id, threadId, reload]);
  if (!agent) return <p className="error" role="alert">Step agent is no longer available.</p>;
  if (error) return <p className="error" role="alert">{error} <button className="secondary" onClick={() => setReload(value => value + 1)}>Reload step conversation</button></p>;
  if (!thread) return <p className="empty" role="status">Loading step conversation...</p>;
  return <Chat key={thread.id} agent={agent} thread={thread} configured={(agent.runtime && agent.runtime !== 'api' ? agent.provider_available === true : configured && agent.provider_available !== false)} onOpenAgent={onOpenAgent} onOpenChannel={onOpenChannel} />;
}

type Routine = { trigger: 'schedule' | 'webhook'; id: string; agent: string; name: string; prompt: string; next_at: number; interval_ms: number | null; enabled: number; revision: number };
type RoutineRun = { paused: number; source: string; no_update: number; turn: string; thread: string; scheduled_at: number | null; created: string; missed: number; status: string; reply: string | null; error: string | null };
type RoutineCommand = { routineId: string | null; data: { id: string; revision?: number; trigger?: 'schedule' | 'webhook'; name: string; prompt: string; nextAt: number; intervalSeconds: number | null; enabled: boolean } };
function pendingRoutine(agent: string): RoutineCommand | null {
  try { const value = JSON.parse(sessionStorage.getItem(`briefsip:routine-command:${agent}`) ?? 'null'); return value && typeof value.data?.id === 'string' && typeof value.data.name === 'string' && typeof value.data.prompt === 'string' && Number.isSafeInteger(value.data.nextAt) && value.data.nextAt > 0 && value.data.nextAt <= 253370764799999 && typeof value.data.enabled === 'boolean' && (value.data.intervalSeconds === null || Number.isSafeInteger(value.data.intervalSeconds)) && (value.routineId === null || typeof value.routineId === 'string') ? value : null; } catch { return null; }
}
function TestRoutine({ routine, actions }: { routine: Routine; actions: { label: string; onSelect: () => void }[] }) {
  const key = `briefsip:routine-test:${routine.id}`;
  const [pending, setPending] = useState<{ id: string; revision: number } | null>(() => {
    try { const value = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return value && typeof value.id === 'string' && Number.isSafeInteger(value.revision) ? value : null; } catch { return null; }
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [accepted, setAccepted] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  async function run() {
    if (busy) return;
    const request = pending ?? { id: crypto.randomUUID(), revision: routine.revision };
    try { sessionStorage.setItem(key, JSON.stringify(request)); } catch { setError('Test status was not saved in the browser. Check site storage.'); return; }
    setPending(request); setBusy(true); setError(''); setAccepted(false);
    try {
      await api(`/api/routines/${routine.id}/test`, request);
      if (!mounted.current) return;
      sessionStorage.removeItem(key); setPending(null); setAccepted(true);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof HttpError && error.status < 500) { sessionStorage.removeItem(key); setPending(null); }
      setError(message(error));
    } finally { if (mounted.current) setBusy(false); }
  }
  const label = busy ? 'Sending test...' : pending ? `Retry test ${routine.name}` : `Test now ${routine.name}`;
  return <Row title={routine.name} meta={<>{routine.trigger === 'webhook' && <Badge>Webhook</Badge>}<span>{routine.trigger === 'webhook' ? routine.enabled ? 'Waiting for webhook event' : 'Webhook inactive' : routine.enabled ? `Next: ${new Date(routine.next_at).toLocaleString('en-US')}` : 'Schedule inactive'}{routine.trigger === 'webhook' ? '' : routine.interval_ms ? ` · Every ${routine.interval_ms / 60000} minutes` : ' · One time'}</span></>} trailing={<ActionMenu label={`Menu ${routine.name}`} trigger={<button type="button" className="k-icon-btn" aria-label={`Menu ${routine.name}`}><Ellipsis size={16} aria-hidden /></button>} items={[...actions, { label, disabled: busy, onSelect: () => void run() }]} />}>
    {error && <Alert tone="error">{error}</Alert>}
    {pending && !busy && <Alert tone="warn" title="Test is not confirmed yet">Try again to check the same request without creating a duplicate run.</Alert>}
    {accepted && <Alert>Test accepted. View progress in Runs.</Alert>}
  </Row>;
}
function ScriptAccess({ agent }: { agent: string }) {
  const key = `briefsip:script-access:${agent}`;
  const [access, setAccess] = useState<{ enabled: number; revision: number; configured: boolean } | null>(null);
  const [pending, setPending] = useState<{ id: string; revision: number; enabled: boolean } | null>(() => {
    try { const value = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return value && typeof value.id === 'string' && Number.isSafeInteger(value.revision) && typeof value.enabled === 'boolean' ? value : null; } catch { return null; }
  });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const mounted = useRef(true);
  const readVersion = useRef(0);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    let stopped = false;
    const version = ++readVersion.current;
    void api<NonNullable<typeof access>>(`/api/agents/${agent}/scripts`).then(data => { if (!stopped && version === readVersion.current) { setAccess(data); setError(''); } }).catch(error => { if (!stopped && version === readVersion.current) setError(message(error)); });
    return () => { stopped = true; };
  }, [agent, reload]);
  async function save() {
    if (busy || !access) return;
    const request = pending ?? { id: crypto.randomUUID(), revision: access.revision, enabled: !access.enabled };
    try { sessionStorage.setItem(key, JSON.stringify(request)); } catch { setError('Permission status was not saved in the browser. Check site storage.'); return; }
    readVersion.current++;
    setPending(request); setBusy(true); setError('');
    try {
      await api(`/api/agents/${agent}/scripts`, request);
      const latest = await api<NonNullable<typeof access>>(`/api/agents/${agent}/scripts`);
      if (!mounted.current) return;
      sessionStorage.removeItem(key); setPending(null); setAccess(latest);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof HttpError && error.status < 500) { sessionStorage.removeItem(key); setPending(null); setAccess(null); }
      setError(message(error));
    } finally { if (mounted.current) setBusy(false); }
  }
  return <Section title="Local script">
    <p className="k-field__hint">A script with a server token can read and run routines, create side threads, send direct or side messages, read results, answer questions, approve or reject workflow approvals, and change this agent’s model and provider account. Turning off access does not stop work already accepted.</p>
    {access && <Alert>{access.enabled ? 'Script access is active.' : 'Script access is inactive.'}{!access.configured && ' Script token is not configured on the server.'}</Alert>}
    {pending && <Alert tone="warn" title="Permission change is not confirmed yet">Save again to check the same request.</Alert>}
    {error && <Alert tone="error">{error}</Alert>}
    <div className="k-row-actions"><Button busy={busy} disabled={busy || !access || (!pending && !access.enabled && !access.configured)} onClick={() => void save()}>{busy ? 'Saving permission...' : pending ? 'Retry saving permission' : access?.enabled ? 'Disable script access' : 'Allow script access'}</Button><IconButton label="Reload permission" disabled={busy} onClick={() => setReload(value => value + 1)}><RefreshCw size={15} aria-hidden /></IconButton></div>
  </Section>;
}
type WebhookConfig = { route: string; revision: number; url: string; event_name: string; filters: unknown[]; secret?: string };
function WebhookSettings({ routine, onBack }: { routine: Routine; onBack: () => void }) {
  type Command = { id: string; revision: number; rotate: boolean; eventName: string; filters: unknown[] };
  const key = `briefsip:webhook:${routine.id}`, path = `/api/routines/${routine.id}/webhook`;
  const [pending, setPending] = useState<Command | null>(() => {
    try { const value = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return value && typeof value.id === 'string' && Number.isSafeInteger(value.revision) && typeof value.rotate === 'boolean' && typeof value.eventName === 'string' && Array.isArray(value.filters) ? value : null; } catch { return null; }
  });
  const [hook, setHook] = useState<WebhookConfig | null | undefined>(undefined), [secret, setSecret] = useState('');
  const [events, setEvents] = useState<{ delivery: string; received: number; result: { outcome: string; reason?: string } }[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [conflict, setConflict] = useState(false), [reload, setReload] = useState(0);
  const mounted = useRef(true), loadVersion = useRef(0);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    let stopped = false; const version = ++loadVersion.current;
    void Promise.all([api<WebhookConfig | null>(path), api<typeof events>(`/api/routines/${routine.id}/webhook-events`)]).then(([config, receipts]) => {
      if (!stopped && version === loadVersion.current) { setHook(config); setEvents(receipts); setConflict(false); setError(''); }
    }).catch(error => { if (!stopped && version === loadVersion.current) setError(message(error)); });
    return () => { stopped = true; };
  }, [path, routine.id, reload]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || conflict || hook === undefined) return;
    let request: Command;
    try {
      const fields = new FormData(event.currentTarget);
      request = pending ?? { id: crypto.randomUUID(), revision: hook?.revision ?? 0, rotate: !hook || fields.get('rotate') === 'on', eventName: String(fields.get('eventName')), filters: JSON.parse(String(fields.get('filters'))) };
      if (!Array.isArray(request.filters)) throw new Error('Filter must be a JSON list.');
      sessionStorage.setItem(key, JSON.stringify(request));
    } catch { setError('Filter must be a valid JSON list and browser storage must be available.'); return; }
    loadVersion.current++; setPending(request); setBusy(true); setError(''); setSecret('');
    try {
      const result = await api<WebhookConfig>(path, request);
      const latest = await api<WebhookConfig | null>(path);
      if (!mounted.current) return;
      if (!latest || latest.revision !== result.revision || latest.route !== result.route) throw new HttpError(409, 'Webhook changed. Reload before using the secret.');
      sessionStorage.removeItem(key); setPending(null); setHook(latest); setSecret(result.secret ?? '');
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof HttpError && error.status < 500) { sessionStorage.removeItem(key); setPending(null); setConflict(true); }
      setError(message(error));
    } finally { if (mounted.current) setBusy(false); }
  }
  return <div className="k-page bs-root">
    <PageHeader title={`Webhook ${routine.name}`} description="The local URL receives signed events while Briefsip is running. Payloads are sent to the provider. This URL is not available from the internet."
      actions={<><Button variant="ghost" onClick={onBack}>Back</Button><IconButton label="Reload webhook" disabled={busy} onClick={() => { setSecret(''); setReload(value => value + 1); }}><RefreshCw size={15} aria-hidden /></IconButton></>} />
    {hook && <Field label="Webhook URL"><Input readOnly value={hook.url} onFocus={event => event.target.select()} /></Field>}
    {secret && <Field label="New secret" hint="Copy this to the sender’s secret storage. The secret is not saved in the browser and will not be shown again after the page closes."><Input readOnly value={secret} autoComplete="off" spellCheck={false} onFocus={event => event.target.select()} /></Field>}
    {hook === undefined ? <p role="status">Loading webhook...</p> : <form className="k-fieldset" key={`${hook?.route ?? 'new'}:${hook?.revision ?? 0}:${reload}`} onSubmit={save}>
      <Field label="Event name" hint="Leave empty for all events."><Input name="eventName" maxLength={256} readOnly={!!pending} defaultValue={pending?.eventName ?? hook?.event_name ?? ''} /></Field>
      <Field label="Payload filters" hint={<>JSON filter list, example: {'[{"pointer":"/environment","equals":"production"}]'}. All filters must match.</>}><Textarea name="filters" rows={4} readOnly={!!pending} defaultValue={JSON.stringify(pending?.filters ?? hook?.filters ?? [], null, 2)} /></Field>
      {hook && <label className="k-check"><input type="checkbox" name="rotate" disabled={!!pending} defaultChecked={pending?.rotate ?? false} />Rotate secret. The old secret becomes invalid immediately.</label>}
      {pending && <Alert tone="warn" title="Save is not confirmed yet">Try again with the same request.</Alert>}
      <div><Button type="submit" variant="primary" busy={busy} disabled={busy || conflict}>{busy ? 'Saving...' : pending ? 'Retry saving webhook' : hook ? 'Save webhook' : 'Create URL and secret'}</Button></div>
    </form>}
    {error && <Alert tone="error">{error}</Alert>}
    <Section title="Received events">{!events.length ? <EmptyState title="No saved events">Reload to see new events.</EmptyState> : <Card>{events.map(event => <Row key={`${event.delivery}:${event.received}`} title={event.delivery} meta={<><span>{new Date(event.received).toLocaleString('en-US')}</span><Badge>{event.result.outcome === 'queued' ? 'Accepted for execution' : 'Ignored'}</Badge></>}>{event.result.reason && <span className="k-field__hint">{event.result.reason}</span>}</Row>)}</Card>}</Section>
  </div>;
}
type FlowRun = { root_turn: string; created: string; steps: { agent: string; name: string; status: string; task_status: string | null; paused: number | null; thread: string | null; result: string; result_length: number }[] };
function FlowDiagram({ graph, agents }: { graph: FlowGraph; agents: Agent[] }) {
  const marker = useId();
  const depth = new Map<string, number>(), counts = new Map<number, number>(), positions = new Map<string, { x: number; y: number }>();
  for (const node of graph.nodes) {
    const level = Math.max(0, ...graph.links.filter(link => link.to === node).map(link => (depth.get(link.from) ?? 0) + 1));
    depth.set(node, level); positions.set(node, { x: 12 + level * 200, y: 12 + (counts.get(level) ?? 0) * 84 }); counts.set(level, (counts.get(level) ?? 0) + 1);
  }
  const name = (id: string) => agents.find(agent => agent.id === id)?.name ?? id;
  return <div className="bs-root" style={{ overflowX: 'auto', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 14, padding: 8, background: 'var(--color-bg-chrome)' }} tabIndex={0} role="region" aria-label="Flow diagram, scroll to view the full graph"><svg width={Math.max(360, (Math.max(...depth.values()) + 1) * 200)} height={Math.max(...counts.values()) * 84} role="img" aria-label="Agent relationships in flow"><defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-brand)" /></marker></defs>{graph.links.map(link => { const start = positions.get(link.from)!, end = positions.get(link.to)!; return <path key={`${link.from}:${link.to}`} d={`M ${start.x + 160} ${start.y + 26} L ${end.x - 4} ${end.y + 26}`} fill="none" stroke="var(--color-brand)" strokeWidth="2" markerEnd={`url(#${marker})`} />; })}{graph.nodes.map(node => { const pos = positions.get(node)!; return <g key={node} transform={`translate(${pos.x},${pos.y})`}><title>{name(node)}</title><rect width="160" height="52" rx="7" fill="var(--color-bg-pane)" stroke="var(--color-border-primary)" /><text x="12" y="31" fill="var(--color-text-primary)" fontSize="13">{name(node).length > 20 ? `${name(node).slice(0, 18)}...` : name(node)}</text></g>; })}</svg></div>;
}
function FlowEditor({ routine, onBack, onOpen }: { routine: Routine; onBack: () => void; onOpen: (thread: string, owner: string) => Promise<void> }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const optionName = (name: string) => name.length > 24 ? name.slice(0, 21) + '...' : name;
  useEffect(() => { heading.current?.focus(); }, []);
  type Command = { id: string; revision: number; links: FlowLink[] };
  const key = `briefsip:flow:${routine.id}`, path = `/api/routines/${routine.id}/flow`;
  const [pending, setPending] = useState<Command | null>(() => {
    try { const value = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return value && typeof value.id === 'string' && Number.isSafeInteger(value.revision) && Array.isArray(value.links) ? value : null; } catch { return null; }
  });
  const [agents, setAgents] = useState<Agent[]>([]), [links, setLinks] = useState<FlowLink[]>([]), [revision, setRevision] = useState(0);
  const [runs, setRuns] = useState<FlowRun[]>([]), [runError, setRunError] = useState('');
  const [from, setFrom] = useState(routine.agent), [to, setTo] = useState('');
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false), [conflict, setConflict] = useState(false), [reload, setReload] = useState(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    let stopped = false; setLoaded(false);
    void Promise.all([api<{ graph: FlowGraph; revision: number }>(path), api<Directory>('/api/agents')]).then(([flow, directory]) => {
      if (!stopped) { setAgents(directory.agents); setLinks(pending?.links ?? flow.graph.links); setRevision(flow.revision); setLoaded(true); setError(''); setConflict(false); }
    }).catch(error => { if (!stopped) setError(message(error)); });
    return () => { stopped = true; };
  }, [path, reload]);
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const rows = await api<FlowRun[]>(`/api/routines/${routine.id}/flow-runs`); if (!stopped) { setRuns(rows); setRunError(''); } } catch (error) { if (!stopped) setRunError(message(error)); }
      if (!stopped) timer = setTimeout(refresh, 1200);
    }
    void refresh(); return () => { stopped = true; clearTimeout(timer); };
  }, [routine.id]);
  const locked = !loaded || busy || !!pending || conflict;
  let graph: FlowGraph = { root: routine.agent, nodes: [routine.agent], links: [] };
  try { if (loaded) graph = validateFlow(links, routine.agent, new Set(agents.map(agent => agent.id))); } catch { /* Server validates recovered requests; keep the editable edge list visible. */ }
  function change(next: FlowLink[]) {
    if (locked) return;
    try { validateFlow(next, routine.agent, new Set(agents.map(agent => agent.id))); setLinks(next); setError(''); } catch (error) { setError(message(error)); }
  }
  async function save() {
    if (!loaded || busy || conflict) return;
    const request = pending ?? { id: crypto.randomUUID(), revision, links };
    try { sessionStorage.setItem(key, JSON.stringify(request)); } catch { setError('Flow was not saved in the browser. Check site storage.'); return; }
    setPending(request); setBusy(true); setError('');
    try {
      await api(path, request);
      const latest = await api<{ graph: FlowGraph; revision: number }>(path);
      if (!mounted.current) return;
      sessionStorage.removeItem(key); setPending(null); setLinks(latest.graph.links); setRevision(latest.revision);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof HttpError && error.status < 500) { sessionStorage.removeItem(key); setPending(null); setConflict(true); }
      setError(message(error));
    } finally { if (mounted.current) setBusy(false); }
  }
  const name = (id: string) => agents.find(agent => agent.id === id)?.name ?? id;
  return <div className="k-page bs-root">
    <PageHeader headingRef={heading} title={`Flow ${routine.name}`} description="Connect routine results to the next agent. Agents with multiple inputs wait for all of them; branches without successful results are skipped. Changes apply only to new runs."
      actions={<><Button variant="ghost" onClick={onBack}>Back</Button><IconButton label="Reload flow" disabled={busy} onClick={() => setReload(value => value + 1)}><RefreshCw size={15} aria-hidden /></IconButton><Button variant="primary" busy={busy} disabled={!loaded || busy || conflict} onClick={() => void save()}>{busy ? 'Saving...' : pending ? 'Retry saving flow' : 'Save flow'}</Button></>} />
    {!loaded ? <p role="status">Loading flow...</p> : <><FlowDiagram graph={graph} agents={agents} />
      <div className="k-grid-2"><Field label="From agent" hint={name(from)}><Select value={from} disabled={locked} onChange={value => { setFrom(value); if (to === value) setTo(''); }} options={graph.nodes.map(id => ({ value: id, label: optionName(name(id)) }))} /></Field><Field label="To agent" hint={to ? name(to) : 'Not selected'}><Select value={to} disabled={locked} onChange={setTo} options={[{ value: '', label: 'Select agent' }, ...agents.filter(agent => agent.id !== routine.agent && agent.id !== from).map(agent => ({ value: agent.id, label: optionName(agent.name) }))]} /></Field></div>
      <div><Button disabled={locked || !to || to === from} onClick={() => change([...links, { from, to }])}>Connect</Button></div>
      <Card>{links.map(link => <Row key={`${link.from}:${link.to}`} title={`${name(link.from)} to ${name(link.to)}`} trailing={<IconButton label={`Remove relationship ${name(link.from)} to ${name(link.to)}`} disabled={locked} onClick={() => { const remaining = links.filter(item => item !== link), reachable = new Set([routine.agent]); let changed = true; while (changed) { changed = false; for (const edge of remaining) if (reachable.has(edge.from) && !reachable.has(edge.to)) { reachable.add(edge.to); changed = true; } } change(remaining.filter(edge => reachable.has(edge.from))); setFrom(routine.agent); }}><X size={14} aria-hidden /></IconButton>} />)}</Card>
      <p className="k-field__hint">Removing a relationship also removes branches no longer connected to the origin.</p>
    </>}
    {pending && <Alert tone="warn" title="Save is not confirmed yet">Try again with the same request.</Alert>}{error && <Alert tone="error">{error}</Alert>}
    <Section title="Execution steps">{runError && <Alert tone="error">{runError}</Alert>}{!runs.length ? <EmptyState title="No runs with saved flows" /> : runs.map(run => <Section key={run.root_turn} title={new Date(run.created).toLocaleString('en-US')}><Card>{run.steps.map(step => <Row key={step.agent} title={step.name} meta={<Badge>{step.paused ? 'Paused' : step.status === 'waiting' ? 'Waiting for input' : step.status === 'skipped' ? 'Skipped' : statusNames[step.task_status ?? step.status] ?? step.status}</Badge>} trailing={step.thread && <Button size="sm" onClick={() => void onOpen(step.thread!, step.agent).catch(error => setRunError(message(error)))}>Open step {step.name}</Button>}>
      {step.result && <span className="k-field__hint" style={{ whiteSpace: 'pre-wrap' }}>{step.result}{step.result_length > 1000 ? '...' : ''}</span>}
    </Row>)}</Card></Section>)}</Section>
  </div>;
}
function Routines({ agent, onClose, onOpen }: { agent: Agent; onClose: () => void; onOpen: (thread: string, owner: string) => Promise<void> }) {
  const [rows, setRows] = useState<Routine[] | null>(null), [error, setError] = useState('');
  const [webhook, setWebhook] = useState<Routine | null>(null);
  const [flow, setFlow] = useState<Routine | null>(null);
  const [editing, setEditing] = useState<Routine | null | undefined>(() => pendingRoutine(agent.id) ? null : undefined);
  const [selected, setSelected] = useState(''), [runs, setRuns] = useState<RoutineRun[] | null>(null), [runError, setRunError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const data = await api<Routine[]>(`/api/agents/${agent.id}/routines`); if (!stopped) { setRows(data); setError(''); } } catch (error) { if (!stopped) setError(message(error)); }
      if (!stopped) timer = setTimeout(refresh, 1200);
    }
    void refresh(); return () => { stopped = true; clearTimeout(timer); };
  }, [agent.id, reload]);
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout>; setRuns(null); setRunError('');
    async function refresh() {
      try { const data = await api<RoutineRun[]>(`/api/routines/${selected}/runs`); if (!stopped) { setRuns(data); setRunError(''); } } catch (error) { if (!stopped) setRunError(message(error)); }
      if (!stopped) timer = setTimeout(refresh, 1200);
    }
    if (selected) void refresh(); return () => { stopped = true; clearTimeout(timer); };
  }, [selected]);
  if (flow) return <FlowEditor key={flow.id} routine={flow} onBack={() => setFlow(null)} onOpen={onOpen} />;
  if (webhook) return <WebhookSettings key={webhook.id} routine={webhook} onBack={() => setWebhook(null)} />;
  if (editing !== undefined) return <RoutineForm key={`${editing?.id ?? 'new'}:${reload}`} agent={agent} routine={editing} onBack={() => { setEditing(undefined); setReload(value => value + 1); }} />;
  return <div className="k-page bs-root">
    <PageHeader title={`Routines ${agent.name}`} description="Each run has a separate conversation. Briefsip must be running for schedules to be processed."
      actions={<><Button variant="ghost" onClick={onClose}>Back</Button><Button variant="primary" icon={<Plus size={14} aria-hidden />} onClick={() => setEditing(null)}>{pendingRoutine(agent.id) ? 'Resume saving' : 'New routine'}</Button></>} />
    <p className="k-field__hint">Test now runs the saved work through the provider, even when the schedule is inactive. The schedule does not change; provider usage is still counted.</p>
    <ScriptAccess key={agent.id} agent={agent.id} />
    <Section title="Routines" actions={<a className="k-link" href={`/api/agents/${agent.id}/routines/calendar.ics`} download="briefsip-routines.ics">Download calendar</a>}>
      {error && <Alert tone="error">{error} The list will be retried.</Alert>}
      {rows === null ? <><span className="sr-only" role="status">Loading routines...</span><SkeletonRows /></> : !rows.length ? <EmptyState title="No routines yet">Create a schedule for recurring or one-time work.</EmptyState> : <Card>{rows.map(row => <TestRoutine key={row.id} routine={row} actions={[
        { label: `Edit ${row.name}`, onSelect: () => setEditing(row) },
        { label: `Runs: ${row.name}`, onSelect: () => setSelected(row.id) },
        { label: `Flow ${row.name}`, onSelect: () => setFlow(row) },
        ...(row.trigger === 'webhook' ? [{ label: `Webhook settings: ${row.name}`, onSelect: () => setWebhook(row) }] : []),
      ]} />)}</Card>}
    </Section>
    {selected && <Section title="Run history">{runError && <Alert tone="error">{runError}</Alert>}{runs === null ? <><span className="sr-only" role="status">Loading runs...</span><SkeletonRows /></> : !runs.length ? <EmptyState title="No saved runs" /> : <Card>{runs.map(run => <Row key={run.turn} title={<>{run.source === 'webhook' ? 'Webhook · ' : run.source === 'script' ? 'Local script · ' : run.scheduled_at === null ? 'Manual test · ' : ''}{new Date(run.scheduled_at ?? run.created).toLocaleString('en-US')}</>} meta={<Badge>{run.paused ? 'Paused' : run.no_update ? 'No updates' : statusNames[run.status] ?? run.status}</Badge>} trailing={<Button size="sm" onClick={() => void onOpen(run.thread, agent.id).catch(error => setRunError(message(error)))}>Open result</Button>}>{run.missed > 0 && <span className="k-field__hint">{run.missed} missed schedules were combined into this run.</span>}{run.error && <Alert tone="error">{run.error}</Alert>}</Row>)}</Card>}</Section>}
  </div>;
}
function RoutineForm({ agent, routine, onBack }: { agent: Agent; routine: Routine | null; onBack: () => void }) {
  const key = `briefsip:routine-command:${agent.id}`;
  const pending = useRef<RoutineCommand | null>(pendingRoutine(agent.id));
  const [initial] = useState(() => pending.current);
  const routineId = initial?.routineId ?? routine?.id ?? null;
  const revision = initial?.data.revision ?? routine?.revision;
  const [conflict, setConflict] = useState(false);
  const snapshot = initial?.data;
  const [enabled, setEnabled] = useState(snapshot?.enabled ?? (routine ? !!routine.enabled : true));
  const [trigger, setTrigger] = useState<'schedule' | 'webhook'>(snapshot?.trigger ?? routine?.trigger ?? 'schedule');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const date = new Date(snapshot?.nextAt ?? routine?.next_at ?? Date.now() + 60000);
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || conflict) return;
    const fields = new FormData(event.currentTarget);
    const request = pending.current ?? { routineId, data: { id: crypto.randomUUID(), ...(routineId ? { revision } : {}), name: String(fields.get('name')).trim(), prompt: String(fields.get('prompt')).trim(), trigger, nextAt: trigger === 'webhook' ? routine?.next_at ?? Date.now() + 60000 : new Date(String(fields.get('nextAt'))).getTime(), intervalSeconds: fields.get('interval') ? Number(fields.get('interval')) * 60 : null, enabled: fields.get('enabled') === 'on' } };
    try { sessionStorage.setItem(key, JSON.stringify(request)); } catch { setError('Save status was not saved in the browser. Check site storage.'); return; }
    pending.current = request; setBusy(true); setError('');
    try {
      await api(request.routineId ? `/api/routines/${request.routineId}/edit` : `/api/agents/${agent.id}/routines`, request.data);
      if (!mounted.current) return;
      if (pendingRoutine(agent.id)?.data.id === request.data.id) sessionStorage.removeItem(key);
      pending.current = null; onBack();
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof HttpError && error.status < 500) { if (pendingRoutine(agent.id)?.data.id === request.data.id) sessionStorage.removeItem(key); pending.current = null; }
      if (error instanceof HttpError && error.status === 409) setConflict(true);
      setError(message(error));
    } finally { if (mounted.current) setBusy(false); }
  }
  return <div className="k-page bs-root">
    <PageHeader title={initial?.routineId || routine ? 'Edit routine' : 'New routine'} description="Time follows the browser time zone. Disabling or changing a schedule cancels queued runs; runs already in progress continue." actions={<Button variant="ghost" disabled={busy} onClick={onBack}>{error && !pending.current ? 'Discard changes and reload' : 'Back'}</Button>} />
    <form className="k-fieldset" onSubmit={save}>
      <Field label="Name"><Input name="name" required maxLength={80} autoFocus readOnly={!!pending.current} defaultValue={snapshot?.name ?? routine?.name} /></Field>
      <Field label="Work"><Textarea name="prompt" required maxLength={16000} readOnly={!!pending.current} defaultValue={snapshot?.prompt ?? routine?.prompt} rows={5} /></Field>
      <Segmented label="Trigger" value={trigger} disabled={!!pending.current} onChange={setTrigger} options={[{ value: 'schedule', label: 'Schedule' }, { value: 'webhook', label: 'Webhook' }]} />
      {trigger === 'webhook' && <Alert>After saving, open Webhook settings to create a URL and secret. Switching to a schedule removes the old URL and secret.</Alert>}
      <div hidden={trigger === 'webhook'}><Field label="Start time"><Input disabled={trigger === 'webhook'} name="nextAt" type="datetime-local" required readOnly={!!pending.current} defaultValue={localDate} /></Field></div>
      <div hidden={trigger === 'webhook'}><Field label="Repeat every (minutes)" hint="Leave empty for a one-time run."><Input disabled={trigger === 'webhook'} name="interval" type="number" min={1} max={525600} step={1} readOnly={!!pending.current} defaultValue={snapshot ? snapshot.intervalSeconds === null ? '' : snapshot.intervalSeconds / 60 : routine?.interval_ms ? routine.interval_ms / 60000 : ''} /></Field></div>
      <Checkbox checked={enabled} onChange={setEnabled} disabled={!!pending.current} label={trigger === 'webhook' ? 'Webhook active' : 'Schedule active'} />
      <input type="hidden" name="enabled" value="on" disabled={!enabled || !!pending.current} />
      {error && <Alert tone="error">{error}</Alert>}
      <div><Button type="submit" variant="primary" busy={busy} disabled={busy || conflict}>{busy ? 'Saving...' : pending.current ? 'Retry save' : 'Save routine'}</Button></div>
    </form>
  </div>;
}

function AgentConversations({ agent, configured, onEdit, workflowAgents, initialThread, onOpenAgent, onOpenChannel, onThreadOpened }: { onOpenChannel: (channel: string) => void; agent: Agent; workflowAgents: Agent[]; configured: boolean; onEdit: () => void; initialThread?: string; onThreadOpened: () => void; onOpenAgent: (owner: string, thread: string) => void }) {
  const [threads, setThreads] = useState<Thread[]>([]), [error, setError] = useState('');
  const storageKey = `briefsip:thread:${agent.id}`;
  const [selected, setSelected] = useState(() => { if (initialThread) return initialThread; try { return sessionStorage.getItem(storageKey) ?? ''; } catch { return ''; } });
  const [form, setForm] = useState(false), [editing, setEditing] = useState(false), [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const workspaceButton = useRef<HTMLButtonElement>(null);
  const [showRoutines, setShowRoutines] = useState(false);
  const [showWorkflows, setShowWorkflows] = useState(false);
  const loadVersion = useRef(0);
  const navigation = useRef(0);
  const thread = threads.find(item => item.id === selected);
  function select(id: string) { setShowWorkspace(false); setShowRoutines(false); setShowWorkflows(false); navigation.current++; loadVersion.current++; setSelected(id); setForm(false); setEditing(false); try { sessionStorage.setItem(storageKey, id); } catch { /* Selection remains usable in memory. */ } }
  async function load(preferred = selected, afterSave = false) {
    const version = ++loadVersion.current;
    try {
      const rows = await api<Thread[]>(`/api/agents/${agent.id}/threads`);
      if (version !== loadVersion.current) return;
      const missing = !!preferred && !rows.some(row => row.id === preferred);
      setThreads(rows); setLoaded(true); setReload(value => value + 1);
      setError(missing ? 'Conversation is no longer available. Main chat opened.' : '');
      if (missing || afterSave) select(missing ? '' : preferred);
    }
    catch (error) { if (!afterSave && version === loadVersion.current) setError(message(error)); throw new Error(message(error)); }
  }
  useEffect(() => {
    if (initialThread) {
      onThreadOpened();
      try { sessionStorage.setItem(storageKey, initialThread); } catch { /* Selection remains usable in memory. */ }
    }
    void load().catch(() => {});
    return () => { navigation.current++; loadVersion.current++; };
  }, []);
  const navigationVersion = navigation.current;
  const leave = () => { navigation.current++; loadVersion.current++; };
  const openForm = () => { leave(); setShowWorkspace(false); setShowRoutines(false); setShowWorkflows(false); setForm(true); setEditing(false); };
  const openRoutines = () => { leave(); setShowWorkspace(false); setShowRoutines(true); setShowWorkflows(false); };
  const openWorkflows = () => { leave(); setShowWorkspace(false); setShowRoutines(false); setShowWorkflows(true); };
  const openWorkspace = () => { leave(); setShowRoutines(false); setShowWorkflows(false); setForm(false); setEditing(false); setShowWorkspace(true); };
  const errorBanner = error && <p className="error" role="alert">{error} <button className="secondary" onClick={() => void load().catch(() => {})}>Reload conversation</button></p>;
  if (showWorkspace) return <PageView>{errorBanner}<Suspense fallback={<p className="empty" role="status">Loading workspace files...</p>}><WorkspacePanel key={agent.id} agent={agent} request={api} onClose={() => { setShowWorkspace(false); requestAnimationFrame(() => workspaceButton.current?.focus()); }} /></Suspense></PageView>;
  if (showWorkflows) return <PageView wide>{errorBanner}<Suspense fallback={<p className="empty" role="status">Loading workflows...</p>}><WorkflowPanel owner={agent} agents={workflowAgents} request={api} onNavigate={leave} onBack={() => { leave(); setShowWorkflows(false); }} renderConversation={(id, owner) => <WorkflowConversation key={id} agent={workflowAgents.find(item => item.id === owner)} threadId={id} configured={configured} onOpenAgent={onOpenAgent} onOpenChannel={onOpenChannel} />} /></Suspense></PageView>;
  if (showRoutines) return <PageView>{errorBanner}<Routines agent={agent} onClose={() => { leave(); setShowWorkspace(false); setShowRoutines(false); setShowWorkflows(false); }} onOpen={async (id, owner) => { if (owner === agent.id) await load(id, true); else onOpenAgent(owner, id); }} /></PageView>;
  if (!loaded) return <PageView>{errorBanner}<p className="empty" role="status">Loading conversation...</p></PageView>;
  if (form) return <PageView>{errorBanner}<ThreadForm key={editing ? `${thread?.id}:${thread?.revision}:${reload}` : 'new'} agent={agent} thread={editing ? thread : undefined} onCancel={() => { leave(); setForm(false); }} onReload={() => { void load().catch(() => {}); }} onSaved={item => navigationVersion === navigation.current ? load(item.deleted ? '' : item.id, true) : Promise.resolve()} /></PageView>;
  const conversations = <>
    {error && <p className="cfg-error" role="alert">{error} <button type="button" className="link-btn" onClick={() => void load().catch(() => {})}>Reload conversation</button></p>}
    <section aria-label="Agent conversations">
      <div className="section-label section-label--row"><span>Conversation</span><button type="button" className="link-btn link-btn--small" onClick={openForm}>New conversation</button></div>
      <div className="panel-card" role="list">
        <button type="button" role="listitem" className={`panel-row panel-row--link${!thread ? ' is-current' : ''}`} aria-current={!thread || undefined} onClick={() => select('')}><MessageSquare size={16} aria-hidden /><span className="panel-row__title">Main chat</span></button>
        {threads.map(item => <button key={item.id} type="button" role="listitem" className={`panel-row panel-row--link${thread?.id === item.id ? ' is-current' : ''}`} aria-current={thread?.id === item.id || undefined} onClick={() => select(item.id)}><MessageSquare size={16} aria-hidden /><span className="panel-row__text"><span className="panel-row__title">{item.name}</span>{!!item.archived && <span className="panel-row__meta">Archived</span>}</span></button>)}
      </div>
    </section>
    <section aria-label="Agent tools">
      <div className="section-label">Agent</div>
      <div className="panel-card">
        <button type="button" className="panel-row panel-row--action" onClick={openRoutines}><Clock size={16} aria-hidden /> Routines</button>
        <button type="button" className="panel-row panel-row--action" onClick={openWorkflows}><WorkflowIcon size={16} aria-hidden /> Workflows</button>
        <button ref={workspaceButton} type="button" className="panel-row panel-row--action" onClick={openWorkspace}><FolderOpen size={16} aria-hidden /> Workspace files</button>
      </div>
    </section>
  </>;
  return <Chat onOpenChannel={onOpenChannel} onOpenAgent={onOpenAgent} key={thread?.id ?? agent.id} agent={agent} thread={thread} configured={(agent.runtime && agent.runtime !== 'api' ? agent.provider_available === true : configured && agent.provider_available !== false)}
    onEdit={thread ? () => { leave(); setEditing(true); setForm(true); } : onEdit}
    menuItems={[{ label: 'New conversation', onSelect: openForm }, { label: 'Routines', onSelect: openRoutines }, { label: 'Workflows', onSelect: openWorkflows }, { label: 'Workspace files', onSelect: openWorkspace }]}
    detailsExtra={conversations} />;
}

function ThreadForm({ agent, thread, onCancel, onSaved, onReload }: { agent: Agent; thread?: Thread; onCancel: () => void; onSaved: (thread: Thread) => Promise<void>; onReload: () => void }) {
  const [archived, setArchived] = useState(!!thread?.archived), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef<{ path: string; data: { id: string; name?: string; revision?: number; archived?: boolean } } | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = new FormData(event.currentTarget);
    const deleting = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'delete';
    if (deleting && (!thread?.archived || !confirmed)) return;
    const request = pending.current ?? { path: thread ? `/api/threads/${thread.id}/${deleting ? 'delete' : 'edit'}` : `/api/agents/${agent.id}/threads`, data: { id: crypto.randomUUID(), ...(thread ? { revision: thread.revision } : {}), ...(!deleting ? { name: String(form.get('name')).trim(), ...(thread ? { archived } : {}) } : {}) } };
    pending.current = request; setBusy(true); setError('');
    try { await onSaved(await api<Thread>(request.path, request.data)); }
    catch (error) { if (error instanceof HttpError && error.status < 500) pending.current = null; setError(message(error)); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={next => { if (!next && !busy) onCancel(); }} title={thread ? 'Conversation settings' : 'New side thread'} description={`Agent ${agent.name}, with history and a queue separate from the main chat.`}
    footer={<>
      {thread && error && !pending.current && <Button variant="ghost" onClick={onReload}>Reload settings</Button>}
      <Button onClick={onCancel}>Cancel</Button><Button type="submit" form="thread-form" variant="primary" busy={busy} disabled={busy}>{busy ? 'Saving...' : pending.current ? 'Retry changes' : thread ? 'Save conversation' : 'Create conversation'}</Button>
      {!!thread?.archived && <Button type="submit" form="thread-form" variant="danger" value="delete" disabled={busy || !confirmed || !!pending.current} className="k-dialog__foot-start" style={{ order: -1 }}>Delete conversation</Button>}
    </>}>
    <form id="thread-form" className="k-fieldset bs-root" onSubmit={save}>
      <Field label="Conversation name"><Input name="name" required maxLength={80} defaultValue={thread?.name} readOnly={!!pending.current} autoFocus /></Field>
      {thread && <Checkbox checked={archived} disabled={!!pending.current} onChange={setArchived} label="Archive and cancel unfinished work" />}
      {!!thread?.archived && <Checkbox checked={confirmed} disabled={!!pending.current} onChange={setConfirmed} label="I understand that a deleted conversation cannot be reopened" />}
      {error && <Alert tone="error">{error}</Alert>}
    </form>
  </Dialog>;
}

function AgentForm({ model, profile: liveProfile, onCreated, onCancel, onReload, onVisibilityChanged }: { model: string; profile?: Agent; onCreated: (agent: Agent) => void; onCancel: () => void; onReload?: () => Promise<void>; onVisibilityChanged?: () => Promise<void> }) {
  const confirm = useConfirm();
  const [look, setLook] = useState<import('./ui/avatar-shapes').AvatarLook | null>(null);
  const [LookPicker] = useState(() => lazy(() => import('./ui/avatar-shapes').then(module => ({ default: module.AvatarPicker }))));
  const [profile] = useState(liveProfile);
  const creationKey = 'briefsip-agent-creation';
  const nameInput = useRef<HTMLInputElement>(null);
  const [recovery, setRecovery] = useState(() => { try { return { command: liveProfile ? null : restoreAgentCreation(sessionStorage.getItem(creationKey)), invalid: false }; } catch { return { command: null, invalid: true }; } });
  const [invalid, setInvalid] = useState(recovery.invalid);
  const [setup, setSetup] = useState(recovery.command?.setup ?? false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const [runtime, setRuntime] = useState(profile?.runtime ?? 'api');
  const [runtimeChoices, setRuntimeChoices] = useState<{ runtime: 'codex' | 'claude'; enabled: boolean; version: string | null; reason: string | null }[]>([]);
  const [runtimeError, setRuntimeError] = useState('');
  useEffect(() => {
    if (!profile) return;
    let stopped = false;
    void api<{ choices: typeof runtimeChoices }>(`/api/agents/${profile.id}/runtimes`).then(data => { if (!stopped) setRuntimeChoices(data.choices); }).catch(error => { if (!stopped) setRuntimeError(message(error)); });
    return () => { stopped = true; };
  }, [profile]);
  const [account, setAccount] = useState(profile?.provider_account ?? recovery.command?.providerAccount ?? '');
  const [accounts, setAccounts] = useState<{ id: string; name: string; configured: boolean; defaultModel: string }[]>([]);
  const [accountError, setAccountError] = useState('');
  const [accountReload, setAccountReload] = useState(0);
  useEffect(() => {
    let stopped = false; setAccountError('');
    void api<typeof accounts>('/api/provider-accounts').then(items => { if (!stopped) setAccounts(items); }).catch(error => { if (!stopped) setAccountError(message(error)); });
    return () => { stopped = true; };
  }, [accountReload]);
  const [models, setModels] = useState<string[]>([]);
  const [catalogStatus, setCatalogStatus] = useState('Loading model list. Wait for suggestions or enter a model ID.');
  useEffect(() => {
    if (runtime !== 'api') { setModels([]); return; }
    let stopped = false;
    setModels([]); setCatalogStatus('Loading model list. Wait for suggestions or enter a model ID.');
    void api<{ models: string[] }>(`/api/models?account=${encodeURIComponent(account)}`).then(data => {
      if (!stopped) { setModels(data.models); setCatalogStatus(data.models.length ? `${data.models.length} models available. Select a suggestion or enter a model ID.` : 'Provider has not listed any models. Enter a model ID available in your account.'); }
    }).catch(error => { if (!stopped) setCatalogStatus(`${message(error)} Model ID can still be entered manually.`); });
    return () => { stopped = true; };
  }, [account, accountReload, runtime]);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [modelValue, setModelValue] = useState(profile?.model ?? recovery.command?.model ?? model);
  const [backupValue, setBackupValue] = useState(profile?.backup_model ?? recovery.command?.backupModel ?? '');
  const pending = useRef<(AgentCreation & { revision?: number }) | null>(recovery.command);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || invalid) return;
    const form = new FormData(event.currentTarget);
    const data = pending.current ?? { id: crypto.randomUUID(), ...(profile ? { revision: profile.revision } : setup ? { setup: true } : {}), providerAccount: account, name: String(form.get('name')).trim() || (setup ? 'New agent' : ''), model: String(form.get('model')).trim(), backupModel: String(form.get('backupModel')).trim(), instructions: String(form.get('instructions')).trim(), threadLimit: Number(form.get('threadLimit')) };
    if (profile && runtime !== (profile.runtime ?? 'api') && !pending.current) {
      if (!await confirm({ title: 'Change agent runtime?', description: 'Future turns use the selected runtime and its host login. Existing history remains in Briefsip; the new runtime starts a fresh conversation. Workspace edits can persist after a turn stops.', confirm: 'Change runtime' })) return;
      Object.assign(data, { runtime, confirmRuntime: true });
    }
    setBusy(true); setError('');
    function clearRecovery() { if (!profile && restoreAgentCreation(sessionStorage.getItem(creationKey))?.id === data.id) sessionStorage.removeItem(creationKey); }
    try {
      if (!profile) { restoreAgentCreation(JSON.stringify(data)); sessionStorage.setItem(creationKey, JSON.stringify(data)); }
      pending.current = data;
      const created = await api<Agent>(profile ? `/api/agents/${profile.id}/edit` : '/api/agents', data);
      clearRecovery();
      if (!profile && look) {
        const { avatarPng, notifyAvatarFailure } = await import('./ui/avatar-shapes');
        try {
          const key = `briefsip-avatar:${created.id}`;
          const command = { id: crypto.randomUUID(), revision: created.avatar_revision ?? 0, image: await avatarPng(look) };
          sessionStorage.setItem(key, JSON.stringify(command));
          const result = await api<{ revision: number }>(`/api/agents/${created.id}/avatar`, command);
          created.avatar_revision = result.revision;
          sessionStorage.removeItem(key);
        } catch { notifyAvatarFailure(); }
      }
      if (active.current) onCreated(created);
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) { try { clearRecovery(); pending.current = null; } catch { /* Keep exact retry if recovery storage cannot be cleared. */ } }
      if (active.current) setError(message(error));
    } finally { if (active.current) setBusy(false); }

  }
  const locked = !!pending.current;
  const discardInvalid = async () => {
    if (!await confirm({ title: 'Discard recovery data?', description: 'The agent may already have been created; check the agent list before discarding it.', confirm: 'Discard', danger: true })) return;
    try { sessionStorage.removeItem(creationKey); setInvalid(false); nameInput.current?.focus(); } catch { setError('Recovery storage could not be cleared.'); }
  };
  const discardPending = async () => {
    if (!await confirm({ title: 'Discard this request?', description: 'The agent may already have been created; check the agent list before creating a new one.', confirm: 'Discard recovery', danger: true })) return;
    try { sessionStorage.removeItem(creationKey); pending.current = null; setRecovery({ command: null, invalid: false }); setError(''); nameInput.current?.focus(); } catch { setError('Recovery storage could not be cleared.'); }
  };
  const accountOptions: SelectOption[] = [
    ...(!accounts.some(item => item.id === '') ? [{ value: '', label: 'Server default' }] : []),
    ...(account && !accounts.some(item => item.id === account) ? [{ value: account, label: 'Account unavailable' }] : []),
    ...accounts.map(item => ({ value: item.id, label: item.name.slice(0, 40), hint: item.configured ? undefined : 'Not connected' })),
  ];
  const submitLabel = profile ? 'Save profile' : pending.current ? 'Retry creation' : setup ? 'Create and draft' : 'Create agent';
  return <Dialog open size={profile ? 'lg' : 'md'} onOpenChange={next => { if (!next && !busy) onCancel(); }}
    title={profile ? 'Edit agent profile' : 'New agent'}
    description={profile ? undefined : 'Name it, choose a model, then explain how it should work.'}
    footer={<>
      {!profile && pending.current && <Button variant="ghost" disabled={busy} onClick={() => void discardPending()} className="k-dialog__foot-start">Discard recovery</Button>}
      {profile && error && onReload && <Button variant="ghost" onClick={onReload} className="k-dialog__foot-start">Discard changes and reload</Button>}
      <Button disabled={busy} onClick={onCancel}>Cancel</Button>
      <Button type="submit" form="agent-form" variant="primary" busy={busy} disabled={invalid}>{busy ? 'Saving...' : submitLabel}</Button>
    </>}>
    {invalid && <Alert tone="error" title="Recovery data could not be read" actions={<Button size="sm" onClick={() => void discardInvalid()}>Discard recovery data</Button>}>Check the agent list before discarding it.</Alert>}
    {!profile && pending.current && <Alert tone="warn" title="Creation is not confirmed yet">Try again with the same request to avoid creating a duplicate agent.</Alert>}
    {profile && onVisibilityChanged && <div className="legacy k-legacy-block agent-form__avatar"><AvatarEditor agent={profile.id} request={api} onChanged={onVisibilityChanged} /></div>}
    <form id="agent-form" className="k-fieldset" onSubmit={create}>
      {!profile && <Suspense fallback={<p role="status">Loading avatar picker...</p>}><LookPicker value={look} onChange={setLook} disabled={busy || locked || invalid} /></Suspense>}
      {!profile && <Segmented label="How to create an agent" value={setup ? 'describe' : 'manual'} disabled={busy || locked || invalid} onChange={value => setSetup(value === 'describe')} options={[
        { value: 'manual', label: 'Fill in yourself', description: 'Enter the name and instructions.' },
        { value: 'describe', label: 'Draft from a description', description: 'The agent drafts its profile through chat.' },
      ]} />}
      <Field label={!profile && setup ? 'Temporary name' : 'Name'} optional={!profile && setup}>
        <Input ref={nameInput} name="name" required={!setup} maxLength={80} readOnly={locked} defaultValue={profile?.name ?? recovery.command?.name} placeholder="For example: Research partner" />
      </Field>
      <Field label="Runtime" hint={profile ? 'Coding runtimes use the host login and connected workspace. Steering and image attachments are unavailable.' : 'Create the agent, then connect its host workspace to enable coding runtimes.'} error={runtimeError}>
        <Select label="Runtime" value={runtime} onChange={value => setRuntime(value as typeof runtime)} disabled={locked || busy} options={[{ value: 'api', label: 'API model' }, ...(['codex','claude'] as const).map(value => { const choice = runtimeChoices.find(item => item.runtime === value); return { value, label: value === 'codex' ? 'Codex' : 'Claude Code', disabled: !choice?.enabled, hint: choice?.reason ?? choice?.version ?? 'Connect a host workspace folder first.' }; })]} />
      </Field>
      <div className="k-grid-2">
        <Field label="Provider account" hint={accountError ? undefined : 'API keys stay on the server.'} error={accountError && <>{accountError} <button type="button" className="k-link" onClick={() => setAccountReload(value => value + 1)}>Reload</button></>}>
          <Select value={account} onChange={setAccount} disabled={locked || runtime !== 'api'} options={accountOptions} />
        </Field>
        <Field label="Model" hint={runtime === 'api' ? catalogStatus : 'Saved API model. Coding runtimes use their host default model.'}>
          <Combobox name="model" value={modelValue} onChange={setModelValue} suggestions={models} required maxLength={160} readOnly={locked || runtime !== 'api'} placeholder="Model ID from provider" />
        </Field>
      </div>
      <Field label={!profile && setup ? 'Needs description' : 'Instructions'} hint={!profile && setup ? 'Uses the selected provider. The agent and drafting task are created together; results or questions appear in chat.' : undefined}>
        <Textarea name="instructions" required maxLength={8000} readOnly={locked} defaultValue={profile?.instructions ?? recovery.command?.instructions} rows={5} placeholder={!profile && setup ? 'Describe the work this agent should help with.' : 'What should this agent do? How should it present results?'} />
      </Field>
      <Collapsible title="Advanced settings" defaultOpen={!!(profile?.backup_model || recovery.command?.backupModel)}>
        <div className="k-grid-2">
          <Field label="Fallback model" optional hint={runtime === 'api' ? 'Tried once if the main model rejects because of quota or is unavailable.' : 'API model fallback stays saved; coding runtimes do not use it.'}>
            <Combobox name="backupModel" value={backupValue} onChange={setBackupValue} suggestions={models} maxLength={160} readOnly={locked || runtime !== 'api'} placeholder="Leave empty to disable" />
          </Field>
          <Field label="Concurrent side threads" hint="Main chat has its own queue.">
            <Input name="threadLimit" type="number" min={1} max={32} step={1} required readOnly={locked} defaultValue={profile?.thread_limit ?? recovery.command?.threadLimit ?? 2} />
          </Field>
        </div>
      </Collapsible>
      {error && <Alert tone="error">{error}</Alert>}
    </form>
    {profile && <div className="legacy k-legacy-block">
      <AgentComputerSettings agent={profile.id} request={api} />
      {onVisibilityChanged && <AgentVisibility agent={liveProfile!} request={api} onChanged={onVisibilityChanged} />}
      <Suspense fallback={<p role="status">Loading local sites...</p>}><SitesPanel key={`sites:${profile.id}`} agent={profile.id} request={api} /></Suspense>
      <Suspense fallback={<p className="empty" role="status">Loading agent export...</p>}><AgentTemplateExport key={profile.id} id={profile.id} request={api} /></Suspense>
    </div>}
  </Dialog>;
}

function ChannelForm({ agents, channel, onCreated, onCancel, onReload }: { agents: Agent[]; channel?: Channel; onCreated: (channel: Channel) => void; onCancel: () => void; onReload?: () => void }) {
  const confirm = useConfirm();
  const storageKey = `briefsip:channel-command:${channel?.id ?? 'new'}`;
  const [recovery] = useState(() => {
    try { return { command: restoreChannelCommand(sessionStorage.getItem(storageKey), !!channel), blocked: false }; }
    catch { return { command: null, blocked: true }; }
  });
  const [pending, setPending] = useState<ChannelCommand | null>(recovery.command), [blocked, setBlocked] = useState(recovery.blocked);
  const [name, setName] = useState(pending?.name ?? channel?.name ?? ''), [instructions, setInstructions] = useState(pending?.instructions ?? channel?.instructions ?? '');
  const [members, setMembers] = useState<string[]>(pending?.members ?? channel?.members ?? []), [lead, setLead] = useState(pending ? pending.lead ?? '' : channel?.lead ?? '');
  const [archived, setArchived] = useState(pending?.archived ?? !!channel?.archived);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const mounted = useRef(true), sending = useRef(false), nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const locked = busy || !!pending || blocked;
  async function discard() {
    if (!await confirm({ title: 'Discard channel recovery data?', description: 'Changes may already be saved. Check the list and channel settings before creating a new request.', confirm: 'Discard', danger: true })) return;
    try { sessionStorage.removeItem(storageKey); setPending(null); setBlocked(false); setError(''); nameInput.current?.focus(); }
    catch { setError('Recovery data could not be deleted. Check site storage.'); }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (sending.current || blocked) return;
    const data = pending ?? { id: crypto.randomUUID(), ...(channel ? { revision: channel.revision, archived } : {}), name: name.trim(), instructions: instructions.trim(), members, lead: lead || null };
    try { sessionStorage.setItem(storageKey, JSON.stringify(data)); }
    catch { setError('Channel request was not saved in the browser. Check site storage before trying again.'); return; }
    sending.current = true; setPending(data); setBusy(true); setError('');
    try {
      const saved = await api<Channel>(channel ? `/api/channels/${channel.id}/edit` : '/api/channels', data);
      if (!mounted.current) return;
      sessionStorage.removeItem(storageKey); setPending(null); onCreated(saved);
    }
    catch (error) {
      if (!mounted.current) return;
      if (error instanceof HttpError && error.status < 500) {
        try { sessionStorage.removeItem(storageKey); setPending(null); }
        catch { setBlocked(true); }
      }
      setError(message(error));
    }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  return <Dialog open onOpenChange={next => { if (!next && !busy) onCancel(); }} title={channel ? 'Channel settings' : 'New channel'} description="Bring agents into one conversation. Choose who coordinates the work."
    footer={<>
      {channel && <Button variant="ghost" className="k-dialog__foot-start" disabled={locked} onClick={async () => {
        if (!await confirm({ title: archived ? 'Restore channel?' : 'Archive channel?', description: archived ? 'Save changes to restore this channel.' : 'Archive channel and cancel unfinished work when you save changes.', confirm: archived ? 'Restore' : 'Archive', danger: !archived })) return;
        setArchived(!archived);
      }}>{archived ? 'Restore channel' : 'Archive channel'}</Button>}
      {(pending || blocked) && <Button variant="ghost" disabled={busy} onClick={() => void discard()}>Discard channel recovery</Button>}
      {channel && error && !pending && !blocked && onReload && <Button variant="ghost" onClick={onReload}>Discard changes and reload</Button>}
      <Button onClick={onCancel}>Cancel</Button><Button type="submit" form="channel-form" variant="primary" busy={busy} disabled={busy || blocked || !members.length}>{busy ? 'Saving...' : pending ? 'Retry saving channel' : channel ? 'Save channel' : 'Create channel'}</Button>
    </>}>
    {blocked && <Alert tone="error" title="Channel recovery data could not be read">Check the list and channel settings before discarding recovery.</Alert>}
    {pending && <Alert tone="warn" title="Request result is not confirmed yet">Try the same request to check the result without creating a duplicate channel.</Alert>}
    <form id="channel-form" className="k-fieldset bs-root" onSubmit={create}>
      <Field label="Channel name"><Input ref={nameInput} name="name" required maxLength={80} readOnly={locked} value={name} onChange={event => setName(event.target.value)} autoFocus /></Field>
      <Field label="Purpose"><Textarea name="instructions" required maxLength={8000} rows={3} readOnly={locked} value={instructions} onChange={event => setInstructions(event.target.value)} /></Field>
      <fieldset disabled={locked} className="k-fieldset"><legend className="k-field__label">Members</legend>{agents.map(agent => <Checkbox key={agent.id} label={agent.name} disabled={locked} checked={members.includes(agent.id)} onChange={checked => { setMembers(checked ? [...members, agent.id] : members.filter(id => id !== agent.id)); if (!checked && lead === agent.id) setLead(''); }} />)}</fieldset>
      <Field label="Lead"><Select value={lead} disabled={locked} onChange={setLead} options={[{ value: '', label: 'No lead; select a recipient when sending' }, ...agents.filter(agent => members.includes(agent.id)).map(agent => ({ value: agent.id, label: agent.name }))]} /></Field>
      {channel && archived !== !!channel.archived && <Alert>{archived ? 'Channel will be archived and unfinished work cancelled when you save changes.' : 'Channel will be restored when you save changes.'}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
    </form>
  </Dialog>;
}

function FlowDirectory({ agents, onClose, onOpen }: { agents: Agent[]; onClose: () => void; onOpen: (owner: string, thread: string) => void }) {
  type Entry = Routine & { owner_name: string; graph: FlowGraph; flow_revision: number };
  const [page, setPage] = useState<{ flows: Entry[]; next_after: string | null } | null>(null);
  const [cursors, setCursors] = useState(['']), [refresh, setRefresh] = useState(0), [error, setError] = useState('');
  const [editing, setEditing] = useState<Entry | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const after = cursors[cursors.length - 1];
  useEffect(() => {
    let stopped = false; setPage(null); setError('');
    void api<{ flows: Entry[]; next_after: string | null }>(`/api/flows${after ? `?after=${after}` : ''}`).then(data => {
      if (!stopped) { setPage(data); heading.current?.focus(); }
    }).catch(error => { if (!stopped) setError(message(error)); });
    return () => { stopped = true; };
  }, [after, refresh]);
  if (editing) return <FlowEditor routine={editing} onBack={() => { setEditing(null); setRefresh(value => value + 1); }} onOpen={async (thread, owner) => onOpen(owner, thread)} />;
  const name = (id: string) => agents.find(agent => agent.id === id)?.name ?? id;
  return <div className="k-page bs-root">
    <PageHeader headingRef={heading} title="Agent flows" description="Relationships saved from all routines. Each diagram runs independently; relationships from different routines are not combined during execution." actions={<><Button variant="ghost" onClick={onClose}>Back</Button><IconButton label="Reload flow list" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden /></IconButton></>} />
    {error ? <Alert tone="error">{error}</Alert> : !page ? <><span className="sr-only" role="status">Loading flow list...</span><SkeletonRows /></> : !page.flows.length ? <EmptyState title="No flows on this page">Open Routines for an agent, then save its flow.</EmptyState> : page.flows.map(row => <Card key={row.id}><div className="k-stack" style={{ padding: 14 }}>
      <Row title={row.name} meta={<><span>{row.owner_name}</span><Badge>{row.trigger === 'webhook' ? 'Webhook' : 'Schedule'}</Badge><Badge>{row.enabled ? 'Active' : 'Inactive'}</Badge></>} trailing={<Button size="sm" onClick={() => setEditing(row)}>Edit flow {row.name}</Button>} />
      <FlowDiagram graph={row.graph} agents={agents} />
      {row.graph.links.length ? <ul className="k-field__hint">{row.graph.links.map(link => <li key={`${link.from}:${link.to}`}>{name(link.from)} to {name(link.to)}</li>)}</ul> : <p className="k-field__hint">No relationships to other agents.</p>}
    </div></Card>)}
    {(cursors.length > 1 || !!page?.next_after) && <div className="k-pager"><IconButton label="Previous flows" disabled={cursors.length < 2} onClick={() => setCursors(values => values.slice(0, -1))}><ChevronLeft size={16} aria-hidden /></IconButton><IconButton label="Next flows" disabled={!page?.next_after} onClick={() => { if (page?.next_after) setCursors(values => [...values, page.next_after!]); }}><ChevronRight size={16} aria-hidden /></IconButton></div>}
  </div>;
}

type SettingsSection = 'updates' | 'machines' | 'connected-apps' | 'skills' | 'mcp' | 'mcp-server' | 'data' | 'usage' | 'backup' | 'import' | 'sections' | 'appearance';
const settingsSections: { id: SettingsSection; label: string }[] = [
  { id: 'skills', label: 'Skills' },
  { id: 'connected-apps', label: 'Connected apps' },
  { id: 'mcp', label: 'MCP connections' },
  { id: 'machines', label: 'Machines' },
  { id: 'updates', label: 'Updates' },
  { id: 'mcp-server', label: 'MCP server' },
  { id: 'data', label: 'Shared data' },
  { id: 'usage', label: 'Usage' },
  { id: 'import', label: 'Import agent' },
  { id: 'backup', label: 'Backup' },
  { id: 'sections', label: 'Agent sections' },
  { id: 'appearance', label: 'Appearance' },
];
type Dialog = 'agent' | 'channel' | 'edit' | null;
const collapsedKey = 'briefsip:sidebar-collapsed';

function App() {
  const [directory, setDirectory] = useState<Directory | null>(null); const [selected, setSelected] = useState('');
  const [channels, setChannels] = useState<Channel[]>([]), [selectedChannel, setSelectedChannel] = useState('');
  const [view, setView] = useState<'chat' | 'flows' | 'workflows' | 'remote'>('chat');
  const remoteMachines = useMachines(api);
  const updateAvailable = useUpdateBadge(api);
  const [remoteSelection, setRemoteSelection] = useState<{ machine: string; agent: string } | null>(null);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [newMenu, setNewMenu] = useState(false);
  const [collapsed, setCollapsedState] = useState(() => { try { return localStorage.getItem(collapsedKey) === '1'; } catch { return false; } });
  const sidebar = useResizablePanel(sidebarPanel);
  const [openedThread, setOpenedThread] = useState<{ agent: string; thread: string } | null>(null);
  const [activityError, setActivityError] = useState(false);
  const [editReload, setEditReload] = useState(0);
  const [error, setError] = useState('');
  const directoryRequest = useRef(0);
  function setCollapsed(value: boolean) { setCollapsedState(value); try { localStorage.setItem(collapsedKey, value ? '1' : '0'); } catch { /* Applies to this page only. */ } }
  async function load(propagate = false) {
    const version = ++directoryRequest.current;
    try { const [data, rooms] = await Promise.all([api<Directory>('/api/agents'), api<Channel[]>('/api/channels')]); if (version !== directoryRequest.current) return; directoryRequest.current++; setDirectory(data); setChannels(rooms); setSelected(id => id || data.agents[0]?.id || ''); setError(''); }
    catch (error) { if (version === directoryRequest.current) setError(message(error)); if (propagate) throw error; }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refreshActivity() {
      try {
        const version = directoryRequest.current;
        const [rooms, agents] = await Promise.all([api<Channel[]>('/api/channels'), api<Directory>('/api/agents')]);
        if (!stopped && version === directoryRequest.current) setDirectory(current => current && ({ ...current, agents: current.agents.map(agent => { const fresh = agents.agents.find(item => item.id === agent.id); return fresh && fresh.revision >= agent.revision ? fresh : agent; }) }));
        if (!stopped) { setActivityError(false); setChannels(current => current.map(room => {
          const fresh = rooms.find(item => item.id === room.id);
          return fresh ? { ...room, activity: Math.max(room.activity, fresh.activity), read_position: Math.max(room.read_position, fresh.read_position) } : room;
        })); }
      } catch { if (!stopped) setActivityError(true); }
      if (!stopped) timer = setTimeout(refreshActivity, 2400);
    }
    timer = setTimeout(refreshActivity, 2400);
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const name = event.key.toLowerCase();
      if (name === 'b') { event.preventDefault(); setCollapsedState(value => { try { localStorage.setItem(collapsedKey, value ? '0' : '1'); } catch { /* Applies to this page only. */ } return !value; }); }
      else if (name === ',') { event.preventDefault(); setSettings(current => current ?? 'skills'); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  async function markRead(room: Channel) {
    const updated = await api<Channel>(`/api/channels/${room.id}/read`, { id: crypto.randomUUID(), position: room.activity });
    setChannels(current => current.map(item => item.id === room.id ? { ...item, activity: Math.max(item.activity, updated.activity), read_position: Math.max(item.read_position, updated.read_position) } : item));
  }
  const agent = directory?.agents.find(agent => agent.id === selected);
  const channel = channels.find(channel => channel.id === selectedChannel);
  const openAgent = (id: string) => { setView('chat'); setOpenedThread(null); setSelected(id); setSelectedChannel(''); setDialog(null); };
  const openChannel = (id: string) => { setView('chat'); setSelectedChannel(id); setDialog(null); };
  const openThread = (owner: string, thread: string) => { if(owner.includes('@')){const [agent,machine]=owner.split('@');setRemoteSelection({machine,agent});setView('remote');setDialog(null);setSettings(null);return;} setOpenedThread({ agent: owner, thread }); setSelected(owner); setSelectedChannel(''); setView('chat'); setDialog(null); setSettings(null); };
  const agentRow = (id: string) => {
    const item = directory?.agents.find(agent => agent.id === id);
    if (!item) return null;
    const current = view === 'chat' && !selectedChannel && item.id === selected;
    return collapsed
      ? <button key={item.id} type="button" className={`bot-rail-item${current ? ' is-selected' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => openAgent(item.id)} title={item.name} aria-label={item.name}><AgentAvatar agent={item} size={36} /></button>
      : <button key={item.id} type="button" className={`bot-row${current ? ' is-selected' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => openAgent(item.id)}>
        <span className="bot-row__avatar"><AgentAvatar agent={item} size={36} />{item.computer_waiting && <span className="status-dot is-attention" aria-label="Waiting for you" />}{item.provider_available === false && <span className="status-dot is-attention" aria-label="Provider account unavailable" />}</span>
        <span className="bot-row__text"><span className="bot-row__name">{item.name}{item.computer_waiting && <small> · Waiting for you</small>}</span><span className="bot-row__preview">{item.hidden ? 'Hidden' : item.runtime && item.runtime !== 'api' ? `${item.runtime === 'codex' ? 'Codex' : 'Claude Code'} runtime` : item.model || 'Model not selected'}</span></span>
      </button>;
  };
  let content: ReactNode;
  if (error) content = <PageView><div className="empty"><h1>Workspace is not open</h1><p role="alert">{error}</p><button onClick={() => void load()}>Try again</button></div></PageView>;
  else if (!directory) content = <main className="chat chat--empty bs-root"><p className="empty-chat__sub" role="status">Loading workspace...</p></main>;
  else if (view === 'remote') { const machine = remoteMachines.machines.find(item => item.id === remoteSelection?.machine); content = <main className="chat bs-root remote-agent-page"><RemoteAgentDetail key={`${machine?.id}:${remoteSelection?.agent}`} request={api} machine={machine} agent={machine?.agents.find(item => item.id === remoteSelection?.agent)} onBack={() => setView('chat')} /></main>; }
  else if (view === 'workflows') content = <PageView wide><Suspense fallback={<p className="empty" role="status">Loading workflow directory...</p>}><WorkflowDirectory agents={directory.agents} request={api} onClose={() => setView('chat')} renderConversation={(id, owner) => <WorkflowConversation key={id} agent={directory.agents.find(item => item.id === owner)} threadId={id} configured={directory.configured} onOpenAgent={openThread} onOpenChannel={openChannel} />} /></Suspense></PageView>;
  else if (view === 'flows') content = <PageView wide><FlowDirectory agents={directory.agents} onClose={() => setView('chat')} onOpen={openThread} /></PageView>;
  else if (channel) content = <Chat onOpenAgent={openThread} key={`channel:${channel.id}`} agent={channel} channel={{ ...channel, lead: directory.agents.find(agent => agent.id === channel.lead)?.hidden ? null : channel.lead }} onRead={() => markRead(channel)} members={directory.agents.filter(agent => channel.members.includes(agent.id) && !agent.hidden)} onEdit={() => setDialog('edit')} configured={directory.configured} />;
  else if (agent) content = <AgentConversations onOpenChannel={openChannel} key={agent.id} agent={agent} workflowAgents={directory.agents} configured={directory.configured} initialThread={openedThread?.agent === agent.id ? openedThread.thread : undefined} onThreadOpened={() => setOpenedThread(null)} onOpenAgent={openThread} onEdit={() => setDialog('edit')} />;
  else content = <main className="chat chat--empty bs-root"><div className="empty-chat"><div className="empty-chat__title">Create your first agent</div><div className="empty-chat__sub">Name it, choose a model, then explain how it should work. The agent and its history are saved on this computer.</div><button type="button" className="btn btn--primary" onClick={() => setDialog('agent')}><Plus size={16} aria-hidden /> New agent</button></div></main>;
  const created = (item: Agent) => { setDirectory(current => current && { ...current, agents: [...current.agents.filter(agent => agent.id !== item.id), item] }); openAgent(item.id); };
  return <RadixDialog.Root modal open={!!settings} onOpenChange={open => setSettings(current => open ? current ?? 'skills' : null)}><div className={`app bs-root${collapsed ? ' is-sidebar-collapsed' : ''}`}>
    {collapsed && <button type="button" className="icon-btn icon-btn--bordered sidebar-reveal" onClick={() => setCollapsed(false)} aria-label="Expand sidebar" title="Sidebar (Ctrl/Cmd+B)"><PanelLeft size={16} aria-hidden /></button>}
    {!collapsed && <aside className="sidebar" style={{ width: `${sidebar.width}px` }} aria-label="Workspace navigation">
      <div className="sidebar__titlebar">
        {!collapsed && <a className="sidebar__brand" href="/">Briefsip</a>}
        <div className="sidebar__controls">
          <button type="button" className="icon-btn icon-btn--plain" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title="Sidebar (Ctrl/Cmd+B)"><PanelLeft size={16} aria-hidden /></button>
          {!collapsed && <span className="sidebar__new">
            <button type="button" className="icon-btn" onClick={() => setNewMenu(!newMenu)} aria-label="Create new" aria-haspopup="menu" aria-expanded={newMenu} title="Create new"><Plus size={16} aria-hidden /></button>
            {newMenu && <Menu align="right" label="Create new" onClose={() => setNewMenu(false)} items={[
              { label: 'New agent', onSelect: () => setDialog('agent') },
              { label: 'New channel', onSelect: () => setDialog('channel'), disabled: !directory?.agents.length },
              { label: 'Import agent', onSelect: () => setSettings('import'), disabled: !directory },
            ]} />}
          </span>}
        </div>
      </div>
      <div className="sidebar__scroll">
        <nav className="islands" aria-label="Automation">
          <button type="button" className={`island${view === 'flows' ? ' is-selected' : ''}`} aria-current={view === 'flows' ? 'page' : undefined} disabled={!directory} onClick={() => { setView('flows'); setDialog(null); }} title="Agent flows"><Route size={16} aria-hidden />{!collapsed && <span>Agent flows</span>}</button>
          <button type="button" className={`island${view === 'workflows' ? ' is-selected' : ''}`} aria-current={view === 'workflows' ? 'page' : undefined} disabled={!directory} onClick={() => { setView('workflows'); setDialog(null); }} title="Workflows"><WorkflowIcon size={16} aria-hidden />{!collapsed && <span>Workflows</span>}</button>
        </nav>
        {!collapsed && <div className="sidebar__label">Channels</div>}
        <nav className="bot-list" aria-label="Select channel">
          {channels.map(room => {
            const current = view === 'chat' && room.id === selectedChannel;
            const unread = room.activity > room.read_position;
            return collapsed
              ? <button key={room.id} type="button" className={`bot-rail-item${current ? ' is-selected' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => openChannel(room.id)} title={room.name} aria-label={room.name}><AgentAvatar agent={room} size={36} /></button>
              : <button key={room.id} type="button" className={`bot-row${current ? ' is-selected' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => openChannel(room.id)}>
                <span className="bot-row__avatar"><AgentAvatar agent={room} size={36} />{unread && <span className="status-dot is-unread" aria-label="Unread" />}</span>
                <span className="bot-row__text"><span className="bot-row__name">{room.name}</span><span className="bot-row__preview">{room.archived ? 'Archived' : `${room.members.length} members`}{unread ? ' · Unread' : ''}</span></span>
              </button>;
          })}
          {!collapsed && !channels.length && <button type="button" className="bot-list__empty" disabled={!directory?.agents.length} onClick={() => setDialog('channel')}><span className="bot-list__empty-plus"><Hash size={14} aria-hidden /></span><span><span className="bot-row__name">New channel</span><span className="bot-row__preview">Bring several agents into one space</span></span></button>}
        </nav>
        {!collapsed && <div className="sidebar__label">Agents</div>}
        <div className="bot-list sidebar-agents">
          <AgentSidebar mode="list" agents={directory?.agents ?? []} request={api} renderAgent={agentRow} />
          {!collapsed && directory && !directory.agents.length && <button type="button" className="bot-list__empty" onClick={() => setDialog('agent')}><span className="bot-list__empty-plus"><Plus size={14} aria-hidden /></span><span><span className="bot-row__name">New agent</span><span className="bot-row__preview">Assign a task, such as research or a summary</span></span></button>}
        </div>
        <MachinesSidebar machines={remoteMachines.machines} error={remoteMachines.error} selected={view === 'remote' ? remoteSelection : null} onSettings={() => setSettings('machines')} onOpen={(machine, agent) => { setRemoteSelection({ machine: machine.id, agent: agent.id }); setView('remote'); setDialog(null); }} />
      </div>
      <div className="sidebar__footer">
        <div className="sidebar__fade" />
        {!collapsed && <div className="provider-status" role="status"><i className={directory?.configured ? 'is-on' : ''} aria-hidden /><span>{activityError ? 'Status not updated. Trying again.' : directory?.configured ? 'Provider configured' : 'Provider not connected'}</span></div>}
        {updateAvailable && <button type="button" className="update-available-badge" onClick={() => setSettings('updates')}>Update available</button>}
        <RadixDialog.Trigger asChild><button type="button" className="icon-btn icon-btn--bordered" aria-label="Settings" title="Settings (Ctrl/Cmd+,)"><Settings size={16} aria-hidden /></button></RadixDialog.Trigger>
      </div>
      <PanelResizeHandle panel={sidebar} />
    </aside>}
    {content}
    {dialog === 'agent' && directory && <AgentForm model={directory.defaultModel} onCancel={() => setDialog(null)} onCreated={item => { created(item); setDialog(null); }} />}
    {dialog === 'channel' && directory && <ChannelForm agents={directory.agents} onCancel={() => setDialog(null)} onCreated={item => { setChannels(current => [...current.filter(room => room.id !== item.id), item]); openChannel(item.id); }} />}
    {dialog === 'edit' && directory && channel && <ChannelForm key={`${channel.id}:${channel.revision}:${editReload}`} agents={directory.agents} channel={channel} onCancel={() => setDialog(null)} onReload={() => { void load().then(() => setEditReload(value => value + 1)); }} onCreated={() => { void load(); setDialog(null); }} />}
    {dialog === 'edit' && directory && !channel && agent && <AgentForm key={`${agent.id}:${editReload}`} model={directory.defaultModel} profile={agent} onCancel={() => setDialog(null)} onVisibilityChanged={() => load(true)} onReload={() => load(true).then(() => setEditReload(value => value + 1))} onCreated={() => { void load(); setDialog(null); }} />}
    <RadixDialog.Portal><RadixDialog.Content className="app-settings bs-root" aria-describedby={undefined} onOpenAutoFocus={event => {
      event.preventDefault();
      const page = (event.currentTarget as HTMLElement).querySelector<HTMLElement>('.app-settings__page');
      (page?.querySelector<HTMLElement>('h1[tabindex], button:not(:disabled), input:not([type="hidden"]):not(:disabled), [tabindex="0"]') ?? page)?.focus();
    }}>
      <aside className="app-settings__nav">
        <button type="button" className="app-settings__back" onClick={() => setSettings(null)}><ChevronDown size={14} aria-hidden style={{ transform: 'rotate(90deg)' }} /> Back to workspace</button>
        <RadixDialog.Title asChild><div className="app-settings__heading">Settings</div></RadixDialog.Title>
        {settingsSections.map(section => <button key={section.id} type="button" className={`cfg-nav__item${settings === section.id ? ' is-active' : ''}`} aria-current={settings === section.id || undefined} onClick={() => setSettings(section.id)}>{section.label}</button>)}
      </aside>
      <div className="app-settings__main">
        <button type="button" className="app-settings__close icon-btn" onClick={() => setSettings(null)} aria-label="Close settings" title="Close (Esc)"><X size={16} aria-hidden /></button>
        <div className="app-settings__page legacy" tabIndex={-1}>
          {!directory ? <p className="empty" role="status">Loading workspace...</p>
            : settings === 'skills' ? <Suspense fallback={<p className="empty" role="status">Loading skill library...</p>}><SkillsPanel agents={directory.agents} request={api} onClose={() => setSettings(null)} /></Suspense>
            : settings === 'updates' ? <UpdatesPanel request={api} />
            : settings === 'machines' ? <MachinesPanel request={api} onChanged={() => { void remoteMachines.reload(); }} />
            : settings === 'connected-apps' ? <Suspense fallback={<p className="empty" role="status">Loading connected apps...</p>}><ConnectedAppsPanel agents={directory.agents} request={api} /></Suspense>
            : settings === 'mcp-server' ? <Suspense fallback={<p className="empty" role="status">Loading MCP server...</p>}><McpServerPanel request={api} /></Suspense>
            : settings === 'mcp' ? <Suspense fallback={<p className="empty" role="status">Loading MCP connections...</p>}><McpPanel agents={directory.agents} request={api} onClose={() => setSettings(null)} /></Suspense>
            : settings === 'data' ? <Suspense fallback={<p className="empty" role="status">Loading shared data...</p>}><SharedDataPanel agents={directory.agents} request={api} onClose={() => setSettings(null)} /></Suspense>
            : settings === 'usage' ? <Suspense fallback={<p className="empty" role="status">Loading usage...</p>}><UsagePanel request={api} onClose={() => setSettings(null)} /></Suspense>
            : settings === 'backup' ? <Suspense fallback={<p className="empty" role="status">Loading backup...</p>}><BackupPanel onClose={() => setSettings(null)} /></Suspense>
            : settings === 'import' ? <Suspense fallback={<p className="empty" role="status">Loading agent import...</p>}><AgentTemplateImport request={api} onClose={() => setSettings(null)} onCreated={item => { created(item); setSettings(null); }} /></Suspense>
            : settings === 'sections' ? <AgentSidebar mode="editor" agents={directory.agents} request={api} renderAgent={() => null} />
            : <Suspense fallback={<p className="empty" role="status">Loading appearance settings...</p>}><PresentationSettings /></Suspense>}
        </div>
      </div>
    </RadixDialog.Content></RadixDialog.Portal>
  </div></RadixDialog.Root>;
}

function ComputerWindow() {
  const agent = new URLSearchParams(location.search).get('computer') ?? '';
  const [name, setName] = useState('Agent'), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api<Directory>('/api/agents').then(data => { const found = data.agents.find(item => item.id === agent); if (active) { if (found) setName(found.name); else setError('Agent not found.'); } }).catch(error => { if (active) setError(message(error)); });
    return () => { active = false; };
  }, [agent]);
  return <main className="computer-window bs-root"><h1>{name}'s computer</h1>{error ? <Alert tone="error">{error}</Alert> : <ComputerViewer agent={agent} name={name} request={api} popout />}</main>;
}
applyPresentation(document.documentElement, readPresentation().value);
createRoot(document.getElementById('root')!).render(<ConfirmProvider>{new URLSearchParams(location.search).has('computer') ? <ComputerWindow /> : <App />}</ConfirmProvider>);
