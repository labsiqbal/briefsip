import { useEffect, useRef, useState } from 'react';
import { memoryCommand, memoryDraft, type MemoryCommand, type MemoryDraft, type MemoryEntry } from '../memory-command.ts';

type Entry = MemoryEntry;
type Page = { items: Entry[]; next_after: string | null };
export function MemoryPanel({ path, channel, archived, request, onClose }: { path: string; channel: boolean; archived: boolean; request: <T>(path: string, data?: unknown) => Promise<T>; onClose: () => void }) {
  const key = `briefsip:memory:${path}`;
  const draftKey = `${key}:draft`;
  const [recovery] = useState(() => {
    try { const raw = sessionStorage.getItem(key), draft = sessionStorage.getItem(draftKey); return { pending: raw ? memoryCommand(JSON.parse(raw)) : null, draft: draft ? memoryDraft(JSON.parse(draft)) : null, error: '' }; }
    catch { return { pending: null, draft: null, error: 'Saved changes could not be read. Discard recovery to continue.' }; }
  });
  const [pending, setPending] = useState<MemoryCommand | null>(recovery.pending), [blocked, setBlocked] = useState(recovery.error);
  const [page, setPage] = useState<Page | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [cursors, setCursors] = useState<string[]>([]), [refresh, setRefresh] = useState(0);
  const [entry, setEntry] = useState<Entry | null>(recovery.draft?.entry ?? null), [text, setText] = useState(recovery.draft?.text ?? ''), [essential, setEssential] = useState(recovery.draft?.essential ?? false), [busy, setBusy] = useState(false);
  const [automatic, setAutomatic] = useState(recovery.draft?.automatic ?? false);
  const mounted = useRef(false), generation = useRef(0), sending = useRef(false), heading = useRef<HTMLHeadingElement>(null), editor = useRef<HTMLTextAreaElement>(null);
  const [draftStored, setDraftStored] = useState(true);
  const after = cursors.at(-1) ?? '', locked = !!pending || !!blocked || busy || archived;
  const dirty = text !== (entry?.text ?? '') || essential !== !!entry?.essential || automatic !== (entry?.selection_locked === 0);
  useEffect(() => { mounted.current = true; heading.current?.focus(); return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    const version = ++generation.current; setPage(null); setError('');
    void request<Page>(`${path}?${new URLSearchParams({ query: search, after })}`).then(value => { if (mounted.current && generation.current === version) setPage(value); }).catch(error => { if (mounted.current && generation.current === version) setError(error instanceof TypeError ? 'Memory could not load. Try reloading.' : error.message); });
    return () => { generation.current++; };
  }, [after, search, refresh]);
  function draft(value: MemoryDraft) {
    try { sessionStorage.setItem(draftKey, JSON.stringify(value)); setDraftStored(true); }
    catch { setDraftStored(false); setError('Draft has not been saved in the browser. Copy the text before leaving this page.'); }
    setEntry(value.entry); setText(value.text); setEssential(value.essential); setAutomatic(value.automatic ?? false);
  }
  function clear() { sessionStorage.removeItem(draftKey); setEntry(null); setText(''); setEssential(false); setAutomatic(false); }
  function choose(value: Entry | null) {
    if (locked || dirty && !window.confirm('Discard unsaved note changes?')) return;
    draft({ entry: value, text: value?.text ?? '', essential: !!value?.essential, automatic: value?.selection_locked === 0 }); editor.current?.focus();
  }
  function discard() {
    if (!window.confirm('Delete recovery data? Changes may already be saved on the server. Check the list before making new changes.')) return;
    try { sessionStorage.removeItem(key); setPending(null); setBlocked(''); setError(''); setNotice('Draft kept. For revision conflicts, choose Edit note from the latest list.'); if (blocked) clear(); setRefresh(n => n + 1); }
    catch { setError('Recovery data could not be deleted. Check browser storage.'); }
  }
  async function save(remove = false) {
    if (sending.current || archived && !pending || blocked) return;
    if (!pending && remove && (!entry || !window.confirm('Delete this memory note? Conversation history and backups still retain earlier copies.'))) return;
    let command;
    try {
      command = pending ?? memoryCommand({ id: crypto.randomUUID(), entry: entry?.id ?? crypto.randomUUID(), revision: entry?.revision ?? 0, text: remove ? '' : text, essential: remove ? false : essential, remove, automatic });
      sessionStorage.setItem(key, JSON.stringify(command));
    } catch (error) { setError(error instanceof Error ? error.message : 'Changes could not be saved in the browser.'); return; }
    sending.current = true; generation.current++; setPending(command); setBusy(true); setError(''); setNotice('');
    try {
      await request(path, command);
      if (!mounted.current) return;
      clear(); sessionStorage.removeItem(key); setPending(null); setNotice('Changes saved.'); setRefresh(n => n + 1); heading.current?.focus();
    } catch (error) {
      if (mounted.current && error && typeof error === 'object' && 'status' in error && [400, 413].includes(Number(error.status))) {
        try { sessionStorage.removeItem(key); setPending(null); } catch { /* Keep exact retry if recovery storage cannot be cleared. */ }
      }
      if (mounted.current) setError(error instanceof TypeError ? 'Save result is unknown. Retry with the same changes.' : error instanceof Error ? error.message : 'Changes are not confirmed yet. Try again.');
    } finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  return <section className="setup workflow-panel"><h1 ref={heading} tabIndex={-1}>Memory for this {channel ? 'channel' : 'agent'}</h1>
    <p>{channel ? 'Used by members when replying in this channel. Private agent memory is excluded.' : 'Used by the agent in Main chat and all its side threads. Excluded from channels.'} Notes are sent to the provider when included or searched. Agents can add or edit note contents, but cannot delete notes. Context selection stays under your control unless delegated to the agent. Saved changes remain even if the task is canceled. Reload to see the latest changes.</p>
    <div className="form-actions routine-actions"><button className="secondary" onClick={() => { if (draftStored || window.confirm('Draft has not been saved in the browser. Leave and discard changes?')) onClose(); }}>Back to conversation</button><button className="secondary" disabled={busy} onClick={() => setRefresh(n => n + 1)}>Reload memory</button></div>
    {archived && <p>Channel archived. Restore the channel to change memory.</p>}
    {(blocked || error) && <p role="alert" className="error">{blocked || error}</p>}{notice && <p role="status">{notice}</p>}
    {(pending || blocked) && <div><p>Changes await confirmation. Retrying uses the same data.</p>{pending && <p className="message-text">{pending.remove ? 'Delete note' : pending.text}</p>}<div className="form-actions routine-actions">{pending && <button disabled={busy} onClick={() => void save()}>Retry save</button>}<button className="secondary" disabled={busy} onClick={discard}>Discard recovery and reload</button></div></div>}
    <form onSubmit={event => { event.preventDefault(); if (!locked) void save(); }}>
      <h2>{entry ? 'Edit note' : 'New note'}</h2><label>Memory contents<textarea ref={editor} maxLength={2000} required value={text} disabled={locked} onChange={event => draft({ entry, text: event.target.value, essential, automatic })} /></label>
      <label className="member-option"><input type="checkbox" checked={essential} disabled={locked} onChange={event => draft({ entry, text, essential: event.target.checked, automatic })} />Always include in context</label>
      <label className="member-option"><input type="checkbox" checked={automatic} disabled={locked} onChange={event => draft({ entry, text, essential, automatic: event.target.checked })} />Allow agent to manage context selection</label>
      <p className="muted">When enabled, the agent may change context selection for future runs. Excluded notes can still be found by search. Maximum 2,000 characters per note, 128 notes, and 8 KiB of combined context.</p>
      <div className="form-actions routine-actions"><button disabled={locked || !text.trim()}>Save note</button><button type="button" className="secondary" disabled={locked} onClick={() => choose(null)}>New note</button>{entry && <button type="button" className="secondary" disabled={locked} onClick={() => void save(true)}>Delete note</button>}</div>
    </form>
    <form onSubmit={event => { event.preventDefault(); setCursors([]); setSearch(query); setRefresh(n => n + 1); }}><label>Search memory<input value={query} maxLength={200} disabled={busy} onChange={event => setQuery(event.target.value)} /></label><button className="secondary" disabled={busy}>Search</button></form>
    {!page ? !error && <p role="status">Loading memory...</p> : <><ul className="routine-list">{page.items.map(row => <li key={row.id}><p className="message-text">{row.text}</p><p className="muted">{row.essential ? 'Always included' : 'Searched when needed'} · {row.selection_locked === 0 ? 'Selection managed by agent' : 'Selection locked by user'}</p><button className="secondary" disabled={locked} onClick={() => choose(row)}>Edit note</button></li>)}</ul>{!page.items.length && <p>No matching notes yet.</p>}
      <div className="form-actions routine-actions"><button className="secondary" disabled={busy || !cursors.length} onClick={() => setCursors(v => v.slice(0, -1))}>Previous page</button><button className="secondary" disabled={busy || !page.next_after} onClick={() => setCursors(v => [...v, page.next_after!])}>Next page</button></div></>}
  </section>;
}
