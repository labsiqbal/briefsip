import { useEffect, useRef, useState } from 'react';
import { Alert, Button, CodeBlock, PageHeader, Section, useConfirm } from './ui/kit';

export function BackupPanel({}: { onClose: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [downloaded, setDownloaded] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), controller = useRef<AbortController | null>(null);
  const confirm = useConfirm();
  useEffect(() => { heading.current?.focus(); return () => controller.current?.abort(); }, []);
  async function download() {
    if (controller.current || !await confirm({ title: 'Download workspace backup?', description: 'Backup includes all conversations, files, instructions, and webhook secrets. The file is not encrypted. Keep it private.', confirm: 'Download backup' })) return;
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
  return <div className="k-page bs-root">
    <PageHeader headingRef={heading} title="Workspace backup" description="Save a private copy of your Briefsip workspace."
      actions={<Button variant="primary" busy={busy} disabled={busy} onClick={() => void download()}>Download workspace backup</Button>} />
    <Section title="Backup"><p>The database snapshot includes agents, conversations, files, routines, workflows, results, and webhook secrets. Provider settings from the server environment and browser drafts are excluded.</p><Alert tone="warn">The file is not encrypted. Keep it private and do not share it with untrusted services.</Alert>{error && <Alert tone="error">{error}</Alert>}{downloaded && <Alert>Download started. Make sure the browser finishes saving the file.</Alert>}</Section>
    <Section title="Recovery"><p>Restore only trusted backups. Recovery uses a new database and does not overwrite the old workspace. Schedules, webhooks, and script access are disabled; unfinished work is held for review.</p><p>Run from the application directory on the server computer:</p><CodeBlock label="Backup restore command">node --experimental-strip-types backup.ts restore BACKUP.sqlite /new-directory/briefsip.sqlite</CodeBlock><p>The destination directory must already exist. To use the restored data, point BRIEFSIP_DATA_DIR to that directory when starting the application. Check the results and settings before enabling automation again.</p></Section>
  </div>;
}
