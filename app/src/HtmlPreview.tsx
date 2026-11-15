import { useVisiblePolling } from './useVisiblePolling';
import { useCallback, useRef, useState } from 'react';
import { Alert, Button } from './ui/kit';
export function HtmlPreview({ path, name, request, embedded = false }: { embedded?: boolean; path: string; name: string; request: <T>(path: string) => Promise<T> }) {
  const [open, setOpen] = useState(embedded), [html, setHtml] = useState<string | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const opener = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const root = useVisiblePolling(useCallback(async current => {
    if (!open || !/\.html?$/i.test(name)) return;
    try { const result = await request<{ html: string }>(`${path}${path.includes('?') ? '&' : '?'}preview=html`); if (current()) { setHtml(result.html); setError(''); } }
    catch (error) { if (current()) setError(error instanceof Error ? error.message : 'Preview could not load. Try again.'); }
  }, [open, name, path, request, refresh]));
  if (!/\.html?$/i.test(name)) return null;
  return <div ref={root} className="k-stack bs-root">{!embedded && <Button size="sm" style={{ alignSelf: 'flex-start', maxWidth: '100%', height: 'auto', minHeight: 28, whiteSpace: 'normal', overflowWrap: 'anywhere' }} ref={opener} aria-expanded={open} onClick={() => setOpen(value => !value)}>Visual preview: {name}</Button>}
    {open && <section className="k-stack" aria-label={`Preview ${name}`}><h3 className="k-section__title" style={{ overflowWrap: 'anywhere' }} ref={heading} tabIndex={-1}>{name}</h3><p className="k-field__hint" style={{ margin: 0 }}>The view is restricted for security. Scripts, forms, links, images, external resources, and some styles are removed. Collapsible sections still work. Downloads preserve the original file. Download the original file if the view is blank.</p>
      {!embedded && <div className="k-row-actions"><Button size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => { setOpen(false); opener.current?.focus(); }}>Close preview</Button></div>}
      {error ? <Alert tone="error" actions={<Button size="sm" onClick={() => setRefresh(n => n + 1)}>Retry</Button>}>{error}</Alert> : html === null ? <p role="status">Loading preview...</p> : <iframe key={html} title={`Visual preview ${name}`} sandbox="" referrerPolicy="no-referrer" src={`${path}${path.includes('?') ? '&' : '?'}preview=render`} style={{ width: '100%', minHeight: 320, border: '0.5px solid var(--color-border-secondary)', borderRadius: 10, background: 'var(--color-bg-pane)' }} />}
    </section>}
  </div>;
}
