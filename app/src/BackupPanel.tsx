import { useEffect, useRef, useState } from 'react';

export function BackupPanel({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [downloaded, setDownloaded] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), controller = useRef<AbortController | null>(null);
  useEffect(() => { heading.current?.focus(); return () => controller.current?.abort(); }, []);
  async function download() {
    if (controller.current || !window.confirm('Backup includes all conversations, files, instructions, and webhook secrets. The file is not encrypted. Keep it private. Continue downloading?')) return;
    const pending = new AbortController(); controller.current = pending; setBusy(true); setError(''); setDownloaded(false);
    try {
      const response = await fetch('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: crypto.randomUUID(), confirmed: true }), signal: pending.signal });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Backup could not be created. Try again.');
      const blob = await response.blob();
      if (pending.signal.aborted) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = 'briefsip-workspace.sqlite'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setDownloaded(true);
    } catch (error) { if (!pending.signal.aborted) setError(error instanceof TypeError ? 'Connection lost. Try downloading the backup again.' : error instanceof Error ? error.message : 'Backup download failed.'); }
    finally { if (!pending.signal.aborted) { controller.current = null; setBusy(false); } }
  }
  return <section className="setup"><h1 ref={heading} tabIndex={-1}>Workspace backup</h1>
    <p>The database snapshot includes agents, conversations, files, routines, workflows, results, and webhook secrets. Provider settings from the server environment and browser drafts are excluded.</p>
    <p className="notice">The file is not encrypted. Keep it private and do not share it with untrusted services.</p>
    <div className="form-actions"><button className="secondary" onClick={onClose}>Back to conversation</button><button disabled={busy} onClick={() => void download()}>{busy ? 'Creating backup...' : 'Download workspace backup'}</button></div>
    {error && <p className="error" role="alert">{error}</p>}{downloaded && <p role="status">Download started. Make sure the browser finishes saving the file.</p>}
    <h2>Recovery</h2><p>Restore only trusted backups. Recovery uses a new database and does not overwrite the old workspace. Schedules, webhooks, and script access are disabled; unfinished work is held for review.</p>
    <p>Run from the application directory on the server computer:</p><pre className="message-text">node --experimental-strip-types backup.ts restore BACKUP.sqlite /new-directory/briefsip.sqlite</pre>
    <p>The destination directory must already exist. To use the restored data, point BRIEFSIP_DATA_DIR to that directory when starting the application. Check the results and settings before enabling automation again.</p>
  </section>;
}
