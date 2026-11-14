import { useEffect, useRef, useState, type FormEvent } from 'react';
import { siteCommand } from '../site-command';
import { Alert, Button, Card, Checkbox, Dialog, EmptyState, Field, IconButton, Input, Row, Section, SkeletonRows, Textarea, useConfirm } from './ui/kit';
import { ChevronLeft, ChevronRight, ExternalLink, Plus, RefreshCw } from 'lucide-react';

type Site = { id: string; name: string; source: string; revision: number; deleted: number };
type Page = { sites: Site[]; next_after: string | null };
type Command = ReturnType<typeof siteCommand>;
export function SitesPanel({ agent, request }: { agent: string; request: <T>(path: string, data?: unknown) => Promise<T> }) {
  const path = `/api/agents/${agent}/sites`, key = `briefsip-sites:${agent}`;
  const [open, setOpen] = useState(false), [editorOpen, setEditorOpen] = useState(false), [page, setPage] = useState<Page | null>(null), [cursors, setCursors] = useState(['']);
  const [editing, setEditing] = useState<Site | null>(null), [name, setName] = useState(''), [source, setSource] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState<Command | null>(null), [invalid, setInvalid] = useState(false);
  const [reload, setReload] = useState(0), [notice, setNotice] = useState(''), [confirmed, setConfirmed] = useState(false);
  const generation = useRef(0), heading = useRef<HTMLHeadingElement>(null), nameInput = useRef<HTMLInputElement>(null), confirm = useConfirm();
  const after = cursors.at(-1)!;
  const failure = (reason: unknown) => reason instanceof TypeError ? 'Connection lost. Retry with the same request.' : reason instanceof Error ? reason.message : 'Site could not load. Try again.';
  useEffect(() => {
    try { const stored = sessionStorage.getItem(key); if (stored) { setPending(siteCommand(JSON.parse(stored))); setOpen(true); setEditorOpen(true); } }
    catch { setInvalid(true); setOpen(true); setEditorOpen(true); }
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
    try { const value = await request<Site>(`${path}/${id}`); if (generation.current !== version) return; if (value.deleted) throw new Error('Site has been deleted. Reload the list.'); setEditing(value); setName(value.name); setSource(value.source); setConfirmed(false); setEditorOpen(true); }
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
  async function discard() {
    if (!await confirm({ title: 'Discard site recovery?', description: 'Changes may already be saved. Check the site list before making new changes.', confirm: 'Discard recovery', danger: true })) return;
    try { sessionStorage.removeItem(key); setPending(null); setInvalid(false); reset(); setReload(value => value + 1); }
    catch { setError('Recovery could not be cleared. Check browser storage.'); }
  }
  const locked = busy || !!pending || invalid;
  const pager = (back: boolean, next: boolean) => (back || next) && <div className="k-pager"><IconButton label="Previous sites" disabled={!back} onClick={() => setCursors(values => values.slice(0, -1))}><ChevronLeft size={16} aria-hidden /></IconButton><IconButton label="Next sites" disabled={!next} onClick={() => setCursors(values => [...values, page!.next_after!])}><ChevronRight size={16} aria-hidden /></IconButton></div>;
  return <div className="k-stack bs-root">
    <Section title="Local sites" actions={open && <IconButton label="Reload sites" onClick={() => { setError(''); setReload(value => value + 1); }}><RefreshCw size={15} aria-hidden /></IconButton>}>
      <Button size="sm" onClick={() => setOpen(value => !value)} aria-expanded={open}>{open ? 'Hide local sites' : 'Show local sites'}</Button>
    </Section>
    {open && <div className="k-stack">
      <h3 ref={heading} tabIndex={-1} className="k-section__title">Agent local sites</h3>
      <p className="k-field__hint">HTML pages with permanent links on this local server. Only text, tables, and inline styles are supported. Scripts, forms, images, and external connections are removed. Sites are not published on the internet.</p>
      {error && <Alert tone="error">{error}</Alert>}{notice && <Alert>{notice}</Alert>}
      {(pending || invalid) && <Alert tone={invalid ? 'error' : 'warn'} title={invalid ? 'Recovery data could not be read' : 'Changes are not confirmed yet'} actions={<>{pending && <Button size="sm" variant="primary" busy={busy} onClick={() => void save()}>Try again</Button>}<Button size="sm" disabled={busy} onClick={() => void discard()}>Discard recovery</Button></>}>{invalid ? 'Check the site list before discarding it.' : 'Retrying uses the same contents and ID.'}</Alert>}
      {!page ? <><span className="sr-only" role="status">Loading sites...</span><SkeletonRows /></> : !page.sites.length ? <EmptyState title="No sites on this page yet" icon={<ExternalLink size={18} />} /> : <Card>{page.sites.map(site => <Row key={site.id} title={site.name} leading={<ExternalLink size={16} aria-hidden />} meta={<a href={`/sites/${site.id}`} target="_blank" rel="noopener noreferrer">Open {site.name}</a>} trailing={<Button size="sm" disabled={locked} onClick={() => void edit(site.id)} aria-label={`Edit ${site.name}`}>Edit</Button>} />)}</Card>}
      {pager(cursors.length > 1, !!page?.next_after)}
      <div className="k-row-actions"><Button size="sm" variant="secondary" icon={<Plus size={14} aria-hidden />} disabled={locked} onClick={() => setEditorOpen(true)}>{editing ? 'Continue editing site' : 'New local site'}</Button></div>
    </div>}
    <Dialog open={editorOpen} size="md" title={editing ? 'Replace site contents' : 'New site'} description="Local static HTML with no scripts or external resources. Sites are not published on the internet." onOpenChange={setEditorOpen} footer={<><Button onClick={() => setEditorOpen(false)}>Close</Button><Button type="submit" form="site-editor" variant="primary" busy={busy} disabled={locked}>{busy ? 'Saving...' : editing ? 'Save replacement' : 'Create local site'}</Button></>}>
      {error && <Alert tone="error">{error}</Alert>}{notice && <Alert>{notice}</Alert>}
      {(pending || invalid) && <Alert tone={invalid ? 'error' : 'warn'} title={invalid ? 'Recovery data could not be read' : 'Changes are not confirmed yet'} actions={<>{pending && <Button size="sm" variant="primary" busy={busy} onClick={() => void save()}>Try again</Button>}<Button size="sm" disabled={busy} onClick={() => void discard()}>Discard recovery</Button></>}>{invalid ? 'Check the site list before discarding it.' : 'Retrying uses the same contents and ID.'}</Alert>}
      <form id="site-editor" className="k-stack" onSubmit={event => void save(event)}>
        <Field label="Site name"><Input ref={nameInput} required maxLength={80} value={name} disabled={locked} onChange={event => setName(event.target.value)} /></Field>
        <Field label="HTML contents" hint="Only text, tables, and inline styles are supported. Scripts, forms, images, and external connections are removed."><Textarea required rows={8} maxLength={262144} value={source} disabled={locked} onChange={event => setSource(event.target.value)} /></Field>
        {editing && <><Button size="sm" disabled={locked} onClick={reset}>Cancel edit</Button><Checkbox checked={confirmed} disabled={locked} onChange={setConfirmed} label="I understand that the site link will stop working after deletion" /><Button type="button" variant="danger" disabled={!confirmed || locked} onClick={() => void save(undefined, true)}>Delete site</Button></>}
      </form>
    </Dialog>
  </div>;
}
