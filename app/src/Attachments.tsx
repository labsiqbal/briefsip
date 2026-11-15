// Thumbnail strip, file rows and image expansion adapted from T3 (MIT); see ../t3/provenance.json.
import { useState } from 'react';
import { Download, File, FileArchive, FileAudio, FileCode, FileText, FileVideo, ImageOff, X } from 'lucide-react';
import { Alert, Dialog, IconButton } from './ui/kit';
import { attachmentSize, isAttachmentImage, type AttachmentFile } from './attachments';
import './attachments.css';

export function Attachment({ file, path, onOpen, onRemove, disabled }: { file: AttachmentFile; path: string; onOpen?: () => void; onRemove?: () => void; disabled?: boolean }) {
  const image = isAttachmentImage(file), [expanded, setExpanded] = useState(false), [failed, setFailed] = useState(false);
  const Icon = /\.(zip|gz|tar|7z)$/i.test(file.name) ? FileArchive : /\.(mp3|wav|ogg|m4a|webm)$/i.test(file.name) ? FileAudio : /\.(mp4|mov)$/i.test(file.name) ? FileVideo : /\.(tsx?|jsx?|json|html?|css|py|sh)$/i.test(file.name) ? FileCode : /\.(txt|md|pdf|csv)$/i.test(file.name) ? FileText : File;
  const content = image ? failed ? <ImageOff size={20} aria-label="Image unavailable" /> : <img src={`${path}?preview=image`} alt={file.name} loading="lazy" onError={() => setFailed(true)} /> : <><Icon size={18} aria-hidden /><span className="attachment__identity"><span className="attachment__name">{file.name}</span><span className="attachment__size">{attachmentSize(file.size)}</span></span></>;
  const className = `attachment__open${image ? ' attachment__image' : ' attachment__file'}`;
  return <div className={`attachment${image ? ' is-image' : ''}${onRemove ? ' is-removable' : ''}`}>
    {image || onOpen ? <button type="button" className={className} aria-label={`Preview ${file.name}`} title={file.name} onClick={() => onOpen ? onOpen() : setExpanded(true)}>{content}</button> : <a className={className} href={path} download={file.name} title={file.name}>{content}</a>}
    {onRemove && <IconButton className="attachment__remove" label={`Remove ${file.name}`} disabled={disabled} onClick={onRemove}><X size={12} aria-hidden /></IconButton>}
    {expanded && <Dialog open onOpenChange={setExpanded} title={file.name} size="lg" footer={<a className="k-link k-inline" href={path} download={file.name}><Download size={14} aria-hidden />Download</a>}>
      {failed ? <Alert tone="error">Image preview unavailable. Download original.</Alert> : <img className="attachment__preview" src={`${path}?preview=image`} alt={file.name} onError={() => setFailed(true)} />}
    </Dialog>}
  </div>;
}

export function Attachments({ files, path, label = 'Message attachments', onRemove, disabled }: { files: AttachmentFile[]; path: string; label?: string; onRemove?: (id: string) => void; disabled?: boolean }) {
  const render = (file: AttachmentFile) => <Attachment key={file.id} file={file} path={`${path}/${encodeURIComponent(file.id)}`} onRemove={onRemove ? () => onRemove(file.id) : undefined} disabled={disabled} />;
  return <div className="attachments" role="group" aria-label={label}>
    {files.map(render)}
  </div>;
}
