import { downloadBlob } from './hooks/downloadBlob';
import { useEffect, useRef, useState } from 'react';
import { FileUp, FolderUp } from 'lucide-react';
import { Button } from './ui/kit';
import { exportedSkillFiles, parseSkillFiles, skillFileFromBytes, type SkillFile } from '../shared/skill-files';
import { readSkillZip, writeSkillZip } from '../shared/skill-zip';

export function SkillFolderImport({ disabled, onImport, onBusy, compact = false, onError }: { disabled: boolean; onImport: (files: SkillFile[]) => void; onBusy: (busy: boolean) => void; compact?: boolean; onError?: (message: string) => void }) {
  const [busy, setBusy] = useState(false), [error, setErrorState] = useState('');
  const setError = (message: string) => { setErrorState(message); if (message) onError?.(message); };
  const folderInput = useRef<HTMLInputElement>(null), fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function read(selected: FileList | null) {
    if (!selected?.length || disabled || busy) return;
    const current = ++generation.current; setBusy(true); onBusy(true); setError('');
    try {
      const input = Array.from(selected);
      const zip = input.length === 1 && !input[0].webkitRelativePath && /\.zip$/i.test(input[0].name);
      if (input.length > 32 || input.reduce((size, file) => size + file.size, 0) > (zip ? 3 * 1024 * 1024 : 4 * 1024 * 1024)) throw new Error('Choose up to 32 files totaling 4 MiB, or one ZIP up to 3 MiB.');
      const texts = zip ? [] : await Promise.all(input.map(async file => skillFileFromBytes(file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name, new Uint8Array(await file.arrayBuffer()))));
      let files: unknown = zip ? await readSkillZip(new Uint8Array(await input[0].arrayBuffer())) : texts;
      if (input.length === 1 && !input[0].webkitRelativePath && input[0].name.endsWith('.json')) {
        if (texts[0].encoding) throw new Error('JSON exports must be UTF-8 text.');
        files = exportedSkillFiles(JSON.parse(texts[0].content));
      }
      const parsed = parseSkillFiles(files);
      if (input[0].webkitRelativePath && input[0].webkitRelativePath.split('/')[0] !== parsed.name) throw new Error('Folder name must match the name in SKILL.md.');
      if (current === generation.current) onImport(parsed.files);
    } catch (error) { if (current === generation.current) setError(error instanceof Error && !(error instanceof TypeError) ? error.message : 'Files could not be read. Choose a UTF-8 folder or an undamaged standard ZIP.'); }
    finally { if (current === generation.current) { setBusy(false); onBusy(false); } }
  }
  if (compact) return <>
    <input ref={element => { if (element) { element.setAttribute('webkitdirectory', ''); (folderInput as { current: HTMLInputElement | null }).current = element; } }} type="file" multiple hidden onChange={event => { void read(event.target.files); event.target.value = ''; }} />
    <input ref={fileInput} type="file" accept=".md,.json,.zip" hidden onChange={event => { void read(event.target.files); event.target.value = ''; }} />
    <Button size="sm" variant="ghost" icon={<FolderUp size={14} aria-hidden />} disabled={disabled} busy={busy} onClick={() => folderInput.current?.click()} title="Folder containing SKILL.md and supporting files">Import folder</Button>
    <Button size="sm" variant="ghost" icon={<FileUp size={14} aria-hidden />} disabled={disabled || busy} onClick={() => fileInput.current?.click()} title="SKILL.md, ZIP, or Minarbot JSON export">Import file</Button>
  </>;
  return <fieldset disabled={disabled || busy}><legend>Import skill folder</legend>
    <p>Choose a folder containing SKILL.md and supporting files, a ZIP, or a Minarbot JSON export. Review all files before saving. The source folder is unchanged; scripts are not run.</p>
    <p className="muted">Up to 32 files, 48 KB of text and 2 MiB of binary assets. Assets are stored for export; agents do not run them or read them as text. The entire folder is rejected if any file is invalid.</p>
    <label>Folder<input type="file" multiple ref={element => { element?.setAttribute('webkitdirectory', ''); }} onChange={event => { void read(event.target.files); event.target.value = ''; }} /></label>
    <label>SKILL.md, ZIP, or JSON export<input type="file" accept=".md,.json,.zip" onChange={event => { void read(event.target.files); event.target.value = ''; }} /></label>
    {busy && <p role="status">Reading files...</p>}{error && <p className="error" role="alert">{error}</p>}
  </fieldset>;
}

export function downloadSkillFolder(files: SkillFile[], zip = false) {
  downloadBlob(new Blob([zip ? writeSkillZip(files) : JSON.stringify({ format: 'minarbot-skill-folder', version: 1, files })], { type: zip ? 'application/zip' : 'application/json' }), zip ? `${parseSkillFiles(files).name}.zip` : 'minarbot-skill-folder.json');
}
