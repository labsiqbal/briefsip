import { useVisiblePolling } from './hooks/useVisiblePolling';
import { useCallback, useState } from 'react';
import { Alert, Button } from './ui/kit';
export function HtmlPreview({ path, name, request }: { path: string; name: string; request: <T>(path: string) => Promise<T> }) {
  const [html, setHtml] = useState<string | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const root = useVisiblePolling(useCallback(async current => {
    if (!/\.html?$/i.test(name)) return;
    try { const result = await request<{ html: string }>(`${path}${path.includes('?') ? '&' : '?'}preview=html`); if (current()) { setHtml(result.html); setError(''); } }
    catch (error) { if (current()) setError(error instanceof Error ? error.message : 'Preview could not load. Try again.'); }
  }, [name, path, request, refresh]));
  if (!/\.html?$/i.test(name)) return null;
  return <div ref={root} className="k-stack bs-root"><section className="k-stack" aria-label={`Preview ${name}`}>
      {error ? <Alert tone="error" actions={<Button size="sm" onClick={() => setRefresh(n => n + 1)}>Retry</Button>}>{error}</Alert> : html === null ? <p role="status">Loading preview...</p> : <iframe key={html} title={`Visual preview ${name}`} sandbox="" referrerPolicy="no-referrer" src={`${path}${path.includes('?') ? '&' : '?'}preview=render`} style={{ width: '100%', minHeight: 320, border: '0.5px solid var(--color-border-secondary)', borderRadius: 10, background: 'var(--color-bg-pane)' }} />}
    </section>
  </div>;
}
