import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function connection(directory: string) {
  try {
    const folder = lstatSync(directory);
    if (!folder.isDirectory() || folder.uid !== process.getuid?.() || (folder.mode & 0o077)) throw new Error();
    const fd = openSync(join(directory, 'connection.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const file = fstatSync(fd);
      if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) || file.size > 4096) throw new Error();
      const value = JSON.parse(readFileSync(fd, 'utf8')), url = new URL(value.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== value.url || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value.token)) throw new Error();
      return { url: value.url as string, token: value.token as string };
    } finally { closeSync(fd); }
  } catch { throw new Error('Script discovery is unavailable or unsafe.'); }
}

export class LocalAgentError extends Error {
  status: number;
  constructor(status: number){super(`Local agent request rejected (${status}).`);this.status=status;}
}

export function localScript(directory: string) {
  return async (path: string, body?: unknown, signal?: AbortSignal, filename?:string, binary=false): Promise<any> => {
    const current = connection(directory);
    const response = await fetch(current.url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${current.token}`, 'Content-Type': filename?'application/octet-stream':'application/json',...(filename?{'X-File-Name':encodeURIComponent(filename)}:{}) }, body: filename?Buffer.from(body as Uint8Array):body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]) });
    if (!response.ok) { await response.body?.cancel(); throw new LocalAgentError(response.status); }
    if (!response.body) throw new Error('Missing local agent response');
    const reader=response.body.getReader(), chunks: Uint8Array[]=[]; let size=0;
    try { while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>(binary?10:2)*1024*1024)throw new Error('Local agent response exceeds limit');chunks.push(part.value);} }
    finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    return binary?Buffer.concat(chunks):JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
}
