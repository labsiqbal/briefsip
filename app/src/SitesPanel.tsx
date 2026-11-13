import { useEffect, useRef, useState, type FormEvent } from 'react';
import { siteCommand } from '../site-command';

type Site = { id: string; name: string; source: string; revision: number; deleted: number };
type Page = { sites: Site[]; next_after: string | null };
type Command = ReturnType<typeof siteCommand>;
export function SitesPanel({ agent, request }: { agent: string; request: <T>(path: string, data?: unknown) => Promise<T> }) {
  const path = `/api/agents/${agent}/sites`, key = `briefsip-sites:${agent}`;
  const [open, setOpen] = useState(false), [page, setPage] = useState<Page | null>(null), [cursors, setCursors] = useState(['']);
  const [editing, setEditing] = useState<Site | null>(null), [name, setName] = useState(''), [source, setSource] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState<Command | null>(null), [invalid, setInvalid] = useState(false);
  const [reload, setReload] = useState(0), [notice, setNotice] = useState(''), [confirmed, setConfirmed] = useState(false);
  const generation = useRef(0), heading = useRef<HTMLHeadingElement>(null), nameInput = useRef<HTMLInputElement>(null);
  const after = cursors.at(-1)!;
  const failure = (reason: unknown) => reason instanceof TypeError ? 'Connection lost. Retry with the same request.' : reason instanceof Error ? reason.message : 'Site could not load. Try again.';
  useEffect(() => {
    try { const stored = sessionStorage.getItem(key); if (stored) { setPending(siteCommand(JSON.parse(stored))); setOpen(true); } }
    catch { setInvalid(true); setOpen(true); }
    return () => { generation.current++; };
  }, [key]);
  useEffect(() => {
    if (!open) return;
    let stopped = false; setPage(null); heading.current?.focus();
    void request<Page>(`${path}?after=${after}`).then(value => { if (!stopped) setPage(value); }).catch(reason => { if (!stopped) setError(failure(reason)); });
    return () => { stopped = true; };
  }, [open, path, after, reload, request]);
  useEffect(() => { if (editing && !busy && !pending) nameInput.current?.focus(); }, [editing, busy, pending]);
  function reset() { generation.current++; setEditing(null); setName(''); setSource(''); setConfirmed(false); setError(''); nameInput.current?.focus(); }
  async function edit(id: string) {
    const version = ++generation.current; setBusy(true); setError('');
    try { const value = await request<Site>(`${path}/${id}`); if (generation.current !== version) return; if (value.deleted) throw new Error('Site has been deleted. Reload the list.'); setEditing(value); setName(value.name); setSource(value.source); setConfirmed(false); }
    catch (reason) { if (generation.current === version) setError(failure(reason)); }
    finally { if (generation.current === version) setBusy(false); }
  }
  async function save(event?: FormEvent, deleting = false) {
    event?.preventDefault(); if (busy || invalid || deleting && !confirmed) return;
    const version = generation.current; setError(''); setNotice(''); setBusy(true);
    try {
      const command = pending ?? siteCommand({ id: crypto.randomUUID(), ...(editing ? { site: editing.id, revision: editing.revision } : {}), ...(deleting ? { delete: true } : { name, source }) });
      sessionStorage.setItem(key, JSON.stringify(command)); setPending(command);
      const result = await request<Site>(path, command);
      if (sessionStorage.getItem(key) === JSON.stringify(command)) sessionStorage.removeItem(key);
      if (version !== generation.current) return;
      setPending(null); reset(); setNotice(result.deleted ? 'Site has been deleted.' : 'Site saved. Open the link in the list to see the result.'); setReload(value => value + 1);
    } catch (reason) { if (version === generation.current) setError(failure(reason)); }
    finally { if (version === generation.current || version + 1 === generation.current) setBusy(false); }
  }
  function discard() {
    if (!confirm('Changes may already be saved. Discard recovery, then check the site list before making new changes?')) return;
    try { sessionStorage.removeItem(key); setPending(null); setInvalid(false); reset(); setReload(value => value + 1); }
    catch { setError('Recovery could not be cleared. Check browser storage.'); }
  }
  return <section className="local-sites">
    <button type="button" className="secondary" aria-expanded={open} onClick={() => setOpen(value => !value)}>Local sites</button>
    {open && <><h2 ref={heading} tabIndex={-1}>Agent local sites</h2>
      <p className="muted">HTML pages with permanent links on this local server. Only text, tables, and inline styles are supported. Scripts, forms, images, and external connections are removed. Sites are not published on the internet.</p>
      {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      {(pending || invalid) && <div><p className="notice">{invalid ? 'Recovery data could not be read. Check the site list before discarding it.' : 'Changes are not confirmed yet. Retrying uses the same contents and ID.'}</p><div className="form-actions">{pending && <button type="button" disabled={busy} onClick={() => void save()}>Retry change</button>}<button type="button" className="secondary" disabled={busy} onClick={discard}>Discard recovery</button></div></div>}
      <button type="button" className="secondary" onClick={() => { setError(''); setReload(value => value + 1); }}>Reload sites</button>
      {!page ? <p role="status">Loading sites...</p> : !page.sites.length ? <p>No sites on this page yet.</p> : <ul className="site-list">{page.sites.map(site => <li key={site.id}><a href={`/sites/${site.id}`} target="_blank" rel="noopener noreferrer">Open {site.name}</a><button type="button" className="secondary" disabled={busy || !!pending || invalid} onClick={() => void edit(site.id)}>Edit {site.name}</button></li>)}</ul>}
      <div className="form-actions"><button type="button" className="secondary" disabled={cursors.length < 2} onClick={() => setCursors(values => values.slice(0,-1))}>Previous sites</button><button type="button" className="secondary" disabled={!page?.next_after} onClick={() => setCursors(values => [...values, page!.next_after!])}>Next sites</button></div>
      <form onSubmit={event => void save(event)}><h3>{editing ? 'Replace site contents' : 'New site'}</h3>
        <label>Site name<input ref={nameInput} required maxLength={80} value={name} disabled={busy || !!pending || invalid} onChange={event => setName(event.target.value)} /></label>
        <label>HTML contents<textarea required rows={8} maxLength={262144} value={source} disabled={busy || !!pending || invalid} onChange={event => setSource(event.target.value)} /></label>
        <div className="form-actions"><button disabled={busy || !!pending || invalid}>{busy ? 'Saving...' : editing ? 'Save replacement' : 'Create local site'}</button>{editing && <button type="button" className="secondary" disabled={busy || !!pending || invalid} onClick={reset}>Cancel edit</button>}</div>
        {editing && <><label className="member-option"><input type="checkbox" checked={confirmed} disabled={busy || !!pending || invalid} onChange={event => setConfirmed(event.target.checked)} />I understand that the site link will stop working after deletion</label><button type="button" className="secondary" disabled={!confirmed || busy || !!pending || invalid} onClick={() => void save(undefined, true)}>Delete site</button></>}
      </form>
    </>}
  </section>;
}
