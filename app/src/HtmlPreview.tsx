import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from './ui/kit';
export function HtmlPreview({ path, name, request }: { path: string; name: string; request: <T>(path: string) => Promise<T> }) {
  const [open, setOpen] = useState(false), [html, setHtml] = useState<string | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const opener = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!open) return;
    let stopped = false; setHtml(null); setError(''); heading.current?.focus();
    void request<{ html: string }>(`${path}?preview=html`).then(result => { if (!stopped) setHtml(result.html); }).catch(error => { if (!stopped) setError(error instanceof Error ? error.message : 'Preview could not load. Try again.'); });
    return () => { stopped = true; };
  }, [open, path, refresh]);
  if (!/\.html?$/i.test(name)) return null;
  return <div className="k-stack bs-root"><Button size="sm" style={{ alignSelf: 'flex-start', maxWidth: '100%', height: 'auto', minHeight: 28, whiteSpace: 'normal', overflowWrap: 'anywhere' }} ref={opener} aria-expanded={open} onClick={() => setOpen(value => !value)}>Visual preview: {name}</Button>
    {open && <section className="k-stack" aria-label={`Preview ${name}`}><h3 className="k-section__title" style={{ overflowWrap: 'anywhere' }} ref={heading} tabIndex={-1}>{name}</h3><p className="k-field__hint" style={{ margin: 0 }}>The view is restricted for security. Scripts, forms, links, images, external resources, and some styles are removed. Collapsible sections still work. Downloads preserve the original file. If the view is blank or fails to load, use reload.</p>
      <div className="k-row-actions"><Button size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => { setOpen(false); opener.current?.focus(); }}>Close preview</Button><Button size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => setRefresh(n => n + 1)}>Reload preview</Button></div>
      {error ? <Alert tone="error">{error}</Alert> : html === null ? <p role="status">Loading preview...</p> : <iframe title={`Visual preview ${name}`} sandbox="" referrerPolicy="no-referrer" src={`${path}?preview=render`} style={{ width: '100%', minHeight: 320, border: '0.5px solid var(--color-border-secondary)', borderRadius: 10, background: 'var(--color-bg-pane)' }} />}
    </section>}
  </div>;
}
