import { restoreThreadCommand, type ThreadCommand } from '../thread-command';
import './Conversations.css';
import { AgentConversation, RoomMessages, type RoomView, type Exchange } from './ui/AgentConversation';
import { UpdatesPanel, useUpdateBadge } from './UpdatesPanel';
import { HarnessApprovalCard, type HarnessApproval } from './HarnessApprovalCard';
import './ui/csp-nonce';
import { SourceControl, RestoreCheckpoint } from './SourceControl';
import { ComputerViewer, ComputerRequestCard } from './ComputerViewer';
import type { ComputerWait } from '../agent-computer';
import { AgentComputerPanel } from './AgentComputerPanel';
import { AgentBrowserPanel } from './AgentBrowserPanel';
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
import { AgentMessage, ChatComposer, ChatEmptyState, ChatHeader, ChatTranscript, HumanMessage, TurnStatus } from './ui/ChatPrimitives';
import { livePartial, turnPollDelay, type TurnActivityData } from './ui/transcript';
import { EventConnection } from './EventConnection';
import { applyPresentation, presentationKey, readPresentation } from '../presentation';
import { CreateProject, HelpPage, HowBriefsipWorks, ProjectHome, ProjectSidebar, ProjectSourceControl, useProjects } from './Projects';
import { MachinesPanel, RemoteAgentDetail, useMachines } from './MachinesPanel';
import { HtmlPreview } from './HtmlPreview';
import { QuestionCard, type Question } from './QuestionCard';
import { ApprovalCard, type AppApproval } from './ApprovalCard';
import { CompactionPanel } from './CompactionPanel';
import { lazy, Suspense, useEffect, useRef, useState, useId, type FormEvent, type ReactNode } from 'react';
import { Bell, BellOff, Brain, CalendarClock, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Clock, Ellipsis, Filter, FolderOpen, Hash, MessageSquare, Monitor, PanelLeft, PanelRight, Paperclip, Pause, Pencil, Play, Plus, RefreshCw, Search, Server, Settings, Workflow as WorkflowIcon, X } from 'lucide-react';
import { Menu, type MenuItem } from './ui/Menu';
import { PageView, useDetailsOpen } from './ui/layout';
import { PanelResizeHandle, detailsPanel, sidebarPanel, useResizablePanel } from './ui/resizable';
import { ActionMenu, Alert, Badge, Button, Card, Checkbox, CodeBlock, Collapsible, Combobox, ConfirmProvider, Dialog, EmptyState, Field, IconButton, Input, PageHeader, Row, Section, Segmented, Select, SkeletonRows, Switch, TabPanel, Tabs, Textarea, useConfirm, type SelectOption, RecoveryAlert } from './ui/kit';
import { createRoot } from 'react-dom/client';
import { Collapsible as Disclosure, Dialog as RadixDialog, DropdownMenu } from 'radix-ui';
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
import './Routines.css';
import { RoutineSchedule, scheduleLabel, type RoutineTiming } from './RoutineSchedule';
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

type Agent = { workspace_connected?: boolean; runtime?: 'api' | 'codex' | 'claude'; computer_waiting?: boolean; avatar_revision?: number; hidden?: boolean; visibility_revision?: number; provider_account?: string; provider_available?: boolean; backup_model?: string; thread_limit: number; tool_budget?: number; revision: number; id: string; name: string; role: string; model: string; instructions: string };
type Channel = { project?: string | null; activity: number; read_position: number; revision: number; archived: number; id: string; name: string; instructions: string; members: string[]; lead: string | null };
type Thread = { delivery?: boolean; active?: boolean; activity?: number; id: string; agent: string; name: string; revision: number; archived: number; deleted: number; fork?: { source_name: string; source_id: string; source_kind: 'agent' | 'channel' | 'thread'; source_agent: string; cutoff_turn: string; created: string } | null };
type AgentMessage = Exchange & { taskId?: string; task?: string; wait?: boolean; generatedFiles?: { id: string; name: string; size: number; thread: string }[]; paused: number; request: string; expects_reply: number; settled: number; id: string; agent: string; thread: string; name: string; status: string; error: string | null; reply: string | null; truncated: boolean };

type Turn = { routineReport?: { run: string; name: string; agent: string; thread: string; destination: string; status: string } | null; room?: RoomView | null; harnessApprovals?: HarnessApproval[]; computerWait?: ComputerWait; checkpoint?: { turn: string; restorable: boolean } | null; approvals?: AppApproval[]; recipient?: string | null; dispatch_mode?: 'queue' | 'steer' | 'restart'; dispatch_target?: string | null; dispatch_label?: string | null; activity?: TurnActivityData; editing?: boolean; events?: { id: string; event: string; deadline: number; status: string }[]; receivedAgentReplies?: (AgentMessage & { source: string })[]; messageOrigin?: { kind?: 'peer'; name: string; agent: string | null; channel: string | null; thread: string | null } | null; agentMessages?: AgentMessage[]; partial?: { text: string; model: string; status: string } | null; answer_model?: string | null; questions?: Question[]; workflow_run?: string | null; no_update: number; generatedFiles?: { id: string; name: string; size: number }[]; seq: number; files?: { id: string; name: string; size: number }[]; revision: number; paused: number; agent: string; parent?: string | null; waiting_for?: string | null; coordination?: { kind: string; child: string | null; prompt: string; owner_name: string; target_name: string }[]; routing?: string | null; agent_name?: string; id: string; text: string; reply: string | null; status: string; error: string | null; created: string };
type Directory = { agents: Agent[]; configured: boolean; defaultModel: string };
type Environment = { id: string; name: string; origin: string; version: string };
/** One-line sidebar preview: strip Markdown markers so rows read as plain text. */
function plainPreview(text?: string) {
  if (!text) return '';
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~`]+/g, '').replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '').replace(/\s+/g, ' ').trim();
}
type SidebarSummary = { agent: string; preview: string; time: string | null; status: string };
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
  return <div className="k-stack bs-root"><Collapsible variant="section" title="Conversation files" open={open} onOpenChange={onOpenChange}>
    <div className="k-stack">
      <p className="k-field__hint">Maximum 10 MiB per file. Select attachments to send with your next message. Up to four attachments: 32 KiB total UTF-8 text and 4 MiB total PNG/JPEG/WebP images. Select a model that supports images.</p>
      {open && <AudioRecorder disabled={archived || busy || loading || !!pending.current || !!selected} onRecording={setRecording} onReady={file => { setSelected(file); if (input.current) input.current.value = ''; }} />}
      <form className="k-stack" onSubmit={upload}>
        <input ref={input} type="file" hidden disabled={recording || busy || loading || !!pending.current?.file || (archived && !pending.current)} onChange={event => setSelected(event.target.files?.[0] ?? null)} />
        <div className="k-row-actions"><Button size="sm" disabled={recording || busy || loading || !!pending.current?.file || (archived && !pending.current)} onClick={() => input.current?.click()}>Choose file</Button><Button type="submit" size="sm" busy={busy} disabled={recording || busy || loading || (archived && !pending.current) || (!selected && !pending.current?.file)}>{busy ? 'Processing...' : pending.current ? 'Retry upload' : 'Upload file'}</Button></div>
        {selected && <span className="k-field__hint">{selected.name}</span>}
      </form>
      {pending.current && <RecoveryAlert inFlight={busy} tone="warn" title={`Upload ${pending.current.name} is not confirmed yet`} actions={<Button size="sm" disabled={busy || loading} onClick={() => void checkPending()}>Check upload status</Button>}>Select the same file again or check upload status.</RecoveryAlert>}
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

function ForkAnswer({ path, turn, onOpen }: { path: string; turn: Turn; onOpen?: (agent: string, thread: string) => void }) {
  const key = `briefsip:fork:${turn.id}`;
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const flight = useRef(false);
  async function fork() {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError('');
    try {
      const saved = sessionStorage.getItem(key), id = saved ?? crypto.randomUUID();
      if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Fork recovery could not be read. Check browser storage before retrying.');
      sessionStorage.setItem(key, id);
      const result = await api<Thread>(`${path}/${turn.id}/fork`, { id });
      sessionStorage.removeItem(key);
      onOpen?.(result.agent, result.id);
    } catch (error) { setError(message(error)); }
    finally { flight.current = false; setBusy(false); }
  }
  return <><Button size="sm" variant="ghost" disabled={busy || !onOpen} busy={busy} onClick={() => void fork()}>Fork from here</Button>{error && <span className="message-error" role="alert">{error} Retry uses the same fork request.</span>}</>;
}

type DetailsContent = { chats: ReactNode; activity?: ReactNode; library?: ReactNode };
function Chat({ agent, configured, channel, thread, members = [], onRead, onEdit, onOpenAgent, onOpenChannel, menuItems = [], detailsExtra, sourceControl }: { sourceControl?: ReactNode; menuItems?: MenuItem[]; detailsExtra?: DetailsContent; onOpenChannel?: (channel: string) => void; onOpenAgent?: (agent: string, thread: string) => void; onRead?: () => Promise<void>; onEdit?: () => void; agent: Agent | Channel; configured: boolean; channel?: Channel; thread?: Thread; members?: Agent[] }) {
  const confirm = useConfirm();
  const archived = !!(channel?.archived || thread?.archived || (!channel && (agent as Agent).hidden));
  const scope = thread ? `thread:${thread.id}` : channel ? `channel:${agent.id}` : agent.id;
  const path = thread ? `/api/threads/${thread.id}/turns` : `/api/${channel ? 'channels' : 'agents'}/${agent.id}/turns`;
  const [showMemory, setShowMemory] = useState(false);
  const memoryButton = useRef<HTMLButtonElement>(null);
  const [focusedTask, setFocusedTask] = useState(() => { try { const key = `briefsip:focus:${scope}`, id = sessionStorage.getItem(key) ?? ''; sessionStorage.removeItem(key); return /^[a-f0-9-]{36}$/i.test(id) ? id : ''; } catch { return ''; } });
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState('');
  const [historyPages, setHistoryPages] = useState<number[]>([]);
  const before = historyPages.at(-1);
  const historyTop = useRef<HTMLDivElement>(null);
  const focusHistory = useRef(false);
  const focusedOnce = useRef('');
  const loadedTask = useRef<string | null>(null);
  const attachmentKey = `briefsip:attachments:${scope}`;
  const [attached, setAttached] = useState<string[]>(() => { try { const ids = JSON.parse(sessionStorage.getItem(attachmentKey) ?? '[]'); return Array.isArray(ids) && ids.length <= 4 && ids.every(id => typeof id === 'string') ? ids : []; } catch { return []; } });
  function attach(ids: string[]) { try { sessionStorage.setItem(attachmentKey, JSON.stringify(ids)); setAttached(ids); } catch { setError('Attachment selection was not saved. Check browser storage.'); } }
  const storageKey = `briefsip:pending:${scope}`;
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [activeTurns, setActiveTurns] = useState<{ id: string; agent: string; capabilities: { steer: boolean; queue: boolean; restart: boolean } }[]>([]);
  const [dispatchMode, setDispatchMode] = useState<'queue' | 'steer' | 'restart'>('queue');
  const dispatchTarget = activeTurns.find(turn => !channel);
  const canSteer = !!dispatchTarget?.capabilities.steer;
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
      try { const [active, data] = await Promise.all([api<typeof activeTurns>(path.replace(/\/turns$/, '/dispatch')), api<Turn[]>(focusedTask ? `${path}?focus=${focusedTask}` : `${path}?${new URLSearchParams({ ...(before ? { before: String(before) } : {}), ...(query ? { q: query } : {}) })}`)]); if (!stopped) { setActiveTurns(active); loadedTask.current = focusedTask; setTurns(data); setReadError(''); delay = turnPollDelay(data); } }
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
  useEffect(() => { setDispatchMode('queue'); }, [dispatchTarget?.id]);
  async function send(event: FormEvent, forcedMode?: 'queue' | 'steer') {
    event.preventDefault();
    if (requestActive.current || blocked || (!pending && !draft.trim())) return;
    if (archived) { setError('Restore the conversation before sending a new message.'); return; }
    const mode = dispatchTarget ? forcedMode ?? dispatchMode : 'queue';
    const request = pending ?? { id: crypto.randomUUID(), text: draft.trim(), ...(mode !== 'queue' ? { dispatchMode: mode, targetTurn: dispatchTarget!.id } : {}), ...(attached.length ? { files: attached } : {}),  };
    try { sessionStorage.setItem(storageKey, JSON.stringify(request)); }
    catch { setError('The browser could not save send status. Enable site storage before sending.'); return; }
    requestActive.current = true; setBusy(true); setPending(request); setError(''); nearBottom.current = true;
    try {
      const result = await api<Turn>(path, request);
      if (result.dispatch_label?.startsWith('Steer used restart')) setDispatchMode('queue');
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
  const tabStorageKey = `briefsip:details-tab:${scope}`;
  const [detailsTab, setDetailsTab] = useState<'chats' | 'activity' | 'library'>(() => {
    try { const value = localStorage.getItem(tabStorageKey); return value === 'activity' || value === 'library' ? value : 'chats'; } catch { return 'chats'; }
  });
  function selectDetailsTab(value: 'chats' | 'activity' | 'library') { setDetailsTab(value); try { localStorage.setItem(tabStorageKey, value); } catch { /* Keep tab selection in memory. */ } }
  const details = useResizablePanel(detailsPanel);
  const [filesOpen, setFilesOpen] = useState(false);
  const filesSection = useRef<HTMLDivElement>(null);
  if (showMemory) return <PageView><Suspense fallback={<p className="empty" role="status">Loading memory...</p>}><MemoryPanel key={scope} path={`/api/${channel ? 'channels' : 'agents'}/${agent.id}/memory`} channel={!!channel} archived={!!channel?.archived} request={api} onClose={() => { setShowMemory(false); requestAnimationFrame(() => memoryButton.current?.focus()); }} /></Suspense></PageView>;
  const active = turns?.filter(turn => turn.status === 'queued' || turn.status === 'running').length ?? 0;
  const title = thread?.name ?? agent.name;
  const editLabel = channel ? 'Section settings' : thread ? 'Conversation settings' : 'Edit profile';
  const openFiles = () => { setDetailsOpen(true); selectDetailsTab('library'); setFilesOpen(true); requestAnimationFrame(() => filesSection.current?.querySelector<HTMLButtonElement>('.k-collapsible__trigger')?.focus()); };
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
      <ChatTranscript onScroll={event => { const el = event.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
            {(focusedTask || before || query) && <div className="history-banner" role="status"><span>{focusedTask ? channel ? 'Task family' : 'Selected message' : query ? `Search results: ${query}` : 'Older history'}</span><button type="button" className="link-btn" onClick={() => { focusHistory.current = true; setTurns(null); setFocusedTask(''); setHistoryPages([]); setQuery(''); focusedOnce.current = ''; nearBottom.current = true; }}>Back to latest messages</button></div>}
            {!focusedTask && <div ref={historyTop} tabIndex={-1} className="history-navigation" aria-label="History navigation">
              {!!turns && turns.length >= 100 && <button type="button" className="link-btn" onClick={() => { if (turns?.length) { focusHistory.current = true; setTurns(null); setHistoryPages([...historyPages, turns[0].seq]); } }}>Older messages</button>}
              {!!before && <button type="button" className="link-btn" onClick={() => { focusHistory.current = true; setTurns(null); setHistoryPages(historyPages.slice(0, -1)); nearBottom.current = true; }}>Newer messages</button>}
            </div>}
            {thread?.fork && <div className="fork-origin" aria-label="Fork origin"><span>Forked from <a className="link-btn" href={`#turn-${thread.fork.cutoff_turn}`} onClick={event => { event.preventDefault(); const origin = thread.fork!; try { sessionStorage.setItem(`briefsip:focus:${origin.source_kind === 'channel' ? `channel:${origin.source_id}` : origin.source_kind === 'thread' ? `thread:${origin.source_id}` : origin.source_agent}`, origin.cutoff_turn); } catch { /* Conversation link remains usable without focus recovery. */ } if (origin.source_kind === 'channel') onOpenChannel?.(origin.source_id); else onOpenAgent?.(origin.source_agent, origin.source_kind === 'thread' ? origin.source_id : ''); }}>{thread.fork.source_name}</a> at <time dateTime={thread.fork.created}>{new Date(thread.fork.created).toLocaleString('en-US')}</time></span></div>}
            {readError && <p role="alert" className="chat-notice is-error">{readError} History will be retried.</p>}
            {turns === null ? <p className="empty-chat__sub" role="status">Loading conversation...</p>
              : turns.length === 0 && query ? <p className="empty-chat__sub" role="status">No results on this page. Change your search term or return to the previous page.</p>
              : turns.length === 0 && before ? <p className="empty-chat__sub" role="status">Start of history reached. Select Newer messages to return.</p>
              : turns.length === 0 ? <ChatEmptyState agent={agent} title={thread?.fork ? `Continue with ${agent.name}` : undefined}>{thread?.fork ? 'Earlier context is included through the selected answer. New messages stay in this conversation.' : 'Send your first task or question. The conversation is saved on this computer.'}</ChatEmptyState>
              : turns.filter(turn => !turn.room || turn.room.root === turn.id || !turns.some(root => root.id === turn.room!.root)).map(turn => <article key={turn.id} id={`turn-${turn.id}`} tabIndex={-1} className="turn-block">
                {query && <button type="button" className="link-btn" onClick={() => { setQuery(''); setHistoryPages([]); focusedOnce.current = ''; setFocusedTask(turn.id); }}>Open this message</button>}
                {turn.routineReport ? <section className="routine-report" aria-label={`Routine report: ${turn.routineReport.name}`}><div className="routine-report__meta"><CalendarClock size={16} aria-hidden /><strong>Routine report</strong><time dateTime={turn.created}>{time(turn.created)}</time></div><div className="legacy routine-report__body"><Markdown text={turn.reply ?? ''} scope={path.slice(0, -6)} origin={window.location.origin} /></div><a className="k-link" href={`#routine-run-${turn.routineReport.run}`} onClick={event=>{event.preventDefault();onOpenAgent?.(turn.routineReport!.agent,turn.routineReport!.thread);}}>Open full run</a></section> : <><HumanMessage text={turn.text} label={turn.messageOrigin?.kind === 'peer' ? `Message from ${turn.messageOrigin.name}` : 'Your message'} attachments={!!turn.files?.length && <ul className="chip-list" aria-label="Message attachments">{turn.files.map(file => <li key={file.id}><a className="cite-chip" href={`${path.replace(/\/turns$/, '/files')}/${file.id}`} download={file.name}><Paperclip size={12} aria-hidden /> {file.name}</a></li>)}</ul>}>
                    <time className="message-time" dateTime={turn.created} title={new Date(turn.created).toLocaleString('en-US')}>{time(turn.created)}</time>
                    {turn.messageOrigin?.kind === 'peer' ? <span className="message-origin">From {turn.messageOrigin.name}</span> : turn.workflow_run ? <span className="message-origin">Workflow</span> : turn.parent ? <span className="message-origin">Subtask</span> : null}
                    <button type="button" className="link-btn link-btn--small" onClick={async () => { try { await navigator.clipboard.writeText(turn.text); } catch { setError('Message could not be copied. Select the text to copy it.'); } }}>Copy</button>
                    <a className="link-btn link-btn--small" href={`#turn-${turn.id}`} onClick={event => { event.preventDefault(); openFocused(turn.id); }}>View task</a>
                    {turn.parent && !turn.messageOrigin && <a className="link-btn link-btn--small" href={`#turn-${turn.parent}`} onClick={event => { event.preventDefault(); openFocused(turn.parent!); }}>View parent task</a>}
                    {turn.messageOrigin && turn.messageOrigin.kind !== 'peer' && <button type="button" className="link-btn link-btn--small" onClick={() => turn.messageOrigin!.channel ? onOpenChannel?.(turn.messageOrigin!.channel) : onOpenAgent?.(turn.messageOrigin!.agent!, turn.messageOrigin!.thread ?? '')}>Open requester conversation</button>}
                </HumanMessage>
                {turn.room ? <><TurnActivity turn={turn} agentName={agent.name} onOpenTask={openFocused} onOpenAgent={onOpenAgent} /><RoomMessages room={turn.room} members={members} scope={path.slice(0, -6)} pending={turns.filter(item => item.room?.root === turn.room!.root && !item.room.silent && !turn.room!.messages.some(message => message.kind === 'reply' && message.turn === item.id))} details={id => { const item = turns.find(item => item.id === id); return item && <><TurnActivity turn={{ ...item, room: { quiet: [] } }} agentName={members.find(member => member.id === item.agent)?.name ?? agent.name} onOpenTask={openFocused} onOpenAgent={onOpenAgent} /><TaskControls key={`${item.id}:${item.revision}`} turn={item} path={path} members={members} archived={archived} />{!['done','cancelled'].includes(item.status) && <Button size="sm" variant="ghost" onClick={() => void cancel(item)}>Stop</Button>}{item.questions?.map(question => <QuestionCard key={question.id} question={question} path={`${path}/${item.id}`} status={item.status} archived={archived} request={api} />)}{item.approvals?.map(approval => <ApprovalCard key={approval.id} approval={approval} path={`${path}/${item.id}`} status={item.status} archived={archived} request={api} />)}{item.computerWait && <ComputerRequestCard agent={item.agent} name={item.agent_name ?? agent.name} wait={item.computerWait} request={api} />}{item.generatedFiles?.map(file => <p key={file.id}><a className="k-link" href={`${path.replace(/\/turns$/, '/files')}/${file.id}`} download={file.name}>{file.name}</a><span className="message-role"> {file.size} bytes</span></p>)}{item.harnessApprovals?.map(approval => <HarnessApprovalCard key={approval.id} approval={approval} path={`${path}/${item.id}`} status={item.status} archived={archived} request={api} />)}</>; }} /></> : <AgentMessage identity={channel && members.length > 1 && <div className="agent-identity"><AgentAvatar agent={members.find(member => member.id === turn.agent) ?? { id: turn.agent, name: turn.agent_name ?? agent.name }} size={24} /><strong className="message-name">{turn.agent_name ?? agent.name}</strong></div>}>
                    <TurnActivity turn={turn} agentName={agent.name} onOpenTask={openFocused} onOpenAgent={onOpenAgent} />
                    {!channel && turn.checkpoint?.restorable && ['done', 'failed', 'cancelled', 'interrupted'].includes(turn.status) && <RestoreCheckpoint agent={turn.agent} turn={turn.id} request={api} />}
                    {!channel && (!!turn.agentMessages?.length || !!turn.receivedAgentReplies?.length) && <AgentConversation items={[...(turn.agentMessages ?? []), ...(turn.receivedAgentReplies ?? []).filter(item => !turn.agentMessages?.some(sent => sent.id === item.id))]} sender={turn.agent_name ?? agent.name} scope={path.slice(0, -6)} onOpen={onOpenAgent} />}
                    <div className="message-body">
                      {channel && turn.parent && <div className="room-request"><strong>{turn.messageOrigin?.name ?? turn.agent_name ?? agent.name}</strong><p>{turn.text}</p></div>}
                      {turn.dispatch_label && <p className="dispatch-receipt">{turn.dispatch_label}{turn.dispatch_target && <> · <button type="button" className="link-btn link-btn--small" onClick={() => openFocused(turn.dispatch_target!)}>{turn.dispatch_mode === 'steer' ? 'View target turn' : 'View interrupted turn'}</button></>}</p>}
                      {turn.status === 'done' && !turn.reply && turn.dispatch_label ? null : turn.reply ? <div className="legacy"><Markdown text={turn.reply} scope={path.slice(0, -6)} origin={window.location.origin} /></div>
                        : livePartial(turn) ? <div className="live-answer" aria-label="Streaming answer"><div className="legacy"><Markdown text={turn.partial!.text} scope={path.slice(0, -6)} origin={window.location.origin} /></div><span className="stream-caret" aria-hidden /></div>
                        : <p className={turn.error ? 'message-error' : 'message-muted'}>{turn.error && <CircleAlert size={14} aria-hidden />}{turn.error ?? <span>{(turn.approvals?.some(approval => approval.state === 'approval') || turn.harnessApprovals?.some(approval => approval.state === 'approval')) ? 'Review the connected app action to continue.' : turn.questions?.some(question => question.answer === null) ? 'Answer the question to continue the task.' : turn.workflow_run ? 'Workflow finished without a text result.' : turn.agentMessages?.some(item => item.expects_reply && !item.settled) ? 'Results will be combined after all recipients finish. New messages include results already available.' : turn.events?.some(event => event.status === 'waiting') ? 'Waiting for a signed event.' : turn.waiting_for ? 'Waiting for child task results.' : turn.status === 'queued' ? 'Waiting for turn.' : 'Waiting for provider response...'}</span>}</p>}
                      {!turn.reply && turn.partial?.text && !livePartial(turn) && <div className="message-partial"><p className="message-muted">Text from a previous attempt from {turn.partial.model}. Not a final result.</p><div className="legacy"><Markdown text={turn.partial.text} scope={path.slice(0, -6)} origin={window.location.origin} /></div></div>}
                    </div>
                    <TurnStatus tone={tone(turn)} label={statusLabel(turn)} model={turn.answer_model ?? turn.partial?.model} />
                    <div className="turn-controls">
                      {turn.reply && <SpeechPlayback key={`${path}:${turn.id}`} owner={`${path}:${turn.id}`} text={turn.reply} />}
                      {turn.status === 'done' && turn.reply && <ForkAnswer path={path} turn={turn} onOpen={onOpenAgent} />}
                      {turn.dispatch_mode !== 'steer' && <TaskControls key={`${turn.id}:${turn.revision}`} turn={turn} path={path} members={channel ? members : []} archived={archived || !!turn.editing} />}
                      {(!['done','cancelled'].includes(turn.status)) && <Button size="sm" variant="ghost" onClick={() => void cancel(turn)}>{turn.waiting_for ? 'Cancel task and delegation' : turn.status === 'running' ? 'Stop' : turn.status === 'queued' && !turn.paused ? 'Cancel queued task' : 'Cancel task'}</Button>}
                    </div>
                    <div className="turn-extras k-stack">
                      {turn.events?.map(event => <section className="k-stack" key={event.id}><Row title={`Event ${event.event}: ${event.status === 'waiting' ? 'Waiting' : event.status === 'received' ? 'Received' : event.status === 'expired' ? 'Expired' : 'Closed'}`} meta={new Date(event.deadline).toLocaleString('en-US')} />{event.status === 'waiting' && !archived && <EventConnection path={`/api/turn-waits/${event.id}`} request={api} />}</section>)}
                      {turn.harnessApprovals?.map(approval => <HarnessApprovalCard key={approval.id} approval={approval} path={`${path}/${turn.id}`} status={turn.status} archived={archived} request={api} />)}
                      {turn.approvals?.map(approval => <ApprovalCard key={approval.id} approval={approval} path={`${path}/${turn.id}`} status={turn.status} archived={archived} request={api} />)}
                      {turn.computerWait && <ComputerRequestCard agent={turn.agent} name={turn.agent_name ?? agent.name} wait={turn.computerWait} request={api} />}
                      {turn.questions?.map(question => <QuestionCard key={question.id} question={question} path={`${path}/${turn.id}`} status={turn.status} archived={archived} request={api} />)}
                      {!!turn.generatedFiles?.length && <section aria-label="Agent output files"><Card>{turn.generatedFiles.map(file => <Row key={file.id} title={<a className="k-link" href={`${path.replace(/\/turns$/, '/files')}/${file.id}`} download={file.name}>{file.name}</a>} meta={`${file.size} byte`}><HtmlPreview path={`${path.replace(/\/turns$/, '/files')}/${file.id}`} name={file.name} request={api} /></Row>)}</Card></section>}
                      {!!turn.coordination?.length && <Collapsible title={`Task coordination (${turn.coordination.length})`}>{turn.coordination.map((action, index) => <div className="k-stack" key={index}><div className="k-section__title">{action.owner_name} {action.kind === 'delegate_task' ? 'delegated to' : 'reassigned to'} {action.target_name}.</div><div className="message-plain">{action.prompt}</div>{action.child && <div className="k-row-actions"><Button size="sm" variant="ghost" onClick={() => openFocused(action.child!)}>View subtask</Button></div>}</div>)}</Collapsible>}
                      {turn.dispatch_mode !== 'steer' && !turn.approvals?.length && <QueueEditor turn={{ ...turn, files: turn.files ?? [] }} path={path} archived={archived} request={api} />}
                    </div>
                </AgentMessage>}</>}
              </article>)}
            <div ref={bottom} />
      </ChatTranscript>
      <footer className="composer-area">
        {archived && <p className="composer__note">{!channel && (agent as Agent).hidden ? 'Agent is hidden. Restore it through Edit profile to resume the queue and receive new messages.' : 'Conversation is archived. History remains available. Restore it through the conversation menu to send new messages.'}</p>}
        {!configured && <p className="composer__note">{!channel && 'provider_account' in agent && !!agent.provider_account && agent.provider_available === false ? 'This agent provider account is unavailable. Select a connected account in the agent profile, or restore the account configuration on the server.' : 'Provider not connected. Check provider account configuration on the server, then restart the app.'} Agent and history remain saved.</p>}
        {error && <div className="composer__error" role="alert"><span>{error} {pending && 'Use Retry send to check the same request without creating a duplicate message.'}</span></div>}
        {blocked && <div className="composer__error" role="alert"><span>Message recovery data could not be read. Sending is blocked. Check history to confirm the previous message was not sent.</span><Button size="sm" variant="ghost" onClick={async () => { if (!await confirm({ title: 'Discard recovery data?', description: 'The previous message may already have been received. Check history before sending another message.', confirm: 'Discard message recovery', danger: true })) return; try { sessionStorage.removeItem(storageKey); setBlocked(false); setError(''); requestAnimationFrame(() => composer.current?.focus()); } catch { setError('Recovery data could not be deleted. Check site storage.'); } }}>Discard message recovery</Button></div>}
        {(pending?.files ?? attached).length > 0 && <p className="composer__note"><Paperclip size={12} aria-hidden /> {(pending?.files ?? attached).length} attachments will be sent to the provider with the message.</p>}
        {dispatchTarget && <div className="composer-dispatch bs-root">
          <Select size="sm" label="Message mode" value={pending?.dispatchMode ?? dispatchMode} disabled={busy || !!pending || blocked} onChange={value => setDispatchMode(value as typeof dispatchMode)} options={[
            { value: 'queue', label: 'Queue', hint: 'Send after the running turn finishes.' },
            { value: 'steer', label: canSteer ? 'Steer' : 'Steer (restarts turn)', hint: canSteer ? 'Add guidance before the next provider call.' : 'This runtime cannot steer. Stops the current turn and starts another with its partial context.' },
            { value: 'restart', label: 'Restart', hint: 'Stop this turn and start another with its partial context. Effects may already have happened.' },
          ]} />
          <span className="composer-dispatch__hint" role="status">{canSteer ? 'API runtime supports steering' : 'Runtime cannot steer; Steer uses Restart'}</span>
        </div>}
        <ChatComposer mentions={channel ? members : []} onMention={value => { setDraft(value); try { sessionStorage.setItem(draftKey, value); } catch { setError('Draft was not saved. Copy your message before leaving.'); } }} label={`Message ${agent.name}`} inputRef={composer} multiline={draft.includes('\n')} onSubmit={send} onSendKey={event => { void send(event, (event.ctrlKey || event.metaKey) && canSteer ? 'steer' : 'queue'); }} onAttach={openFiles}
          input={{ id: 'message', value: pending?.text ?? draft, readOnly: blocked || !!pending || busy, onChange: event => { setDraft(event.target.value); try { sessionStorage.setItem(draftKey, event.target.value); } catch { setError('Draft was not saved in the browser. Copy the message before switching agents.'); } } }}
          busy={busy} retry={!!pending}
          sendDisabled={blocked || archived || !configured || busy || (!pending && !draft.trim())}
          sendLabel={busy ? 'Sending...' : pending ? 'Retry send' : dispatchTarget ? dispatchMode === 'queue' ? 'Queue message' : dispatchMode === 'steer' ? canSteer ? 'Steer turn' : 'Steer by restarting turn' : 'Restart turn' : 'Send message'}
          sendTitle={pending ? 'Retry send' : dispatchTarget ? `${dispatchMode === 'queue' ? 'Queue' : dispatchMode === 'steer' ? 'Steer' : 'Restart'} message` : 'Send (Enter)'} />
        <p className="composer__foot" title="Provider receives up to 40 previous conversations.">{focusedTask ? channel ? 'Task family shown · ' : 'Selected message shown · ' : query ? 'Up to 100 results per page · ' : before ? 'Up to 100 older messages per page · ' : ''}{dispatchTarget ? `Enter to queue${canSteer ? ', Ctrl/Cmd+Enter to steer' : ''}` : 'Enter to send'}, Shift+Enter for a new line</p>
      </footer>
      <ChatHeader agent={agent} title={title} onToggle={() => setMenuOpen(!menuOpen)} expanded={menuOpen}
        menu={menuOpen && <Menu align="center" label={`Menu ${title}`} onClose={() => setMenuOpen(false)} items={items} />}
        right={<><span className={`activity-chip${active ? ' is-working' : ''}`} role="status">{active ? `${active} ${active === 1 ? 'message' : 'messages'} processing` : channel ? 'Shared section' : 'Direct conversation'}</span>
          {!detailsOpen && <button type="button" className="icon-btn icon-btn--bordered" onClick={() => setDetailsOpen(true)} aria-label="Show details" title="Show details"><PanelRight size={16} aria-hidden /></button>}</>} />
    </main>
    {detailsOpen && <aside className="details" style={{ width: `${details.width}px` }} aria-label="Conversation details">
      <PanelResizeHandle panel={details} />
      <div className="details__top">
        {onEdit && <button type="button" className="icon-btn icon-btn--bordered details__gear" onClick={onEdit} aria-label={editLabel} title={editLabel}><Settings size={16} aria-hidden /></button>}
        <button type="button" className="icon-btn icon-btn--bordered" onClick={() => setDetailsOpen(false)} aria-label="Close details"><X size={16} aria-hidden /></button>
      </div>
      <div className="details__scroll">
        <div className="details__identity">
          <AgentAvatar agent={agent} size={56} />
          <div className="details__name" title={agent.name}>{agent.name}</div>
          <div className="details__who-sub" title={!channel ? (agent as Agent).role || 'Agent' : undefined}>{channel ? `Section${channel.archived ? ' · Archived' : ''}` : (agent as Agent).role || 'Agent'}</div>
          {!channel && <span className="details__model" title={(agent as Agent).runtime && (agent as Agent).runtime !== 'api' ? `${(agent as Agent).runtime} runtime` : (agent as Agent).model}>{(agent as Agent).runtime && (agent as Agent).runtime !== 'api' ? `${(agent as Agent).runtime} runtime` : (agent as Agent).model}</span>}
        </div>
        {!channel && <div className="details__computer details__computer-row"><AgentComputerPanel key={`computer:${agent.id}`} agent={agent.id} name={agent.name} request={api} compact /><AgentBrowserPanel key={`browser:${agent.id}`} agent={agent.id} name={agent.name} request={api} compact /></div>}
        {channel && <div className="details__channel-meta">
          <div className="section-label">{members.length} members</div>
          <div className="details__members" aria-label={`${members.length} channel members`}>{members.map(member => <span key={member.id} role="img" aria-label={`${member.name}${member.id === channel.lead ? ", lead" : ""}`} title={member.name}><AgentAvatar agent={member} size={24} /></span>)}</div>
          <div className="details__read"><span>{channel.activity > channel.read_position ? 'Unread activity' : 'All activity read'}</span><button type="button" className="link-btn link-btn--small" disabled={markingRead || channel.activity <= channel.read_position} onClick={() => { setMarkingRead(true); void onRead?.().catch(error => setError(message(error))).finally(() => setMarkingRead(false)); }}>Mark as read</button></div>
        </div>}
        <div className="details__tabs">
          <Tabs value={detailsTab} onChange={selectDetailsTab} label="Details sections" tabs={[{ value: 'chats', label: 'Chats' }, { value: 'activity', label: 'Activity' }, { value: 'library', label: 'Library' }]}>
            <TabPanel value="chats"><div className="details__sections">
              {detailsExtra?.chats}
              <section><div className="section-label">Search conversation</div><form className="details-search" role="search" onSubmit={event => { event.preventDefault(); if (!searchText.trim()) return; focusHistory.current = true; nearBottom.current = false; setQuery(searchText); setFocusedTask(''); setHistoryPages([]); focusedOnce.current = ''; }}><label className="sr-only" htmlFor="history-search">Search this conversation</label><input id="history-search" className="text-input" type="search" maxLength={200} value={searchText} onChange={event => setSearchText(event.target.value)} aria-describedby="history-search-help" placeholder="Message or reply" /><button type="submit" className="cfg-btn cfg-btn--secondary" disabled={!searchText.trim()}>Search</button></form><p id="history-search-help" className="details-hint">Case-sensitive.</p></section>
            </div></TabPanel>
            <TabPanel value="activity"><div className="details__sections">
              <section aria-label="Running messages"><div className="section-label">Running messages</div><div className="panel-card">{activeTurns.length ? activeTurns.map(turn => <button key={turn.id} type="button" className="panel-row panel-row--link" onClick={() => openFocused(turn.id)}><span className="panel-row__title">{turns?.find(item => item.id === turn.id)?.text ?? 'Open running message'}</span></button>) : <p className="panel-empty">No messages running.</p>}</div></section>
              <section><QueuePanel path={path} request={api} onOpen={id => { setQuery(''); setHistoryPages([]); focusedOnce.current = ''; setFocusedTask(id); }} /></section>
              <Collapsible variant="section" title="Delegated tasks"><div className="panel-card">{turns?.some(turn => turn.coordination?.length || turn.agentMessages?.length || turn.parent) ? turns.filter(turn => turn.coordination?.length || turn.agentMessages?.length || turn.parent).map(turn => <button key={turn.id} type="button" className="panel-row panel-row--link" onClick={() => openFocused(turn.id)}><span className="panel-row__text"><span className="panel-row__title">{turn.text}</span><span className="panel-row__meta">{statusLabel(turn)}</span></span></button>) : <p className="panel-empty">No delegated tasks in this view.</p>}</div></Collapsible>
              {channel?.project && <SectionRoutines channel={channel.id} onOpen={onOpenAgent} />}
              {detailsExtra?.activity}
              <Collapsible variant="section" title="Event waits"><div className="k-stack">{turns?.some(turn => turn.events?.some(event => event.status === 'waiting')) ? turns.flatMap(turn => turn.events?.filter(event => event.status === 'waiting').map(event => <div key={event.id} className="k-stack"><button type="button" className="panel-row panel-row--link" onClick={() => openFocused(turn.id)}><span className="panel-row__text"><span className="panel-row__title">{event.event}</span><time className="panel-row__meta" dateTime={new Date(event.deadline).toISOString()}>{new Date(event.deadline).toLocaleString('en-US')}</time></span></button>{!archived && <EventConnection path={`/api/turn-waits/${event.id}`} request={api} />}</div>)) : <p className="panel-empty">No event waits in this view.</p>}</div></Collapsible>
            </div></TabPanel>
            <TabPanel value="library"><div className="details__sections"><section><div className="section-label">Memory and context</div><div className="panel-card"><button ref={memoryButton} type="button" className="panel-row panel-row--action" onClick={() => setShowMemory(true)}><Brain size={16} aria-hidden /> {channel ? 'Channel' : 'Agent'} memory</button></div><CompactionPanel path={path.replace(/\/turns$/, '/compaction')} request={api} /></section><section ref={filesSection}><ConversationFiles path={path.replace(/\/turns$/, '/files')} archived={archived} attached={pending?.files ?? attached} onAttach={attach} locked={blocked || !!pending || busy} open={filesOpen} onOpenChange={setFilesOpen} /></section>{sourceControl ?? (!channel && (agent as Agent).workspace_connected && <SourceControl key={agent.id} agent={agent.id} request={api} />)}{detailsExtra?.library}</div></TabPanel>
          </Tabs>
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

type Routine = { trigger: 'schedule' | 'webhook' | 'manual' | 'script'; id: string; agent: string; name: string; prompt: string; next_at: number; interval_ms: number | null; enabled: number; revision: number; project?: string | null; project_name?: string | null; report_to?: string; report_section?: string | null; schedule?: import('../schedule-spec').Spec | null; schedule_zone?: string | null; routineReport?: { run: string; status: string; thread: string }; owner_name?: string; flow_agents?: number; last_source?: string | null; last_scheduled_at?: number | null; last_status?: string | null; last_paused?: number | null; last_no_update?: number | null; last_created?: string | null; last_thread?: string | null };
type RoutineRun = { paused: number; source: string; no_update: number; turn: string; thread: string; scheduled_at: number | null; created: string; missed: number; status: string; reply: string | null; error: string | null };
type RoutineCommand = { routineId: string | null; data: { id: string; revision?: number; trigger?: 'schedule' | 'webhook' | 'manual' | 'script'; name: string; prompt: string; nextAt?: number; intervalSeconds?: number | null; schedule?: import('../schedule-spec').Spec; zone?: string; project?: string | null; reportTo?: string; enabled: boolean } };
const routineReportLabel = (routine: Routine) => routine.report_section ? `${routine.project_name ?? 'Project'} / # ${routine.report_section}` : routine.report_to === 'direct' ? "Owner agent's direct chat" : "Only in the run's own conversation";
function SectionRoutines({channel,onOpen}:{channel:string;onOpen?:(agent:string,thread:string)=>void}) {
  const [rows,setRows]=useState<Routine[] | null>(null),[error,setError]=useState('');
  useEffect(()=>{
    let stopped=false, timer:ReturnType<typeof setTimeout>;
    async function refresh(){try {
      const all:Routine[]=[]; let after='';
      do { const page=await api<{routines:Routine[];next_after:string|null}>(`/api/routines?${new URLSearchParams({reportTo:channel,after})}`);all.push(...page.routines);after=page.next_after ?? ''; } while(after && !stopped);
      if(!stopped){setRows(all);setError('');}
    } catch(error){if(!stopped)setError(message(error));} if(!stopped)timer=setTimeout(refresh,5000);}
    void refresh();return()=>{stopped=true;clearTimeout(timer);};
  },[channel]);
  return <section aria-label="Routines reporting here"><div className="section-label">Routines reporting here</div>{error && <Alert tone="error">{error}</Alert>}<div className="panel-card">{rows===null ? <p className="panel-empty" role="status">Loading routines...</p> : rows.length ? rows.map(row=><div key={row.id} className="panel-row"><span className="panel-row__text"><span className="panel-row__title">{row.name}</span><span className="panel-row__meta">{routineTriggerLabel(row)} · {row.enabled ? 'Enabled' : 'Paused'}</span>{row.last_thread && <button type="button" className="link-btn link-btn--small" onClick={()=>onOpen?.(row.agent,row.last_thread!)}>Open last run</button>}</span></div>) : <p className="panel-empty">No routines report to this section.</p>}</div></section>;
}
function UpcomingRoutines({ agent, onManage }: { agent: string; onManage: () => void }) {
  const [rows, setRows] = useState<Routine[] | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const next = await api<Routine[]>(`/api/agents/${agent}/routines`); if (!stopped) { setRows(next); setError(''); } }
      catch (error) { if (!stopped) setError(message(error)); }
      if (!stopped) timer = setTimeout(refresh, 1200);
    }
    void refresh(); return () => { stopped = true; clearTimeout(timer); };
  }, [agent]);
  // ponytail: preview the next three schedules; Manage opens the full routine list.
  const upcoming = rows?.filter(row => row.enabled && row.trigger === 'schedule').sort((a, b) => a.next_at - b.next_at).slice(0, 3);
  return <section aria-label="Upcoming routines"><div className="section-label section-label--row"><span>Upcoming</span><button type="button" className="link-btn link-btn--small" onClick={onManage}>Manage</button></div>
    {error ? <Alert tone="error">{error}</Alert> : <div className="panel-card">{rows === null ? <p className="panel-empty" role="status">Loading routines...</p> : upcoming?.length ? upcoming.map(row => <button type="button" key={row.id} className="panel-row panel-row--routine panel-row--link" onClick={onManage}><Clock size={16} aria-hidden /><span className="panel-row__text"><span className="panel-row__title">{row.name}</span><time className="panel-row__meta" dateTime={new Date(row.next_at).toISOString()}>{new Date(row.next_at).toLocaleString('en-US')}</time></span></button>) : <p className="panel-empty">Nothing scheduled.</p>}</div>}
  </section>;
}
function pendingRoutine(agent: string): RoutineCommand | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(`briefsip:routine-command:${agent}`) ?? 'null'), data = value?.data;
    return value && typeof data?.id === 'string' && typeof data.name === 'string' && typeof data.prompt === 'string' && typeof data.enabled === 'boolean'
      && (data.schedule && typeof data.schedule === 'object' && typeof data.schedule.kind === 'string' && typeof data.zone === 'string'
        || Number.isSafeInteger(data.nextAt) && data.nextAt > 0 && data.nextAt <= 253370764799999 && (data.intervalSeconds === null || Number.isSafeInteger(data.intervalSeconds)))
      && (value.routineId === null || typeof value.routineId === 'string') ? value : null;
  } catch { return null; }
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
    {pending && <RecoveryAlert inFlight={busy} tone="warn" title="Permission change is not confirmed yet">Save again to check the same request.</RecoveryAlert>}
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
      {pending && <RecoveryAlert inFlight={busy} tone="warn" title="Save is not confirmed yet">Try again with the same request.</RecoveryAlert>}
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
function FlowEditor({ routine, onOpen }: { routine: Routine; onOpen: (thread: string, owner: string) => Promise<void> }) {
  const optionName = (name: string) => name.length > 24 ? name.slice(0, 21) + '...' : name;
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
  return <div className="k-stack bs-root routine-flow">
    <Section title="Agent flow"
      actions={<><IconButton label="Reload flow" disabled={busy} onClick={() => setReload(value => value + 1)}><RefreshCw size={15} aria-hidden /></IconButton><Button variant="primary" busy={busy} disabled={!loaded || busy || conflict} onClick={() => void save()}>{busy ? 'Saving...' : pending ? 'Retry saving flow' : 'Save flow'}</Button></>}><p className="k-field__hint">Connect routine results to the next agent. Multiple inputs wait for all results; branches without a successful result are skipped. Changes apply only to new runs.</p></Section>
    {!loaded ? <p role="status">Loading flow...</p> : <><FlowDiagram graph={graph} agents={agents} />
      <div className="k-grid-2"><Field label="From agent" hint={name(from)}><Select value={from} disabled={locked} onChange={value => { setFrom(value); if (to === value) setTo(''); }} options={graph.nodes.map(id => ({ value: id, label: optionName(name(id)) }))} /></Field><Field label="To agent" hint={to ? name(to) : 'Not selected'}><Select value={to} disabled={locked} onChange={setTo} options={[{ value: '', label: 'Select agent' }, ...agents.filter(agent => agent.id !== routine.agent && agent.id !== from).map(agent => ({ value: agent.id, label: optionName(agent.name) }))]} /></Field></div>
      <div><Button disabled={locked || !to || to === from} onClick={() => change([...links, { from, to }])}>Connect</Button></div>
      <Card>{links.map(link => <Row key={`${link.from}:${link.to}`} title={`${name(link.from)} to ${name(link.to)}`} trailing={<IconButton label={`Remove relationship ${name(link.from)} to ${name(link.to)}`} disabled={locked} onClick={() => { const remaining = links.filter(item => item !== link), reachable = new Set([routine.agent]); let changed = true; while (changed) { changed = false; for (const edge of remaining) if (reachable.has(edge.from) && !reachable.has(edge.to)) { reachable.add(edge.to); changed = true; } } change(remaining.filter(edge => reachable.has(edge.from))); setFrom(routine.agent); }}><X size={14} aria-hidden /></IconButton>} />)}</Card>
      <p className="k-field__hint">Removing a relationship also removes branches no longer connected to the origin.</p>
    </>}
    {pending && <RecoveryAlert inFlight={busy} tone="warn" title="Save is not confirmed yet">Try again with the same request.</RecoveryAlert>}{error && <Alert tone="error">{error}</Alert>}
    <Section title="Execution steps">{runError && <Alert tone="error">{runError}</Alert>}{!runs.length ? <EmptyState title="No runs with saved flows" /> : runs.map(run => <Section key={run.root_turn} title={new Date(run.created).toLocaleString('en-US')}><Card>{run.steps.map(step => <Row key={step.agent} title={step.name} meta={<Badge>{step.paused ? 'Paused' : step.status === 'waiting' ? 'Waiting for input' : step.status === 'skipped' ? 'Skipped' : statusNames[step.task_status ?? step.status] ?? step.status}</Badge>} trailing={step.thread && <Button size="sm" onClick={() => void onOpen(step.thread!, step.agent).catch(error => setRunError(message(error)))}>Open step {step.name}</Button>}>
      {step.result && <span className="k-field__hint" style={{ whiteSpace: 'pre-wrap' }}>{step.result}{step.result_length > 1000 ? '...' : ''}</span>}
    </Row>)}</Card></Section>)}</Section>
  </div>;
}

function routineTriggerLabel(routine: Routine) {
  if (routine.trigger !== 'schedule') return routine.trigger === 'webhook' ? 'Webhook' : routine.trigger === 'script' ? 'Local script' : 'Manual';
  return scheduleLabel(routine.schedule, routine.next_at, routine.interval_ms, routine.schedule_zone);
}
function relativeRun(value: string | number) {
  const time = typeof value === 'number' ? value : Date.parse(value), seconds = Math.round((time - Date.now()) / 1000), absolute = Math.abs(seconds);
  const unit = absolute < 60 ? 'second' : absolute < 3600 ? 'minute' : absolute < 86400 ? 'hour' : 'day';
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(Math.round(seconds / (unit === 'day' ? 86400 : unit === 'hour' ? 3600 : unit === 'minute' ? 60 : 1)), unit);
}
const runStatus = (run: { paused?: number | null; no_update?: number | null; status?: string | null }) => run.paused ? 'Paused' : run.no_update ? 'No updates' : statusNames[run.status ?? ''] ?? run.status ?? 'Never run';
function RoutinesHub({ agents, projects, initialAgent, onClose, onOpen }: { agents: Agent[]; projects: import('../local-projects').LocalProject[]; initialAgent?: string; onClose: () => void; onOpen: (owner: string, thread: string) => void }) {
  type Command = { routine: string; action: 'test' | 'edit' | 'delete'; data: { id: string; revision: number } & Record<string, unknown> };
  const key = 'briefsip:routine-hub-command';
  const [recovered] = useState(() => {
    try {
      const raw = sessionStorage.getItem(key); if (!raw) return { command: null, blocked: false };
      const value = JSON.parse(raw);
      if (!value || !['test','edit','delete'].includes(value.action) || !/^[a-f0-9-]{36}$/i.test(value.routine) || !/^[a-f0-9-]{36}$/i.test(value.data?.id) || !Number.isSafeInteger(value.data?.revision)) throw new Error('Invalid command');
      return { command: value as Command, blocked: false };
    } catch { return { command: null, blocked: true }; }
  });
  const [pending, setPending] = useState<Command | null>(recovered.command), [blocked, setBlocked] = useState(recovered.blocked), [busy, setBusy] = useState(false);
  const [page, setPage] = useState<{ routines: Routine[]; next_after: string | null } | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  const [filters, setFilters] = useState({ search: '', agent: initialAgent ?? '', enabled: '', trigger: '', project: '' }), [cursors, setCursors] = useState(['']);
  const [editing, setEditing] = useState<Routine | null | undefined>(undefined), [detail, setDetail] = useState<Routine | null>(null), [webhook, setWebhook] = useState<Routine | null>(null);
  const heading = useRef<HTMLHeadingElement>(null), confirm = useConfirm(), flight = useRef(false), mounted = useRef(true), loadVersion = useRef(0);
  const after = cursors.at(-1)!;
  useEffect(() => { setPage(null); }, [filters, after]);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const version = loadVersion.current;
      try {
        const data = await api<{ routines: Routine[]; next_after: string | null }>(`/api/routines?${new URLSearchParams({ ...filters, after })}`);
        if (!stopped && version === loadVersion.current) { setPage(data); setDetail(current => current ? data.routines.find(row => row.id === current.id) ?? current : null); }
      } catch (error) { if (!stopped) setError(message(error)); }
      if (!stopped) timer = setTimeout(refresh, 1200);
    }
    void refresh(); return () => { stopped = true; clearTimeout(timer); };
  }, [filters, after, reload]);
  useEffect(() => { if (!detail) heading.current?.focus(); }, [!!detail, after]);
  const locked = busy || !!pending || blocked;
  function filter(name: keyof typeof filters, value: string) { setCursors(['']); setFilters(current => ({ ...current, [name]: value })); }
  const owner = (id: string) => agents.find(agent => agent.id === id);
  async function command(request: Command) {
    if (flight.current || blocked) return;
    flight.current = true; loadVersion.current++; setBusy(true); setError(''); setNotice('');
    try {
      // Retain the original request before sending; retries never regenerate an ID or payload.
      sessionStorage.setItem(key, JSON.stringify(request)); setPending(request);
      const result = await api<Routine>(`/api/routines/${request.routine}/${request.action}`, request.data);
      sessionStorage.removeItem(key);
      if (request.action === 'test') sessionStorage.removeItem(`briefsip:routine-test:${request.routine}`);
      if (!mounted.current) return;
      loadVersion.current++; setPending(null);
      if (request.action === 'edit') { setDetail(current => current?.id === request.routine ? { ...current, ...result } : current); setPage(current => current && ({ ...current, routines: current.routines.map(row => row.id === request.routine ? { ...row, ...result } : row) })); }
      setReload(value => value + 1);
      setNotice(request.action === 'test' ? 'Run accepted. Open Overview to follow its progress.' : request.action === 'delete' ? 'Routine deleted. Existing run conversations are retained.' : 'Routine updated.');
      if (request.action === 'delete') setDetail(null);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof HttpError && error.status < 500) { sessionStorage.removeItem(key); if (request.action === 'test') sessionStorage.removeItem(`briefsip:routine-test:${request.routine}`); setPending(null); setReload(value => value + 1); }
      setError(message(error));
    } finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  function toggle(routine: Routine) {
    if (locked) return;
    void command({ routine: routine.id, action: 'edit', data: { id: crypto.randomUUID(), revision: routine.revision, name: routine.name, prompt: routine.prompt, ...(routine.schedule ? { schedule: routine.schedule, zone: routine.schedule_zone } : { nextAt: routine.next_at, intervalSeconds: routine.interval_ms === null ? null : routine.interval_ms / 1000 }), project: routine.project, reportTo: routine.report_to, enabled: !routine.enabled, trigger: routine.trigger } });
  }
  function run(routine: Routine) {
    if (locked) return;
    try {
      const saved = sessionStorage.getItem(`briefsip:routine-test:${routine.id}`), data = saved ? JSON.parse(saved) : { id: crypto.randomUUID(), revision: routine.revision };
      if (!data || typeof data.id !== 'string' || !Number.isSafeInteger(data.revision)) throw new Error('Previous run request could not be read. Check browser storage and run history before retrying.');
      void command({ routine: routine.id, action: 'test', data });
    } catch (error) { setError(message(error)); }
  }
  async function remove(routine: Routine) {
    if (locked || !await confirm({ title: `Delete ${routine.name}?`, description: 'Future triggers stop. Existing conversations and run records are retained. Complete or cancel an active run before deleting.', confirm: 'Delete routine', danger: true })) return;
    void command({ routine: routine.id, action: 'delete', data: { id: crypto.randomUUID(), revision: routine.revision } });
  }
  async function discard() {
    if (!await confirm({ title: 'Discard routine recovery?', description: 'Check routines and run history first. The previous request may already have succeeded.', confirm: 'Discard recovery', danger: true })) return;
    try { sessionStorage.removeItem(key); setPending(null); setBlocked(false); setReload(value => value + 1); } catch (error) { setError(message(error)); }
  }
  const recovery = <>{blocked && <Alert tone="error" title="Routine recovery could not be read" actions={<Button disabled={busy} onClick={() => void discard()}>Discard recovery</Button>}>Check routine settings and run history before discarding.</Alert>}{pending && <RecoveryAlert inFlight={busy} tone="warn" title="Request is not confirmed yet" actions={<><Button disabled={busy} busy={busy} onClick={() => void command(pending)}>Retry request</Button><Button disabled={busy} onClick={() => void discard()}>Discard recovery</Button></>}>Retry the original request to check its result without duplicating work.</RecoveryAlert>}{error && <Alert tone="error" actions={<Button size="sm" onClick={() => { setError(''); setReload(value => value + 1); }}>Reload routines</Button>}>{error}</Alert>}{notice && <p role="status" className="k-field__hint">{notice}</p>}</>;
  const editingOwner = editing ? owner(editing.agent) : agents.find(agent => pendingRoutine(agent.id)) ?? owner(filters.agent) ?? agents[0];
  return <>
    {webhook ? <WebhookSettings key={webhook.id} routine={webhook} onBack={() => setWebhook(null)} /> : detail ? <RoutineDetail routine={detail} locked={locked} recovery={recovery} onBack={() => { setDetail(null); setReload(value => value + 1); }} onEdit={() => setEditing(detail)} onRun={() => run(detail)} onToggle={() => toggle(detail)} onDelete={() => void remove(detail)} onWebhook={() => setWebhook(detail)} onOpen={onOpen} /> : <div className="k-page bs-root routines-hub">
      <PageHeader headingRef={heading} title="Routines" description="Scheduled work and event triggers across your local agents." actions={<><Button variant="ghost" onClick={onClose}>Back</Button><IconButton label="Reload routines" onClick={() => { setError(''); setReload(value => value + 1); }}><RefreshCw size={15} aria-hidden /></IconButton><Button disabled={locked || !agents.length} variant="primary" icon={<Plus size={14} aria-hidden />} onClick={() => setEditing(null)}>{agents.some(agent => pendingRoutine(agent.id)) ? 'Resume saving' : 'New routine'}</Button></>} />
      <div className="routine-filters"><Field label="Search routines"><Input type="search" maxLength={80} value={filters.search} onChange={event => filter('search', event.target.value)} placeholder="Search by name" /></Field><Field label="Agent"><Select value={filters.agent} onChange={value => filter('agent', value)} options={[{ value: '', label: 'All agents' }, ...agents.map(agent => ({ value: agent.id, label: agent.name }))]} /></Field><Field label="Status"><Select value={filters.enabled} onChange={value => filter('enabled', value)} options={[{ value: '', label: 'All statuses' }, { value: '1', label: 'Enabled' }, { value: '0', label: 'Disabled' }]} /></Field><Field label="Project"><Select value={filters.project} onChange={value => filter('project', value)} options={[{ value: '', label: 'All projects' }, { value: 'none', label: 'No project' }, ...projects.map(project => ({ value: project.id, label: project.name }))]} /></Field><Field label="Trigger"><Select value={filters.trigger} onChange={value => filter('trigger', value)} options={[{ value: '', label: 'All triggers' }, { value: 'once', label: 'Once' }, { value: 'recurring', label: 'Recurring schedule' }, { value: 'webhook', label: 'Webhook' }, { value: 'manual', label: 'Manual' }, { value: 'script', label: 'Local script' }]} /></Field></div>
      {recovery}
      {!page ? <><span className="sr-only" role="status">Loading routines...</span><SkeletonRows /></> : !page.routines.length ? <EmptyState icon={<CalendarClock size={20} aria-hidden />} title={Object.values(filters).some(Boolean) || after ? 'No matching routines' : 'No routines yet'}>{Object.values(filters).some(Boolean) || after ? <Button onClick={() => { setFilters({ search: '', agent: '', enabled: '', trigger: '', project: '' }); setCursors(['']); }}>Clear filters</Button> : <><p>Create a routine for work you want an agent to repeat.</p><Button disabled={locked || !agents.length} onClick={() => setEditing(null)}>New routine</Button>{!agents.length && <p>Create a local agent first.</p>}</>}</EmptyState> : <div className="k-table-wrap"><table className="k-table routine-table"><thead><tr><th>Routine</th><th>Owner</th><th>Project</th><th>Report to</th><th>Trigger</th><th>Last run</th><th>Next run</th><th>Enabled</th></tr></thead><tbody>{page.routines.map(row => <tr key={row.id}><td><button type="button" className="routine-name k-link" onClick={() => { setNotice(''); setDetail(row); }}>{row.name}</button>{Number(row.flow_agents) > 1 && <Badge>{row.flow_agents} agents</Badge>}</td><td><span className="routine-owner">{owner(row.agent) && <AgentAvatar agent={owner(row.agent)!} size={24} />}<span>{row.owner_name}</span></span></td><td>{row.project_name ?? <span className="k-field__hint">No project</span>}</td><td>{routineReportLabel(row)}</td><td>{routineTriggerLabel(row)}</td><td>{row.last_status && row.last_thread ? <button type="button" className="routine-run k-link" onClick={() => onOpen(row.agent, row.last_thread!)}><span>{runStatus({ status: row.last_status, paused: row.last_paused, no_update: row.last_no_update })}</span><time dateTime={row.last_created!}>{relativeRun(row.last_created!)}</time></button> : <span className="k-field__hint">Never run</span>}</td><td>{row.enabled && row.trigger === 'schedule' ? <time title={new Date(row.next_at).toLocaleString('en-US')} dateTime={new Date(row.next_at).toISOString()}>{relativeRun(row.next_at)}</time> : <span className="k-field__hint">{row.enabled ? 'On demand' : 'Paused'}</span>}</td><td><Switch checked={!!row.enabled} disabled={locked} label={`Enable ${row.name}`} onChange={() => toggle(row)} /></td></tr>)}</tbody></table></div>}
      {(cursors.length > 1 || !!page?.next_after) && <div className="k-pager"><IconButton label="Previous routines" disabled={cursors.length < 2} onClick={() => setCursors(values => values.slice(0, -1))}><ChevronLeft size={16} aria-hidden /></IconButton><IconButton label="Next routines" disabled={!page?.next_after} onClick={() => { if (page?.next_after) setCursors(values => [...values, page.next_after!]); }}><ChevronRight size={16} aria-hidden /></IconButton></div>}
    </div>}
    {editing !== undefined && editingOwner && <RoutineForm key={editing?.id ?? 'new'} owner={editingOwner} agents={agents} projects={projects} routine={editing} onSaved={updated => { setDetail(current => current?.id === updated.id ? { ...current, ...updated } : current); setEditing(undefined); setReload(value => value + 1); }} onBack={() => { setEditing(undefined); setReload(value => value + 1); }} />}
  </>;
}
function RoutineDetail({ routine, locked, recovery, onBack, onEdit, onRun, onToggle, onDelete, onWebhook, onOpen }: { routine: Routine; locked: boolean; recovery: ReactNode; onBack: () => void; onEdit: () => void; onRun: () => void; onToggle: () => void; onDelete: () => void; onWebhook: () => void; onOpen: (owner: string, thread: string) => void }) {
  const [tab, setTab] = useState('overview'), [runs, setRuns] = useState<RoutineRun[] | null>(null), [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const data = await api<RoutineRun[]>(`/api/routines/${routine.id}/runs`); if (!stopped) { setRuns(data); setError(''); } } catch (error) { if (!stopped) setError(message(error)); }
      if (!stopped) timer = setTimeout(refresh, 1200);
    }
    void refresh(); return () => { stopped = true; clearTimeout(timer); };
  }, [routine.id]);
  return <div className="k-page bs-root routine-detail"><PageHeader headingRef={heading} title={routine.name} description={`Owned by ${routine.owner_name ?? 'local agent'}`} actions={<><Button variant="ghost" onClick={onBack}>All routines</Button><Button disabled={locked} icon={<Pencil size={14} aria-hidden />} onClick={onEdit}>Edit routine</Button><Button disabled={locked} icon={routine.enabled ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />} onClick={onToggle}>{routine.enabled ? 'Pause' : 'Resume'}</Button><Button disabled={locked} variant="primary" icon={<Play size={14} aria-hidden />} onClick={onRun}>Run now</Button><ActionMenu label="Routine actions" trigger={<button type="button" className="k-icon-btn" aria-label="Routine actions" disabled={locked}><Ellipsis size={16} aria-hidden /></button>} items={[{ label: 'Delete routine', danger: true, onSelect: onDelete }]} /></>} />
    {recovery}
    <Tabs value={tab} onChange={setTab} label="Routine sections" tabs={[{ value: 'overview', label: 'Overview' }, { value: 'flow', label: 'Flow' }]}>
      <TabPanel value="overview"><div className="k-stack"><Card><Row title="Trigger" meta={routineTriggerLabel(routine)} trailing={<Badge>{routine.enabled ? 'Enabled' : 'Paused'}</Badge>} /><Row title="Project" meta={routine.project_name ?? 'No project'} /><Row title="Report to" meta={routineReportLabel(routine)} /><Row title="Next run" meta={routine.enabled && routine.trigger === 'schedule' ? new Date(routine.next_at).toLocaleString('en-US') : routine.enabled ? 'On demand' : 'Paused'} /><Row title="Last run" meta={routine.last_created ? <>{runStatus({ status: routine.last_status, paused: routine.last_paused, no_update: routine.last_no_update })} · {relativeRun(routine.last_created)}</> : 'Never run'} trailing={routine.last_thread && <Button size="sm" onClick={() => onOpen(routine.agent, routine.last_thread!)}>Open last run</Button>} /><Row title="Flow" meta={Number(routine.flow_agents ?? 1) > 1 ? `${routine.flow_agents} agents` : 'Single agent'} /></Card>
      <Section title="Instructions"><p className="routine-instructions">{routine.prompt}</p></Section>
      <div className="k-row-actions">{routine.trigger === 'webhook' && <Button onClick={onWebhook}>Webhook settings</Button>}<a className="k-link" href={`/api/agents/${routine.agent}/routines/calendar.ics`} download="briefsip-routines.ics">Download agent calendar</a></div>
      <p className="k-field__hint">Run now uses the saved instructions even while paused. Provider usage still counts; the schedule stays unchanged.</p>
      <Section title="Run history">{error && <Alert tone="error">{error}</Alert>}{runs === null ? <SkeletonRows /> : !runs.length ? <EmptyState title="No runs yet">Run this routine to create its first conversation.</EmptyState> : <Card>{runs.map(run => <Row key={run.turn} title={new Date(run.scheduled_at ?? run.created).toLocaleString('en-US')} meta={<><Badge>{runStatus(run)}</Badge><span>{run.source === 'webhook' ? 'Webhook' : run.source === 'script' ? 'Local script' : run.scheduled_at === null ? 'Manual' : 'Schedule'} · {relativeRun(run.created)}</span></>} trailing={<Button size="sm" onClick={() => onOpen(routine.agent, run.thread)}>Open run</Button>}>{run.missed > 0 && <p className="k-field__hint">{run.missed} missed schedules were combined into this run.</p>}{run.error && <Alert tone="error">{run.error}</Alert>}</Row>)}</Card>}</Section>
      <Collapsible title="Local script access"><ScriptAccess key={routine.agent} agent={routine.agent} /></Collapsible>
      </div></TabPanel>
      <TabPanel value="flow"><FlowEditor key={routine.id} routine={routine} onOpen={async (thread, owner) => onOpen(owner, thread)} /></TabPanel>
    </Tabs>
  </div>;
}
function RoutineForm({ owner, agents, projects, routine, onBack, onSaved }: { owner: Agent; agents: Agent[]; projects: import('../local-projects').LocalProject[]; routine: Routine | null; onBack: () => void; onSaved: (routine: Routine) => void }) {
  const [agent, setAgent] = useState(owner);
  const key = `briefsip:routine-command:${agent.id}`;
  const pending = useRef<RoutineCommand | null>(pendingRoutine(owner.id));
  const [initial] = useState(() => pending.current);
  const [blocked, setBlocked] = useState(() => { try { return sessionStorage.getItem(key) !== null && !pending.current; } catch { return true; } });
  const confirm = useConfirm();
  const routineId = initial?.routineId ?? routine?.id ?? null;
  const revision = initial?.data.revision ?? routine?.revision;
  const [conflict, setConflict] = useState(false);
  const snapshot = initial?.data;
  const savedTrigger = snapshot?.trigger ?? routine?.trigger ?? 'schedule';
  const [trigger, setTrigger] = useState<Routine['trigger']>(savedTrigger);
  const [enabled, setEnabled] = useState(snapshot?.enabled ?? (routine ? !!routine.enabled : true));
  const [project,setProject] = useState(snapshot?.project ?? routine?.project ?? null), [reportTo,setReportTo] = useState(snapshot?.reportTo ?? routine?.report_to ?? 'direct');
  const [timing,setTiming] = useState<RoutineTiming | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const [scheduleStart] = useState(snapshot?.nextAt ?? routine?.next_at ?? Date.now() + 3600000);
  const scheduleInitial = snapshot?.schedule ?? routine?.schedule ?? (routine ? routine.interval_ms ? { kind:'legacy_interval' as const,intervalMs:routine.interval_ms,anchorAt:routine.next_at } : { kind:'instant' as const,at:routine.next_at } : null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || conflict || blocked || !pending.current && trigger === 'schedule' && !timing) return;
    const fields = new FormData(event.currentTarget);
    const request: RoutineCommand = pending.current ?? { routineId, data: { id: crypto.randomUUID(), ...(routineId ? { revision } : {}), name: String(fields.get('name')).trim(), prompt: String(fields.get('prompt')).trim(), trigger,
      ...(trigger === 'schedule' && timing ? timing : { nextAt: scheduleStart, intervalSeconds: routine?.interval_ms === null || !routine ? null : routine.interval_ms / 1000 }), project, reportTo, enabled } };
    try { sessionStorage.setItem(key, JSON.stringify(request)); } catch { setError('Save status was not saved in the browser. Check site storage.'); return; }
    pending.current = request; setBusy(true); setError('');
    try {
      const updated = await api<Routine>(request.routineId ? `/api/routines/${request.routineId}/edit` : `/api/agents/${agent.id}/routines`, request.data);
      if (!mounted.current) return;
      if (pendingRoutine(agent.id)?.data.id === request.data.id) sessionStorage.removeItem(key);
      pending.current = null; onSaved(updated);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof HttpError && error.status < 500) { if (pendingRoutine(agent.id)?.data.id === request.data.id) sessionStorage.removeItem(key); pending.current = null; }
      if (error instanceof HttpError && error.status === 409) setConflict(true);
      setError(message(error));
    } finally { if (mounted.current) setBusy(false); }
  }
  return <Dialog open size="lg" onOpenChange={open => { if (!open && !busy) onBack(); }} title={initial?.routineId || routine ? 'Edit routine' : 'New routine'}
    description="Each run opens a separate conversation and can share its result. Briefsip must be running for schedules."
    footer={<><span className="k-dialog__foot-start"><Checkbox checked={enabled} onChange={setEnabled} disabled={!!pending.current || busy || blocked} label="Enabled" /></span><Button disabled={busy} onClick={onBack}>{conflict ? 'Discard changes and reload' : 'Cancel'}</Button><Button type="submit" form="routine-form" variant="primary" busy={busy} disabled={busy || conflict || blocked || !pending.current && trigger === 'schedule' && !timing}>{busy ? 'Saving...' : pending.current ? 'Retry save' : 'Save routine'}</Button></>}>
    <form id="routine-form" className="k-fieldset bs-root" onSubmit={save}>
      {blocked && <Alert tone="error" title="Routine recovery could not be read" actions={<Button onClick={async () => {
        if (!await confirm({ title: 'Discard routine save recovery?', description: 'Check routines and run history first. The previous save may already have succeeded.', confirm: 'Discard recovery', danger: true })) return;
        try { sessionStorage.removeItem(key); setBlocked(false); } catch { setError('Browser storage is unavailable. Check site storage before saving.'); }
      }}>Discard recovery</Button>}>Check saved routines before discarding this request.</Alert>}
      <div className="k-grid-2"><Field label="Owner agent" hint={routineId ? 'The owner cannot change after creation.' : undefined}><Select value={agent.id} disabled={!!routineId || !!pending.current || busy || blocked} onChange={id => { const next = agents.find(item => item.id === id); if (next) {setAgent(next); if(project && !projects.find(item=>item.id===project)?.members.some(member=>member.agent===next.id)) {setProject(null);setReportTo('direct');}} }} options={agents.map(item => ({ value: item.id, label: item.name, disabled: item.id !== agent.id && !!pendingRoutine(item.id) }))} /></Field>
      <Field label="Name"><Input name="name" required maxLength={80} readOnly={!!pending.current} defaultValue={snapshot?.name ?? routine?.name} placeholder="Morning briefing" /></Field></div>
      <Field label="Instructions"><Textarea name="prompt" required maxLength={16000} readOnly={!!pending.current} defaultValue={snapshot?.prompt ?? routine?.prompt} rows={3} placeholder="What should this routine do?" /></Field>
      <Field label="Trigger"><Select value={trigger} disabled={!!pending.current || busy} onChange={value=>setTrigger(value as Routine['trigger'])} options={[{ value: 'schedule', label: 'Schedule' }, { value: 'manual', label: 'Manual' }, { value: 'webhook', label: 'Webhook' }, { value: 'script', label: 'Local script' }]} /></Field>
      {trigger === 'webhook' && <Alert>After saving, open Webhook settings to create a URL and secret. Changing this trigger removes the old URL and secret.</Alert>}
      {trigger === 'script' && <Alert>After saving, allow Local script access in the routine overview. Scripts use the existing server token and this routine's ID.</Alert>}
      <RoutineSchedule initial={scheduleInitial} initialNextAt={scheduleStart} initialInterval={snapshot?.intervalSeconds === undefined ? routine?.interval_ms ?? null : snapshot.intervalSeconds === null ? null : snapshot.intervalSeconds*1000} initialZone={snapshot?.zone ?? routine?.schedule_zone} legacy={!snapshot?.schedule && !routine?.schedule} disabled={!!pending.current || busy || blocked} active={trigger === 'schedule'} onChange={setTiming} />
      <div className="k-grid-2"><Field label="Project" hint="Project runs use its folders and access grants."><Select value={project ?? ''} disabled={!!pending.current || busy || blocked} onChange={value=>{setProject(value || null);setReportTo(value ? 'run' : 'direct');}} options={[{value:'',label:'No project'},...projects.map(item=>({value:item.id,label:item.name,disabled:!item.members.some(member=>member.agent===agent.id),hint:item.members.some(member=>member.agent===agent.id) ? undefined : 'Owner agent must be a member'}))]} /></Field><Field label="Report to" hint="Reports never start replies from other agents."><Select value={reportTo} disabled={!!pending.current || busy || blocked} onChange={setReportTo} options={[{value:'direct',label:"Owner agent's direct chat"},{value:'run',label:"Only in the run's own conversation"},...(projects.find(item=>item.id===project)?.sections.filter(section=>!section.archived).map(section=>({value:section.id,label:`${projects.find(item=>item.id===project)!.name} / # ${section.name}`})) ?? [])]} /></Field></div>
      {routine && <p className="k-field__hint">Disabling or changing a schedule cancels queued runs; runs already in progress continue.</p>}
      {pending.current && <RecoveryAlert inFlight={busy} tone="warn" title="Save is not confirmed yet">Retry the same request to check its result without creating a duplicate routine.</RecoveryAlert>}
      {error && <Alert tone="error">{error}</Alert>}
    </form>
  </Dialog>;
}

function AgentConversations({ agent, configured, onEdit, workflowAgents, initialThread, onOpenAgent, onOpenChannel, onThreadOpened, onManageRoutines }: { onManageRoutines: (agent: string) => void; onOpenChannel: (channel: string) => void; agent: Agent; workflowAgents: Agent[]; configured: boolean; onEdit: () => void; initialThread?: string; onThreadOpened: () => void; onOpenAgent: (owner: string, thread: string) => void }) {
  const [threads, setThreads] = useState<Thread[]>([]), [error, setError] = useState('');
  const storageKey = `briefsip:thread:${agent.id}`;
  const [selected, setSelected] = useState(() => { if (initialThread) return initialThread; try { return sessionStorage.getItem(storageKey) ?? ''; } catch { return ''; } });
  const [form, setForm] = useState<Thread | 'new' | null>(null), [loaded, setLoaded] = useState(false);
  const [showArchived, setShowArchived] = useState(false), [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const commandKey = `briefsip:thread-command:${agent.id}`;
  const [recovery] = useState(() => { try { return { command: restoreThreadCommand(sessionStorage.getItem(commandKey), agent.id), invalid: false }; } catch { return { command: null, invalid: true }; } });
  const [pending, setPending] = useState<ThreadCommand | null>(recovery.command), [invalid, setInvalid] = useState(recovery.invalid);
  const flight = useRef(false), actionFlight = useRef(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const workspaceButton = useRef<HTMLButtonElement>(null);
  const [showWorkflows, setShowWorkflows] = useState(false);
  const loadVersion = useRef(0);
  const navigation = useRef(0);
  const thread = threads.find(item => item.id === selected);
  function select(id: string) { setShowWorkspace(false); setShowWorkflows(false); navigation.current++; loadVersion.current++; setSelected(id); setForm(null); try { sessionStorage.setItem(storageKey, id); } catch { /* Selection remains usable in memory. */ } }
  async function load(preferred = selected, afterSave = false, quiet = false) {
    const version = ++loadVersion.current;
    try {
      const rows = await api<Thread[]>(`/api/agents/${agent.id}/threads`);
      if (version !== loadVersion.current) return;
      const missing = !!preferred && !rows.some(row => row.id === preferred);
      setThreads(rows); setLoaded(true);
      if (!quiet || missing) setError(missing ? 'Conversation is no longer available. Main chat opened.' : '');
      if (missing || afterSave) select(missing ? '' : preferred);
    }
    catch (error) { if (!afterSave && !quiet && version === loadVersion.current) setError(message(error)); throw new Error(message(error)); }
  }
  useEffect(() => {
    void load().catch(() => {});
    return () => { navigation.current++; loadVersion.current++; };
  }, []);
  useEffect(() => { if (busy || pending || invalid) return; const timer = setInterval(() => { void load(selected, false, true).catch(() => {}); }, 5000); return () => clearInterval(timer); }, [selected, busy, pending, invalid]);
  useEffect(() => { if (initialThread !== undefined) { onThreadOpened(); void load(initialThread, true).catch(() => {}); } }, [initialThread]);
  const leave = () => { navigation.current++; loadVersion.current++; };
  const openForm = () => { leave(); setShowWorkspace(false); setShowWorkflows(false); setForm('new'); };
  const openRoutines = () => { leave(); onManageRoutines(agent.id); };
  const openWorkflows = () => { leave(); setShowWorkspace(false); setShowWorkflows(true); };
  const openWorkspace = () => { leave(); setShowWorkflows(false); setForm(null); setShowWorkspace(true); };
  const errorBanner = error && <p className="error" role="alert">{error} <button className="secondary" onClick={() => void load().catch(() => {})}>Reload conversation</button></p>;
  if (showWorkspace) return <PageView>{errorBanner}<Suspense fallback={<p className="empty" role="status">Loading workspace files...</p>}><WorkspacePanel key={agent.id} agent={agent} request={api} onClose={() => { setShowWorkspace(false); requestAnimationFrame(() => workspaceButton.current?.focus()); }} /></Suspense></PageView>;
  if (showWorkflows) return <PageView wide>{errorBanner}<Suspense fallback={<p className="empty" role="status">Loading workflows...</p>}><WorkflowPanel owner={agent} agents={workflowAgents} request={api} onNavigate={leave} onBack={() => { leave(); setShowWorkflows(false); }} renderConversation={(id, owner) => <WorkflowConversation key={id} agent={workflowAgents.find(item => item.id === owner)} threadId={id} configured={configured} onOpenAgent={onOpenAgent} onOpenChannel={onOpenChannel} />} /></Suspense></PageView>;

  if (!loaded) return <PageView>{errorBanner}<p className="empty" role="status">Loading conversation...</p></PageView>;
  const locked = busy || !!pending || invalid;
  async function execute(command: ThreadCommand) {
    if (flight.current || invalid) return;
    flight.current = true; setBusy(true); setError('');
    const version = navigation.current;
    try {
      sessionStorage.setItem(commandKey, JSON.stringify(command)); setPending(command);
      const result = await api<Thread>(command.path, command.data);
      sessionStorage.removeItem(commandKey); setPending(null); setForm(null);
      if (version === navigation.current) {
        const hidden = result.deleted || result.archived && !showArchived;
        await load(command.path === `/api/agents/${agent.id}/threads` ? result.id : selected === result.id && hidden ? '' : selected, true);
        requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-conversation-id="${hidden ? 'main' : result.id}"] > button`)?.focus());
      }
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) { sessionStorage.removeItem(commandKey); setPending(null); }
      setError(message(error));
    } finally { flight.current = false; setBusy(false); }
  }
  async function change(item: Thread, action: 'archive' | 'restore' | 'delete') {
    if (locked || actionFlight.current) return;
    actionFlight.current = true; setBusy(true);
    const version = navigation.current;
    try {
      if (action === 'delete') {
        const rows = await api<Thread[]>(`/api/agents/${agent.id}/threads`);
        if (version !== navigation.current) return;
        const latest = rows.find(row => row.id === item.id);
        if (!latest) { await load('', true); return; }
        item = latest;
        if (item.active) { await confirm({ title: 'Stop work first', description: 'This conversation has running or queued work. Open it and stop unfinished turns before deleting it.', confirm: 'Got it' }); return; }
      }
      if (action !== 'restore' && !await confirm({ title: `${action === 'delete' ? 'Delete' : 'Archive'} conversation?`, description: action === 'delete' ? `“${item.name}” and its history will no longer be available. This cannot be undone.` : `“${item.name}” will be hidden. History stays saved; use Show archived to restore it. Unfinished work will be stopped. Earlier requests may still be billed.`, confirm: action === 'delete' ? 'Delete conversation' : 'Archive conversation', danger: true })) return;
      if (version !== navigation.current) return;
      await execute({ path: `/api/threads/${item.id}/${action === 'delete' ? 'delete' : 'edit'}`, data: { id: crypto.randomUUID(), revision: item.revision, ...(action === 'delete' ? {} : { name: item.name, archived: action === 'archive' }) } });
    } catch (error) { if (version === navigation.current) setError(message(error)); }
    finally { actionFlight.current = false; setBusy(false); }
  }
  async function reloadForm() {
    const current = form, version = navigation.current;
    if (!current || current === 'new' || locked) return;
    try { const rows = await api<Thread[]>(`/api/agents/${agent.id}/threads`); if (version !== navigation.current) return; const latest = rows.find(row => row.id === current.id); if (!latest) throw new Error('Conversation is no longer available. Close this dialog and reload conversations.'); setForm(latest); setError(''); }
    catch (error) { setError(message(error)); }
  }

  const actions = (item: Thread): MenuItem[] => [
    { label: 'Rename', disabled: locked, onSelect: () => setForm(item) },
    { label: item.archived ? 'Restore' : 'Archive', disabled: locked, onSelect: () => void change(item, item.archived ? 'restore' : 'archive') },
    { label: 'Delete', danger: true, disabled: locked, onSelect: () => void change(item, 'delete') },
  ];
  const row = (item: Thread) => <div data-conversation-id={item.id} key={item.id} className={`conversation-row${selected === item.id ? ' is-current' : ''}`}>
    <button type="button" className="panel-row panel-row--link" aria-current={selected === item.id || undefined} title={item.name} onClick={() => select(item.id)}><MessageSquare size={16} aria-hidden /><span className="panel-row__text"><span className="panel-row__title">{item.name}</span>{!!item.archived && <span className="panel-row__meta">Archived</span>}</span></button>
    <ActionMenu label={`Menu conversation ${item.name}`} trigger={<button type="button" className="k-icon-btn" aria-label={`Menu conversation ${item.name}`} disabled={locked}><Ellipsis size={15} aria-hidden /></button>} items={actions(item)} />
  </div>;
  const visible = threads.filter(item => showArchived || !item.archived), deliveries = visible.filter(item => item.delivery);
  const conversations = <>
    {error && <Alert tone="error" actions={<Button size="sm" disabled={busy} onClick={() => void load().catch(() => {})}>Reload conversations</Button>}>{error}</Alert>}
    {(pending || invalid) && <RecoveryAlert inFlight={busy} tone="warn" title={invalid ? 'Conversation recovery is unavailable' : 'Conversation change is not confirmed'} actions={<>{pending && <Button size="sm" busy={busy} onClick={() => void execute(pending)}>Retry change</Button>}<Button size="sm" disabled={busy} onClick={async () => { if (await confirm({ title: 'Discard pending change?', description: 'Check conversations first. The change may already have been saved.', confirm: 'Discard', danger: true })) { try { sessionStorage.removeItem(commandKey); setPending(null); setInvalid(false); } catch { setError('Recovery could not be cleared. Check browser storage.'); } } }}>Discard</Button></>} />}
    <section aria-label="Agent conversations">
      <div className="section-label section-label--row"><span>Conversations</span><button type="button" className="link-btn link-btn--small" disabled={locked} onClick={openForm}>New conversation</button></div>
      <div className="panel-card">
        <div className="conversation-row" data-conversation-id="main"><button type="button" className={`panel-row panel-row--link${!thread ? ' is-current' : ''}`} aria-current={!thread || undefined} onClick={() => select('')}><MessageSquare size={16} aria-hidden /><span className="panel-row__title">Main chat</span></button><ActionMenu label="Menu conversation Main chat" trigger={<button type="button" className="k-icon-btn" aria-label="Menu conversation Main chat"><Ellipsis size={15} aria-hidden /></button>} items={[{ label: 'Edit profile', onSelect: onEdit }]} /></div>
        {visible.filter(item => !item.delivery).map(row)}
      </div>
      {!!threads.some(item => item.delivery) && <Collapsible variant="section" title={<>From other agents <Badge>{deliveries.length}</Badge></>}><div className="panel-card">{deliveries.length ? deliveries.map(row) : <p className="panel-empty">No active agent conversations.</p>}</div></Collapsible>}
      <Checkbox checked={showArchived} onChange={next => { setShowArchived(next); if (!next && thread?.archived) select(''); }} label="Show archived" />
    </section>
  </>;
  const activity = <><UpcomingRoutines agent={agent.id} onManage={openRoutines} /><Collapsible variant="section" title="Automation"><div className="panel-card"><button type="button" className="panel-row panel-row--action" onClick={openWorkflows}><WorkflowIcon size={16} aria-hidden /> Workflows</button></div></Collapsible></>;
  const library = agent.workspace_connected && <section aria-label="Workspace library"><div className="section-label">Workspace</div><div className="panel-card"><button ref={workspaceButton} type="button" className="panel-row panel-row--action" onClick={openWorkspace}><FolderOpen size={16} aria-hidden /> Workspace files</button></div></section>;
  return <><Chat onOpenChannel={onOpenChannel} onOpenAgent={onOpenAgent} key={thread?.id ?? agent.id} agent={agent} thread={thread} configured={(agent.runtime && agent.runtime !== 'api' ? agent.provider_available === true : configured && agent.provider_available !== false)}
    onEdit={thread ? () => setForm(thread) : onEdit}
    menuItems={[...(thread ? actions(thread) : []), { label: 'New conversation', onSelect: openForm, disabled: locked }, { label: 'Routines', onSelect: openRoutines }, { label: 'Workflows', onSelect: openWorkflows }, { label: 'Workspace files', onSelect: openWorkspace }]}
    detailsExtra={{ chats: conversations, activity, library }} />{form && <ThreadForm key={form === 'new' ? 'new' : `${form.id}:${form.revision}`} agent={agent} thread={form === 'new' ? undefined : form} busy={busy} locked={!!pending || invalid} onCancel={() => setForm(null)} onSave={command => void execute(command)} error={error} pending={pending} onRetry={() => pending && void execute(pending)} onReload={() => void reloadForm()} />}</>;
}

function ThreadForm({ agent, thread, busy, locked, onCancel, onSave, error, pending, onRetry, onReload }: { onReload: () => void; error: string; pending: ThreadCommand | null; onRetry: () => void; agent: Agent; thread?: Thread; busy: boolean; locked: boolean; onCancel: () => void; onSave: (command: ThreadCommand) => void }) {
  return <Dialog open onOpenChange={next => { if (!next && !busy) onCancel(); }} title={thread ? 'Rename conversation' : 'New side thread'} description={`Agent ${agent.name}, with history and a queue separate from the main chat.`}
    footer={<><Button onClick={onCancel} disabled={busy}>Cancel</Button><Button type="submit" form="thread-form" variant="primary" busy={busy} disabled={locked}>{thread ? 'Save conversation' : 'Create conversation'}</Button></>}>
    <form id="thread-form" className="k-fieldset bs-root" onSubmit={event => { event.preventDefault(); if (busy || locked) return; const name = String(new FormData(event.currentTarget).get('name')).trim(); if (!name) return; onSave({ path: thread ? `/api/threads/${thread.id}/edit` : `/api/agents/${agent.id}/threads`, data: { id: crypto.randomUUID(), name, ...(thread ? { revision: thread.revision, archived: !!thread.archived } : {}) } }); }}>
      <Field label="Conversation name"><Input name="name" required maxLength={80} defaultValue={thread?.name} readOnly={locked} autoFocus /></Field>
      {error && <Alert tone="error" actions={thread && !pending && <Button size="sm" disabled={busy} onClick={onReload}>Reload settings</Button>}>{error}</Alert>}{pending && <RecoveryAlert inFlight={busy} tone="warn" title="Change is not confirmed" actions={<Button size="sm" busy={busy} onClick={onRetry}>Retry change</Button>}>Retry keeps the same request ID.</RecoveryAlert>}
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
    const data = pending.current ?? { id: crypto.randomUUID(), ...(profile ? { revision: profile.revision } : setup ? { setup: true } : {}), providerAccount: account, name: String(form.get('name')).trim() || (setup ? 'New agent' : ''), role: String(form.get('role')).trim(), model: String(form.get('model')).trim(), backupModel: String(form.get('backupModel')).trim(), instructions: String(form.get('instructions')).trim(), threadLimit: Number(form.get('threadLimit')), toolBudget: Number(form.get('toolBudget')) };
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
    {!profile && pending.current && <RecoveryAlert inFlight={busy} tone="warn" title="Creation is not confirmed yet">Try again with the same request to avoid creating a duplicate agent.</RecoveryAlert>}
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
      <Field label="Role" optional hint="Shown under the agent's name, e.g. Orchestration agent">
        <Input name="role" maxLength={60} readOnly={locked} defaultValue={profile?.role ?? recovery.command?.role ?? ''} />
      </Field>
      <Field label="Runtime" hint={profile ? 'Coding runtimes use the host login and the current project folder. Direct chats need a host workspace binding. Steer restarts the running turn; image attachments are unavailable.' : 'Create the agent, add it to a project, then choose a coding runtime.'} error={runtimeError}>
        <Select label="Runtime" value={runtime} onChange={value => setRuntime(value as typeof runtime)} disabled={locked || busy} options={[{ value: 'api', label: 'API model' }, ...(['codex','claude'] as const).map(value => { const choice = runtimeChoices.find(item => item.runtime === value); return { value, label: value === 'codex' ? 'Codex' : 'Claude Code', disabled: !choice?.enabled, hint: choice?.reason ?? choice?.version ?? 'Add this agent to a project first.' }; })]} />
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
          <Field label="Tool steps per task" hint={runtime === 'api' ? '10-200 steps. Stops with a summary; reply “continue” for more.' : 'Saved for API tasks. Coding runtimes manage their own steps.'}>
            <Input name="toolBudget" type="number" min={10} max={200} step={1} required readOnly={locked || runtime !== 'api'} defaultValue={profile?.tool_budget ?? recovery.command?.toolBudget ?? 90} />
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
  return <Dialog open onOpenChange={next => { if (!next && !busy) onCancel(); }} title={channel ? 'Channel settings' : 'New channel'} description="Bring agents into one conversation. Everyone can contribute, or you can address someone with @mentions."
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
    {pending && <RecoveryAlert inFlight={busy} tone="warn" title="Request result is not confirmed yet">Try the same request to check the result without creating a duplicate channel.</RecoveryAlert>}
    <form id="channel-form" className="k-fieldset bs-root" onSubmit={create}>
      <Field label="Channel name"><Input ref={nameInput} name="name" required maxLength={80} readOnly={locked} value={name} onChange={event => setName(event.target.value)} autoFocus /></Field>
      <Field label="Purpose"><Textarea name="instructions" required maxLength={8000} rows={3} readOnly={locked} value={instructions} onChange={event => setInstructions(event.target.value)} /></Field>
      <fieldset disabled={locked} className="k-fieldset"><legend className="k-field__label">Members</legend>{agents.map(agent => <Checkbox key={agent.id} label={agent.name} disabled={locked} checked={members.includes(agent.id)} onChange={checked => { setMembers(checked ? [...members, agent.id] : members.filter(id => id !== agent.id)); if (!checked && lead === agent.id) setLead(''); }} />)}</fieldset>
      <Field label="Lead" hint="Optional. Gives a short reply when everyone stays quiet."><Select value={lead} disabled={locked} onChange={setLead} options={[{ value: '', label: 'No lead' }, ...agents.filter(agent => members.includes(agent.id)).map(agent => ({ value: agent.id, label: agent.name }))]} /></Field>
      {channel && archived !== !!channel.archived && <Alert>{archived ? 'Channel will be archived and unfinished work cancelled when you save changes.' : 'Channel will be restored when you save changes.'}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
    </form>
  </Dialog>;
}


type SettingsSection = 'updates' | 'machines' | 'connected-apps' | 'skills' | 'mcp' | 'mcp-server' | 'data' | 'usage' | 'backup' | 'import' | 'help' | 'appearance';
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
  { id: 'appearance', label: 'Appearance' },
  { id: 'help', label: 'Help' },
];
type Dialog = 'agent' | 'project' | 'edit' | null;
const collapsedKey = 'briefsip:sidebar-collapsed';
const machineGroupsKey = 'briefsip:sidebar-machine-groups';
const sidebarTabKey = 'briefsip:sidebar-tab';
type SidebarTab = 'agents' | 'projects';
const machineStatus = { online: 'Online', offline: 'Offline', unauthorized: 'Unauthorized', 'version-mismatch': 'Version mismatch' };

function MachineGroup({ name, subtitle, count, status, expanded, onExpandedChange, local, children }: {
  name: string; subtitle?: string; count: number; status?: keyof typeof machineStatus; expanded: boolean;
  onExpandedChange: (expanded: boolean) => void; local?: boolean; children: ReactNode;
}) {
  return <Disclosure.Root className="machine-group" open={expanded} onOpenChange={onExpandedChange}>
    <Disclosure.Trigger className="machine-group__header" title={subtitle}>
      <ChevronRight className="machine-group__chevron" size={14} aria-hidden />{local ? <Monitor size={15} aria-hidden /> : <Server size={15} aria-hidden />}
      <span className="machine-group__name">{name}</span><span className="machine-group__count" aria-label={`${count} agents`}>{count}</span>
      {status && <span className={`machine-dot is-${status}`} role="img" aria-label={machineStatus[status]} title={machineStatus[status]} />}
    </Disclosure.Trigger>
    <Disclosure.Content className="machine-group__content" role="group" aria-label={`${name} contents`}>{children}</Disclosure.Content>
  </Disclosure.Root>;
}


function App() {
  const [directory, setDirectory] = useState<Directory | null>(null); const [selected, setSelected] = useState('');
  const [channels, setChannels] = useState<Channel[]>([]), [selectedChannel, setSelectedChannel] = useState('');
  const [environment, setEnvironment] = useState<Environment | null>(null), [summaries, setSummaries] = useState<SidebarSummary[]>([]);
  const [routineAgent, setRoutineAgent] = useState('');
  const [view, setView] = useState<'chat' | 'routines' | 'workflows' | 'remote'>('chat');
  const remoteMachinesState = useMachines(api);
  const updateAvailable = useUpdateBadge(api);
  const [remoteSelection, setRemoteSelection] = useState<{ machine: string; agent: string } | null>(null);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const projectState = useProjects(api);
  const [selectedProject, setSelectedProject] = useState('');
  const [projectThread, setProjectThread] = useState<{project:string;thread:string;agent:string;conversation?:Thread & {folder?:string}} | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notificationsMuted, setNotificationsMuted] = useState(() => { try { return localStorage.getItem('briefsip:workflow-notifications-muted') === '1'; } catch { return false; } });
  const [notificationError, setNotificationError] = useState('');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(() => { try { return localStorage.getItem(sidebarTabKey) === 'projects' ? 'projects' : 'agents'; } catch { return 'agents'; } });
  const [searches, setSearches] = useState({ agents: '', projects: '' });
  const search = searches[sidebarTab], query = search.trim().toLocaleLowerCase();
  const [searchMachineGroups, setSearchMachineGroups] = useState<Record<string, boolean>>({});
  const [onlyOnline, setOnlyOnline] = useState(false), [showHidden, setShowHidden] = useState(false), [filterMenu, setFilterMenu] = useState(false);
  const [machineGroups, setMachineGroups] = useState<Record<string, boolean>>(() => { try { const value: unknown = JSON.parse(localStorage.getItem(machineGroupsKey) ?? '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, expanded]) => typeof expanded === 'boolean')) as Record<string, boolean> : {}; } catch { return {}; } });
  const [collapsed, setCollapsedState] = useState(() => { try { return localStorage.getItem(collapsedKey) === '1'; } catch { return false; } });
  const sidebar = useResizablePanel(sidebarPanel);
  const [openedThread, setOpenedThread] = useState<{ agent: string; thread: string } | null>(null);
  const [activityError, setActivityError] = useState(false);
  const [editReload, setEditReload] = useState(0);
  const [error, setError] = useState('');
  const directoryRequest = useRef(0);
  function setCollapsed(value: boolean) { setCollapsedState(value); try { localStorage.setItem(collapsedKey, value ? '1' : '0'); } catch { /* Applies to this page only. */ } }
  function setMachineExpanded(key: string, expanded: boolean) { if (query) { setSearchMachineGroups(current => ({ ...current, [key]: expanded })); return; } setMachineGroups(current => { const next = { ...current, [key]: expanded }; try { localStorage.setItem(machineGroupsKey, JSON.stringify(next)); } catch { /* Applies to this page only. */ } return next; }); }
  useEffect(() => { setSearchMachineGroups({}); }, [search, sidebarTab]);
  useEffect(() => { try { localStorage.setItem(sidebarTabKey, sidebarTab); } catch { /* Keep tabs usable without storage. */ } }, [sidebarTab]);
  async function load(propagate = false) {
    const version = ++directoryRequest.current;
    try { const [data, rooms, local, summary] = await Promise.all([api<Directory>('/api/agents'), api<Channel[]>('/api/channels'), api<Environment>('/api/environment'), api<{ summaries: SidebarSummary[] }>('/api/sidebar/summary')]); if (version !== directoryRequest.current) return; directoryRequest.current++; setDirectory(data); setChannels(rooms); setEnvironment(local); setSummaries(summary.summaries); setSelected(id => id || data.agents[0]?.id || ''); setError(''); }
    catch (error) { if (version === directoryRequest.current) setError(message(error)); if (propagate) throw error; }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refreshActivity() {
      try {
        const version = directoryRequest.current;
        const [rooms, agents, summary] = await Promise.all([api<Channel[]>('/api/channels'), api<Directory>('/api/agents'), api<{ summaries: SidebarSummary[] }>('/api/sidebar/summary')]);
        if (!stopped && version === directoryRequest.current) setDirectory(current => current && ({ ...current, agents: current.agents.map(agent => { const fresh = agents.agents.find(item => item.id === agent.id); return fresh && fresh.revision >= agent.revision ? fresh : agent; }) }));
        if (!stopped) { setActivityError(false); setChannels(current => rooms.map(fresh => { const old=current.find(room=>room.id===fresh.id); return {...fresh, activity:Math.max(old?.activity??0,fresh.activity), read_position:Math.max(old?.read_position??0,fresh.read_position)}; })); }
        if (!stopped) { setSummaries(summary.summaries); void projectState.reload().catch(() => {}); }
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
      else if (name === '1' || name === '2') { if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return; event.preventDefault(); setSidebarTab(name === '1' ? 'agents' : 'projects'); }
      else if (name === ',') { event.preventDefault(); setSettings(current => current ?? 'skills'); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  async function markRead(room: Channel) {
    const updated = await api<Channel>(`/api/channels/${room.id}/read`, { id: crypto.randomUUID(), position: room.activity });
    setChannels(current => current.map(item => item.id === room.id ? { ...item, activity: Math.max(item.activity, updated.activity), read_position: Math.max(item.read_position, updated.read_position) } : item));
    await projectState.reload();
  }
  const agent = directory?.agents.find(agent => agent.id === selected);
  const storedChannel = channels.find(channel => channel.id === selectedChannel);
  const sectionProject = projectState.projects.find(project => project.id === storedChannel?.project);
  const section = sectionProject?.sections.find(section => section.id === selectedChannel);
  const channel = storedChannel && section && sectionProject ? {...storedChannel, name: `${sectionProject.name} / # ${section.name}`} : storedChannel;
  const project = projectState.projects.find(item => item.id === selectedProject);
  const threadNavigation = useRef(0);
  const openProject = (id: string) => { threadNavigation.current++; setSidebarTab('projects'); setSelectedProject(id); setProjectThread(null); setView('chat'); setDialog(null); setSelectedChannel(''); };
  const openAgent = (id: string) => { threadNavigation.current++; setSidebarTab('agents'); setSelectedProject(''); setProjectThread(null); setView('chat'); setOpenedThread(null); setSelected(id); setSelectedChannel(''); setDialog(null); };
  const openChannel = (id: string) => { threadNavigation.current++; setSelectedProject(''); setProjectThread(null); setView('chat'); setSelectedChannel(id); setDialog(null); };
  const openSection = (id: string) => { setSidebarTab('projects'); openChannel(id); void load(); };
  const openThread = (owner: string, thread: string) => {
    const navigation = ++threadNavigation.current;
    if(owner.includes('@')){const [agent,machine]=owner.split('@');setSelectedProject('');setProjectThread(null);setRemoteSelection({machine,agent});setView('remote');setDialog(null);setSettings(null);return;}
    if (!thread) { setSelectedProject(''); setProjectThread(null); setOpenedThread({ agent: owner, thread: '' }); setSelected(owner); setSelectedChannel(''); setView('chat'); setDialog(null); setSettings(null); return; }
    void api<Thread & {project?:string;folder?:string}>(`/api/threads/${thread}`).then(conversation => {
      if (navigation !== threadNavigation.current) return;
      setSelectedProject(''); setProjectThread(conversation.project ? {project:conversation.project,agent:owner,thread,conversation} : null);
      setOpenedThread(conversation.project ? null : {agent:owner,thread}); setSelected(owner); setSelectedChannel(''); setView('chat'); setDialog(null); setSettings(null);
    }).catch(error => { if (navigation === threadNavigation.current) setError(message(error)); });
  };
  const relativeTime = (value: string | null | undefined) => { if (!value) return ''; const age = Math.max(0, Date.now() - Date.parse(value)); if (!Number.isFinite(age)) return ''; const minutes = Math.floor(age / 60000); if (minutes < 60) return `${Math.max(1, minutes)}m`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h`; return `${Math.floor(hours / 24)}d`; };
  const summaryByAgent = new Map(summaries.map(item => [item.agent, item]));
  const summaryFor = (id: string) => summaryByAgent.get(id);
  const matches = (name: string, preview = '', role = '') => !query || `${name} ${role} ${preview}`.toLocaleLowerCase().includes(query);
  const localAgents = (directory?.agents ?? []).filter(item => showHidden || !item.hidden).filter(item => matches(item.name, summaryFor(item.id)?.preview, item.role));
  const agentRow = (id: string) => {
    const item = directory?.agents.find(agent => agent.id === id);
    if (!item) return null;
    const current = view === 'chat' && !selectedProject && !projectThread && !selectedChannel && item.id === selected, summary = summaryFor(item.id);
    return collapsed
      ? <button key={item.id} type="button" className={`bot-rail-item${current ? ' is-selected' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => openAgent(item.id)} title={item.name} aria-label={item.name}><AgentAvatar agent={item} size={36} /></button>
      : <button key={item.id} type="button" className={`bot-row${current ? ' is-selected' : ''}`} aria-label={`${item.name} ${summary?.status === 'running' ? 'Working' : 'Idle'}${item.computer_waiting ? ' - Waiting for you' : ''}${item.provider_available === false ? ' - Provider account unavailable' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => openAgent(item.id)}>
        <span className="bot-row__avatar"><AgentAvatar agent={item} size={36} /><span className={`status-dot ${summary?.status === 'running' ? 'is-working' : 'is-idle'}`} role="img" aria-label={summary?.status === 'running' ? 'Working' : 'Idle'} />{item.computer_waiting && <span className="status-dot is-attention" aria-label="Waiting for you" />}{item.provider_available === false && <span className="status-dot is-attention" aria-label="Provider account unavailable" />}</span>
        <span className="bot-row__text"><span className="bot-row__name">{item.name}{item.computer_waiting && <small> · Waiting for you</small>}</span><span className="bot-row__preview" title={plainPreview(summary?.preview) || undefined}>{item.hidden ? 'Hidden' : item.role || plainPreview(summary?.preview) || 'No role yet'}</span></span>{summary?.time && <time className="bot-row__time" dateTime={summary.time}>{relativeTime(summary.time)}</time>}
      </button>;
  };
  const remoteMachines = remoteMachinesState.machines.filter(machine => !onlyOnline || machine.status === 'online').sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  let content: ReactNode;
  if (error) content = <PageView><div className="empty"><h1>Workspace is not open</h1><p role="alert">{error}</p><button onClick={() => void load()}>Try again</button></div></PageView>;
  else if (!directory) content = <main className="chat chat--empty bs-root"><p className="empty-chat__sub" role="status">Loading workspace...</p></main>;
  else if (view === 'remote') { const machine = remoteMachinesState.machines.find(item => item.id === remoteSelection?.machine); content = <RemoteAgentDetail key={`${machine?.id}:${remoteSelection?.agent}`} request={api} machine={machine} agent={machine?.agents.find(item => item.id === remoteSelection?.agent)} />; }
  else if (view === 'workflows') content = <PageView wide><Suspense fallback={<p className="empty" role="status">Loading workflow directory...</p>}><WorkflowDirectory agents={directory.agents} request={api} onClose={() => setView('chat')} renderConversation={(id, owner) => <WorkflowConversation key={id} agent={directory.agents.find(item => item.id === owner)} threadId={id} configured={directory.configured} onOpenAgent={openThread} onOpenChannel={openChannel} />} /></Suspense></PageView>;
  else if (view === 'routines') content = <PageView wide><RoutinesHub key={routineAgent} initialAgent={routineAgent} agents={directory.agents.filter(agent => !agent.hidden)} projects={projectState.projects} onClose={() => setView('chat')} onOpen={openThread} /></PageView>;
  else if (project) content = <PageView wide><ProjectHome project={project} agents={directory.agents} state={projectState} request={api} onChat={id => { void load(true).then(() => openChannel(id)); }} onThread={(agent,thread) => { setProjectThread({project:project.id,agent,thread}); setSelectedProject(''); }} onDeleted={() => { setSelectedProject(''); void load(); }} /></PageView>;
  else if (projectThread && directory.agents.find(agent => agent.id === projectThread.agent)) { const owner = directory.agents.find(agent => agent.id === projectThread.agent)!; const thread = projectState.projects.find(project => project.id === projectThread.project)?.threads.find(thread => thread.id === projectThread.thread) ?? projectThread.conversation; content = thread ? <Chat key={thread.id} sourceControl={thread.folder ? <ProjectSourceControl project={projectThread.project} folder={thread.folder} request={api}/> : undefined} agent={owner} thread={{...thread,revision:1,archived:0,deleted:0}} configured={directory.configured} menuItems={[{label:'Back to project',onSelect:()=>openProject(projectThread.project)}]} /> : <PageView><EmptyState title="Project thread unavailable" /></PageView>; }
  else if (channel) content = <Chat onOpenAgent={openThread} key={`channel:${channel.id}`} agent={channel} channel={{ ...channel, lead: directory.agents.find(agent => agent.id === channel.lead)?.hidden ? null : channel.lead }} onRead={() => markRead(channel)} members={directory.agents.filter(agent => channel.members.includes(agent.id) && !agent.hidden)} onEdit={channel.project ? undefined : () => setDialog('edit')} menuItems={channel.project ? [{label:'Back to project',onSelect:()=>openProject(channel.project!)}] : []} configured={directory.configured} />;
  else if (agent) content = <AgentConversations onManageRoutines={id => { setRoutineAgent(id); setView('routines'); }} onOpenChannel={openChannel} key={agent.id} agent={agent} workflowAgents={directory.agents} configured={directory.configured} initialThread={openedThread?.agent === agent.id ? openedThread.thread : undefined} onThreadOpened={() => setOpenedThread(null)} onOpenAgent={openThread} onEdit={() => setDialog('edit')} />;
  else content = <main className="chat chat--empty bs-root"><div className="empty-chat"><div className="empty-chat__title">Create your first agent</div><div className="empty-chat__sub">Name it, choose a model, then explain how it should work. The agent and its history are saved on this computer.</div><button type="button" className="btn btn--primary" onClick={() => setDialog('agent')}><Plus size={16} aria-hidden /> New agent</button><HowBriefsipWorks action={<Button variant="ghost" onClick={() => setSettings('help')}>Read quick guide</Button>} /></div></main>;
  const created = (item: Agent) => { setDirectory(current => current && { ...current, agents: [...current.agents.filter(agent => agent.id !== item.id), item] }); openAgent(item.id); };
  return <RadixDialog.Root modal open={!!settings} onOpenChange={open => setSettings(current => open ? current ?? 'skills' : null)}><div className={`app bs-root${collapsed ? ' is-sidebar-collapsed' : ''}`}>
    {collapsed && <button type="button" className="icon-btn icon-btn--bordered sidebar-reveal" onClick={() => setCollapsed(false)} aria-label="Expand sidebar" title="Sidebar (Ctrl/Cmd+B)"><PanelLeft size={16} aria-hidden /></button>}
    {!collapsed && <aside className="sidebar" style={{ width: `${sidebar.width}px` }} aria-label="Workspace navigation">
      <div className="sidebar__titlebar">
        <span className="sidebar__bots-label">Bots</span>
        <nav className="sidebar__controls" aria-label="Automation">
          <IconButton label="Routines" aria-current={view === 'routines' ? 'page' : undefined} disabled={!directory} onClick={() => { setRoutineAgent(''); setView('routines'); setDialog(null); }}><CalendarClock size={16} aria-hidden /></IconButton>
          <IconButton label="Workflows" aria-current={view === 'workflows' ? 'page' : undefined} disabled={!directory} onClick={() => { setView('workflows'); setDialog(null); }}><WorkflowIcon size={16} aria-hidden /></IconButton>
          <ActionMenu label="Create new" trigger={<IconButton label="Create new"><Plus size={16} aria-hidden /></IconButton>} items={[
            { label: 'New agent', onSelect: () => setDialog('agent'), disabled: !directory },
            { label: 'New project', onSelect: () => setDialog('project'), disabled: !directory },
            { label: 'Add a machine', onSelect: () => setSettings('machines') },
          ]} />
          <IconButton label="Collapse sidebar" aria-keyshortcuts="Control+b Meta+b" onClick={() => setCollapsed(true)}><PanelLeft size={16} aria-hidden /></IconButton>
        </nav>
      </div>
      <div className="sidebar__tabs">
      <Tabs<SidebarTab> label="Sidebar" value={sidebarTab} onChange={setSidebarTab} tabs={[
        { value: 'agents', label: 'Agents', count: (directory?.agents ?? []).filter(item => showHidden || !item.hidden).length + remoteMachinesState.machines.reduce((count, machine) => count + machine.agents.length, 0) },
        { value: 'projects', label: 'Projects', count: projectState.projects.length },
      ]}>
      <div className="sidebar__search">
        <Search size={15} aria-hidden /><Input aria-label={sidebarTab === 'agents' ? 'Search agents' : 'Search projects'} placeholder={sidebarTab === 'agents' ? 'Search agents' : 'Search projects'} value={search} onChange={event => setSearches(current => ({ ...current, [sidebarTab]: event.target.value }))} />
        {sidebarTab === 'agents' && <DropdownMenu.Root open={filterMenu} onOpenChange={setFilterMenu}>
          <DropdownMenu.Trigger asChild><IconButton label="Filter sidebar" aria-pressed={onlyOnline || showHidden}><Filter size={15} aria-hidden /></IconButton></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content className="k-pop k-menu" align="end" sideOffset={6}>
            <DropdownMenu.CheckboxItem className="k-menu__item" checked={onlyOnline} onCheckedChange={setOnlyOnline}><DropdownMenu.ItemIndicator><Check size={14} aria-hidden /></DropdownMenu.ItemIndicator>Only online</DropdownMenu.CheckboxItem>
            <DropdownMenu.CheckboxItem className="k-menu__item" checked={showHidden} onCheckedChange={setShowHidden}><DropdownMenu.ItemIndicator><Check size={14} aria-hidden /></DropdownMenu.ItemIndicator>Show hidden</DropdownMenu.CheckboxItem>
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>}
      </div>
      <div className="sidebar__scroll">
        <TabPanel value="agents">
        <nav className="machine-groups" aria-label="Machines">
        <MachineGroup name="This device" subtitle={environment?.name} count={(directory?.agents ?? []).filter(item => showHidden || !item.hidden).length} expanded={query ? searchMachineGroups.local !== false : machineGroups.local !== false} onExpandedChange={expanded => setMachineExpanded('local', expanded)} local>
          <div className="bot-list sidebar-agents">
            <nav className="bot-list" aria-label="Choose agent">{localAgents.map(item => agentRow(item.id))}
            {!!directory?.agents.length && !localAgents.length && <p className="machine-group__note">No matching agents.</p>}
            {directory && !directory.agents.length && <button type="button" className="bot-list__empty" onClick={() => setDialog('agent')}><span className="bot-list__empty-plus"><Plus size={14} aria-hidden /></span><span><span className="bot-row__name">New agent</span><span className="bot-row__preview">Assign a task, such as research or a summary</span></span></button>}
            </nav>
          </div>

        </MachineGroup>
        {remoteMachines.map(machine => <MachineGroup key={machine.id} name={machine.name} subtitle={`${machine.name} · ${machineStatus[machine.status]}`} count={machine.agentCount} status={machine.status} expanded={query ? searchMachineGroups[machine.id] !== false : machineGroups[machine.id] !== false} onExpandedChange={expanded => setMachineExpanded(machine.id, expanded)}>
          {machine.status !== 'online' && <p className="machine-group__note">{machineStatus[machine.status]} · Last known agents</p>}
          <nav className="bot-list" aria-label={`Agents on ${machine.name}`}>{machine.agents.filter(item => matches(item.name, summaryFor(`${item.id}@${machine.id}`)?.preview, item.role)).map(item => {
              const current = view === 'remote' && remoteSelection?.machine === machine.id && remoteSelection.agent === item.id, summary = summaryFor(`${item.id}@${machine.id}`);
              return <button key={item.id} type="button" className={`bot-row${current ? ' is-selected' : ''}`} aria-label={`${item.name} on ${machine.name}`} aria-current={current ? 'page' : undefined} onClick={() => { setRemoteSelection({ machine: machine.id, agent: item.id }); setView('remote'); setDialog(null); }}>
                <span className="bot-row__avatar"><AgentAvatar agent={item} size={36} /><span className={`status-dot${machine.status === 'online' ? ' is-online' : ' is-offline'}`} role="img" aria-label={machineStatus[machine.status]} /></span>
                <span className="bot-row__text"><span className="bot-row__name">{item.name}</span><span className="bot-row__preview" title={plainPreview(summary?.preview) || undefined}>{item.role || plainPreview(summary?.preview) || 'No role yet'}</span></span>{summary?.time && <time className="bot-row__time" dateTime={summary.time}>{relativeTime(summary.time)}</time>}
              </button>;
            })}
            {!machine.agents.length && <p className="machine-group__note">No agents cached yet.</p>}
            {!!machine.agents.length && !machine.agents.some(item => matches(item.name, summaryFor(`${item.id}@${machine.id}`)?.preview, item.role)) && <p className="machine-group__note">No matching agents.</p>}
          </nav>
        </MachineGroup>)}
        {remoteMachinesState.error && <p className="machine-group__note" role="status">Machines could not be refreshed.</p>}
        {!remoteMachinesState.machines.length && <button type="button" className="bot-list__empty" onClick={() => setSettings('machines')}><Monitor size={16} aria-hidden /><span><span className="bot-row__name">Pair a machine</span><span className="bot-row__preview">See agents on your other computers</span></span></button>}
        </nav>
        </TabPanel>
        <TabPanel value="projects">
          <ProjectSidebar state={projectState} selectedProject={selectedProject} selectedSection={view === 'chat' ? selectedChannel : ''} search={query} onProject={openProject} onSection={openSection} onNew={() => setDialog('project')} onArchived={id => { if (selectedProject === id || channel?.project === id || projectThread?.project === id) openAgent(selected); void load(); }} />
        </TabPanel>
      </div>
      </Tabs>
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
    {dialog === 'project' && directory && <CreateProject state={projectState} agents={directory.agents} request={api} onClose={() => setDialog(null)} onCreated={item => { openProject(item.id); void load(); }} />}
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
            : settings === 'machines' ? <MachinesPanel request={api} onChanged={() => { void remoteMachinesState.reload(); void api<Environment>('/api/environment').then(setEnvironment).catch(() => setActivityError(true)); }} />
            : settings === 'connected-apps' ? <Suspense fallback={<p className="empty" role="status">Loading connected apps...</p>}><ConnectedAppsPanel agents={directory.agents} request={api} /></Suspense>
            : settings === 'mcp-server' ? <Suspense fallback={<p className="empty" role="status">Loading MCP server...</p>}><McpServerPanel request={api} /></Suspense>
            : settings === 'mcp' ? <Suspense fallback={<p className="empty" role="status">Loading MCP connections...</p>}><McpPanel agents={directory.agents} request={api} onClose={() => setSettings(null)} /></Suspense>
            : settings === 'data' ? <Suspense fallback={<p className="empty" role="status">Loading shared data...</p>}><SharedDataPanel agents={directory.agents} request={api} onClose={() => setSettings(null)} /></Suspense>
            : settings === 'usage' ? <Suspense fallback={<p className="empty" role="status">Loading usage...</p>}><UsagePanel request={api} onClose={() => setSettings(null)} /></Suspense>
            : settings === 'backup' ? <Suspense fallback={<p className="empty" role="status">Loading backup...</p>}><BackupPanel onClose={() => setSettings(null)} /></Suspense>
            : settings === 'import' ? <Suspense fallback={<p className="empty" role="status">Loading agent import...</p>}><AgentTemplateImport request={api} onClose={() => setSettings(null)} onCreated={item => { created(item); setSettings(null); }} /></Suspense>
            : settings === 'help' ? <HelpPage />
            : <Suspense fallback={<p className="empty" role="status">Loading appearance settings...</p>}><PresentationSettings><Section title="Notifications"><Row title="Workflow inbox notifications" meta="Applies in this browser." trailing={<Switch label="Workflow inbox notifications" checked={!notificationsMuted} onChange={enabled => { try { localStorage.setItem('briefsip:workflow-notifications-muted', enabled ? '0' : '1'); setNotificationsMuted(!enabled); setNotificationError(''); } catch { setNotificationError('Notification preference could not be saved. Check browser storage.'); } }} />}/>{notificationError && <Alert tone="error">{notificationError}</Alert>}</Section></PresentationSettings></Suspense>}
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
  return <main className="computer-window bs-root">{error ? <Alert tone="error">{error}</Alert> : <ComputerViewer agent={agent} name={name} request={api} popout />}</main>;
}
applyPresentation(document.documentElement, readPresentation().value);
window.addEventListener('storage', event => {
  if (event.key !== presentationKey && event.key !== null) return;
  try { if (event.storageArea !== localStorage) return; } catch { return; }
  applyPresentation(document.documentElement, readPresentation().value);
});
createRoot(document.getElementById('root')!).render(<ConfirmProvider>{new URLSearchParams(location.search).has('computer') ? <ComputerWindow /> : <App />}</ConfirmProvider>);
