import { useEffect, useRef, useState } from 'react';
import { parseSkillFiles, type SkillFile } from '../skill-files';

export function SkillFolderImport({ disabled, onImport, onBusy }: { disabled: boolean; onImport: (files: SkillFile[]) => void; onBusy: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function read(selected: FileList | null) {
    if (!selected?.length || disabled || busy) return;
    const current = ++generation.current; setBusy(true); onBusy(true); setError('');
    try {
      const input = Array.from(selected);
      if (input.length > 32 || input.reduce((size, file) => size + file.size, 0) > 64000) throw new Error('Pilih maksimum 32 file teks dengan total 64 KB sebelum validasi folder.');
      const texts = await Promise.all(input.map(async file => ({ path: file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()) })));
      let files: unknown = texts;
      if (input.length === 1 && !input[0].webkitRelativePath && input[0].name.endsWith('.json')) {
        const bundle = JSON.parse(texts[0].content);
        if (bundle?.format !== 'briefsip-skill-folder' || bundle.version !== 1 || Object.keys(bundle).some(key => !['format', 'version', 'files'].includes(key))) throw new Error('File bukan ekspor folder skill Briefsip versi 1.');
        files = bundle.files;
      }
      const parsed = parseSkillFiles(files);
      if (input[0].webkitRelativePath && input[0].webkitRelativePath.split('/')[0] !== parsed.name) throw new Error('Nama folder harus sama dengan nama pada SKILL.md.');
      if (current === generation.current) onImport(parsed.files);
    } catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Folder gagal dibaca. Pilih kembali file UTF-8.'); }
    finally { if (current === generation.current) { setBusy(false); onBusy(false); } }
  }
  return <fieldset disabled={disabled || busy}><legend>Impor folder skill</legend>
    <p>Pilih folder berisi SKILL.md dan file teks pendukung, atau ekspor JSON Briefsip. Periksa seluruh file sebelum menyimpan. Folder sumber tidak diubah; script tidak dijalankan.</p>
    <p className="muted">Maksimum 32 file dan 48 KB setelah dikemas. File binary tidak didukung; folder ditolak utuh jika ada file yang tidak valid.</p>
    <label>Folder<input type="file" multiple ref={element => { element?.setAttribute('webkitdirectory', ''); }} onChange={event => { void read(event.target.files); event.target.value = ''; }} /></label>
    <label>SKILL.md atau ekspor JSON<input type="file" accept=".md,.json" onChange={event => { void read(event.target.files); event.target.value = ''; }} /></label>
    {busy && <p role="status">Membaca file...</p>}{error && <p className="error" role="alert">{error}</p>}
  </fieldset>;
}

export function downloadSkillFolder(files: SkillFile[]) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'briefsip-skill-folder', version: 1, files })], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'briefsip-skill-folder.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
