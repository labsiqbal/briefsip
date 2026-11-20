import { readProductStorage, removeProductStorage } from './rename-storage.ts';
import { useCallback, useId, useRef, useState } from 'react';
import { useVisiblePolling } from './hooks/useVisiblePolling';
import { Alert, Button, Card, Dialog, Field, Input, RecoveryAlert, Row, Select, SkeletonRows, useConfirm } from './ui/kit';

const modes = [
  { value: 'read-only', label: 'Read only' },
  { value: 'read-write', label: 'Read and write' },
] as const;
type Mode = typeof modes[number]['value'];
type Folder = { path: string; mode: Mode; source: 'server' | 'custom' | 'managed'; revision: number };
type Command = { id: string; revision: number } & ({ path: string; mode: Mode } | { path?: never });

function recover(key: string): { command: Command | null; corrupt: boolean } {
  try {
    const value = JSON.parse(readProductStorage(sessionStorage, key) ?? 'null');
    if (value === null) return { command: null, corrupt: false };
    if (typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.id) ||
        !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        (Object.keys(value).length !== 2 && !(Object.keys(value).length === 4 &&
          typeof value.path === 'string' && value.path.length <= 4096 && modes.some(mode => mode.value === value.mode)))) {
      throw new Error();
    }
    return { command: value, corrupt: false };
  } catch {
    return { command: null, corrupt: true };
  }
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Working folder is unavailable.';

export function AgentFolderSettings({ agent, request, isClientError }: {
  agent: string;
  request: <T>(path: string, data?: unknown) => Promise<T>;
  isClientError: (error: unknown) => boolean;
}) {
  const endpoint = `/api/agents/${agent}/folder`;
  const storageKey = `minarbot-agent-folder:${agent}`;
  const [initial] = useState(() => recover(storageKey));
  const [pending, setPending] = useState(initial.command);
  const [corrupt, setCorrupt] = useState(initial.corrupt);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<{ path: string; mode: Mode; revision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const choose = useRef<HTMLButtonElement>(null), pathInput = useRef<HTMLInputElement>(null);
  const editorId = useId();
  const confirm = useConfirm();

  const section = useVisiblePolling(useCallback(async current => {
    if (flight.current) return;
    try {
      const value = await request<Folder>(endpoint);
      if (current() && !flight.current) { setFolder(value); setLoadError(''); }
    } catch (reason) {
      if (current()) setLoadError(errorMessage(reason));
    }
  }, [endpoint, request, reload]));

  function clearRecovery() {
    removeProductStorage(sessionStorage, storageKey);
    setPending(null);
    setCorrupt(false);
  }

  async function save(command: Command) {
    if (flight.current) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify(command)); }
    catch { setError('Browser could not save recovery data.'); return; }
    flight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await request<Folder>(command.path === undefined ? `${endpoint}/reset` : endpoint, command);
      if (!section.current) return;
      clearRecovery();
      setFolder(result);
      setDraft(null);
      setReload(value => value + 1);
    } catch (reason) {
      if (!section.current) return;
      if (isClientError(reason)) {
        try {
          clearRecovery();
          setReload(value => value + 1);
        } catch { setPending(command); }
      } else { setPending(command); setDraft(null); }
      setError(errorMessage(reason));
    } finally {
      flight.current = false;
      if (section.current) setBusy(false);
    }
  }

  async function discard() {
    if (!await confirm({ title: 'Discard folder request?', description: 'Changes already accepted by the server still apply.', confirm: 'Discard and reload' })) return;
    try {
      clearRecovery();
      setError('');
      setReload(value => value + 1);
    } catch (reason) { setError(errorMessage(reason)); }
  }

  const locked = busy || !!pending || corrupt;
  return <div ref={section} className="k-stack">
    {folder ? <Card><Row title="Working folder" meta={<>
      <code className="agent-folder-path">{folder.path}</code>
      <span>{folder.mode === 'read-only' ? 'Read only' : 'Read and write'}{folder.source === 'server' ? ' · Set by server' : ''}</span>
    </>} trailing={folder.source !== 'server' && <>
      <Button ref={choose} size="sm" disabled={locked} onClick={() => { setError(''); setDraft({ path: folder.source === 'custom' ? folder.path : '', mode: folder.mode, revision: folder.revision }); }}>Choose</Button>
      {folder.source === 'custom' && <Button size="sm" disabled={locked} onClick={() => void save({ id: crypto.randomUUID(), revision: folder.revision })}>Reset</Button>}
    </>} /></Card> : !loadError && <><span className="sr-only" role="status">Loading working folder...</span><SkeletonRows count={1} /></>}
    {loadError && <Alert tone="error" actions={<Button size="sm" onClick={() => { setLoadError(''); setReload(value => value + 1); }}>Retry</Button>}>{loadError}</Alert>}
    {error && !draft && <Alert tone="error">{error}</Alert>}
    {(pending || corrupt) && <RecoveryAlert inFlight={busy} tone={corrupt ? 'error' : 'warn'} title={corrupt ? 'Folder request recovery is invalid' : 'Folder change is not confirmed'} actions={<>
      {pending && <Button size="sm" disabled={busy} onClick={() => void save(pending)}>Try again</Button>}
      <Button size="sm" disabled={busy} onClick={() => void discard()}>Discard recovery</Button>
    </>} />}
    {folder && draft && <Dialog open title="Choose working folder" onOpenChange={open => { if (!open && !busy) { setDraft(null); if (!pending) setError(''); } }}
      onCloseAutoFocus={event => { event.preventDefault(); choose.current?.focus(); }}
      footer={<><Button disabled={busy} onClick={() => { setDraft(null); if (!pending) setError(''); }}>Cancel</Button><Button variant="primary" type="submit" form={editorId} busy={busy} disabled={locked}>Save folder</Button></>}>
      <form id={editorId} className="k-fieldset" onSubmit={event => {
        event.preventDefault();
        event.stopPropagation();
        if (!locked) void save({ id: crypto.randomUUID(), ...draft }).then(() => pathInput.current?.focus());
      }}>
        <Field label="Absolute folder path" error={error}>
          <Input ref={pathInput} name="path" required maxLength={4096} value={draft.path} readOnly={locked} autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} onChange={event => { setDraft({ ...draft, path: event.target.value }); setError(''); }} />
        </Field>
        <Field label="Access"><Select name="mode" options={[...modes]} value={draft.mode} disabled={locked} onChange={value => setDraft({ ...draft, mode: value as Mode })} /></Field>
      </form>
    </Dialog>}
  </div>;
}
