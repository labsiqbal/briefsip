import { downloadBlob } from './hooks/downloadBlob';
import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, CodeBlock, Dialog, PageHeader, Row, Section, useConfirm } from './ui/kit';

import './machines-data.css';

export function BackupPanel({}: { onClose: () => void }) {
  const [restoreOpen, setRestoreOpen] = useState(false);
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
      downloadBlob(blob, 'briefsip-workspace.sqlite'); setDownloaded(true);
    } catch (error) { if (!pending.signal.aborted) setError(error instanceof TypeError ? 'Connection lost. Try downloading the backup again.' : error instanceof Error ? error.message : 'Backup download failed.'); }
    finally { if (!pending.signal.aborted) { controller.current = null; setBusy(false); } }
  }
  return <div className="k-page bs-root set4-page">
    <PageHeader headingRef={heading} title="Backup & restore" />
    {error && <Alert tone="error">{error}</Alert>}
    {downloaded && <span className="k-field__hint" role="status">Download started. Check the saved file.</span>}
    <Section title="Backup"><Card><Row title="Workspace backup" trailing={<Button variant="primary" busy={busy} disabled={busy} onClick={() => void download()}>Download</Button>} /></Card></Section>
    <Section title="Restore"><Card><Row title="Restore backup" trailing={<><Badge>Command line</Badge><Button onClick={() => setRestoreOpen(true)}>Open</Button></>} /></Card></Section>
    <Dialog open={restoreOpen} onOpenChange={setRestoreOpen} title="Restore backup" size="lg" footer={<Button onClick={() => setRestoreOpen(false)}>Close</Button>}>
      <div className="k-stack set4-detail">
        <p>Restore only trusted backups. Recovery uses a new database and does not overwrite the old workspace. Schedules, webhooks, and script access are disabled; unfinished work is held for review.</p>
        <p>Run from the application directory on the server computer:</p><CodeBlock label="Backup restore command">node --experimental-strip-types backup.ts restore BACKUP.sqlite /new-directory/briefsip.sqlite</CodeBlock>
        <p>The destination directory must already exist. To use the restored data, point BRIEFSIP_DATA_DIR to that directory when starting the application. Check the results and settings before enabling automation again.</p>
        <p className="k-field__hint">Backup includes conversations, files, instructions, routines, workflows, results and webhook secrets. Server-environment provider settings and browser drafts are excluded. Restore does not configure deployment or credentials.</p>
      </div>
    </Dialog>
  </div>;
}
