import { useEffect, useRef, useState } from 'react';
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
  return <div className="html-preview"><button ref={opener} className="secondary" aria-expanded={open} onClick={() => setOpen(value => !value)}>Visual preview: {name}</button>
    {open && <section aria-label={`Preview ${name}`}><h3 ref={heading} tabIndex={-1}>{name}</h3><p>The view is restricted for security. Scripts, forms, links, images, external resources, and some styles are removed. Collapsible sections still work. Downloads preserve the original file. If the view is blank or fails to load, use reload.</p>
      <div className="form-actions routine-actions"><button className="secondary" onClick={() => { setOpen(false); opener.current?.focus(); }}>Close preview</button><button className="secondary" onClick={() => setRefresh(n => n + 1)}>Reload preview</button></div>
      {error ? <p className="error" role="alert">{error}</p> : html === null ? <p role="status">Loading preview...</p> : <iframe title={`Visual preview ${name}`} sandbox="" referrerPolicy="no-referrer" src={`${path}?preview=render`} />}
    </section>}
  </div>;
}
