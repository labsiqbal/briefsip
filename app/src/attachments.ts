// Attachment presentation adapted from T3 (MIT); see ../t3/provenance.json.
export type AttachmentFile = { id: string; name: string; size: number; type?: string; image?: boolean };
export function isAttachmentImage(file: Pick<AttachmentFile, 'name' | 'type' | 'image'>) {
  if (typeof file.image === 'boolean') return file.image;
  const type = file.type?.split(';', 1)[0].trim().toLowerCase();
  return type && type !== 'application/octet-stream' ? ['image/png', 'image/jpeg', 'image/webp'].includes(type) : /\.(png|jpe?g|webp)$/i.test(file.name);
}
export function attachmentSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Number((bytes / 1024).toFixed(1))} KiB` : `${Number((bytes / (1024 * 1024)).toFixed(1))} MiB`;
}
export function uploadLimitError(files: readonly Pick<AttachmentFile, 'size'>[], attachedCount: number) {
  if (files.length + attachedCount > 4) return 'Up to four attachments per message.';
  if (files.some(file => file.size > 10 * 1024 * 1024)) return 'Maximum file size is 10 MiB.';
  return '';
}
export const removeAttachment = (ids: readonly string[], id: string) => ids.filter(value => value !== id);
