// Test-only binary WebSocket + RFB 3.8 client. Raw encoding keeps framebuffer assertions exact.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';

export class Bytes {
  private data: Buffer = Buffer.alloc(0);
  private waiter?: () => void;
  private error?: Error;
  push(chunk: Buffer) { this.data = Buffer.concat([this.data, chunk]); this.waiter?.(); }
  close() { this.error = new Error('Test connection closed.'); this.waiter?.(); }
  async read(size: number) {
    const deadline = Date.now() + 15000;
    while (this.data.length < size) {
      if (this.error) throw this.error;
      if (Date.now() >= deadline) throw new Error('Test connection read timed out.');
      await new Promise<void>(resolve => { const timer = setTimeout(() => { this.waiter = undefined; resolve(); }, 100); this.waiter = () => { clearTimeout(timer); this.waiter = undefined; resolve(); }; });
    }
    const data = Buffer.from(this.data.subarray(0, size)); this.data = this.data.subarray(size); return data;
  }
}
export function maskedFrame(data: Buffer, opcode = 2, fin = true) {
  const size = data.length, header = Buffer.alloc(size < 126 ? 6 : size < 65536 ? 8 : 14), mask = randomBytes(4);
  header[0] = (fin ? 128 : 0) | opcode;
  if (size < 126) header[1] = 128 | size;
  else if (size < 65536) { header[1] = 128 | 126; header.writeUInt16BE(size, 2); }
  else { header[1] = 128 | 127; header.writeBigUInt64BE(BigInt(size), 2); }
  mask.copy(header, header.length - 4); const payload = Buffer.from(data); for (let i = 0; i < size; i++) payload[i] ^= mask[i % 4];
  return Buffer.concat([header, payload]);
}
export async function connectVnc(url: string, origin: string, extraHeaders: Record<string, string> = {}) {
  const target = new URL(url); target.protocol = 'http:';
  return new Promise<RfbTestClient>((resolve, reject) => {
    const req = request(target, { headers: { Origin: origin, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Protocol': 'binary', ...extraHeaders } });
    req.once('upgrade', (_res, socket, head) => { resolve(new RfbTestClient(socket, head)); });
    req.once('response', res => { res.resume(); reject(new Error('WebSocket HTTP ' + res.statusCode)); }); req.once('error', reject); req.end();
  });
}
export class RfbTestClient {
  readonly bytes = new Bytes();
  readonly socket: Duplex;
  width = 0;
  height = 0;
  framebuffer: Buffer = Buffer.alloc(0);
  closed = false;
  constructor(socket: Duplex, head: Buffer) {
    this.socket = socket; const frames = new Bytes(); if (head.length) frames.push(head);
    socket.on('data', data => frames.push(Buffer.from(data))); socket.once('close', () => { this.closed = true; frames.close(); this.bytes.close(); }); socket.on('error', () => frames.close());
    void (async () => { try { for (;;) { const h = await frames.read(2); const opcode = h[0] & 15; let length = h[1] & 127; if (length === 126) length = (await frames.read(2)).readUInt16BE(); else if (length === 127) length = Number((await frames.read(8)).readBigUInt64BE()); assert(length < 32 * 1024 * 1024); const payload = await frames.read(length); if (opcode === 2) this.bytes.push(payload); if (opcode === 8) break; } } catch {} finally { this.bytes.close(); } })();
  }
  send(bytes: Buffer) { this.socket.write(maskedFrame(bytes)); }
  close() { this.socket.destroy(); }
  async handshake() {
    assert.equal((await this.bytes.read(12)).toString(), 'RFB 003.008\n'); this.send(Buffer.from('RFB 003.008\n'));
    const count = (await this.bytes.read(1))[0]; assert([...await this.bytes.read(count)].includes(1)); this.send(Buffer.from([1]));
    assert.equal((await this.bytes.read(4)).readUInt32BE(), 0); this.send(Buffer.from([1]));
    const init = await this.bytes.read(24); this.width = init.readUInt16BE(); this.height = init.readUInt16BE(2); await this.bytes.read(init.readUInt32BE(20));
    this.framebuffer = Buffer.alloc(this.width * this.height * 4);
    const pixel = Buffer.alloc(20); pixel[0] = 0; pixel[4] = 32; pixel[5] = 24; pixel[7] = 1; pixel.writeUInt16BE(255, 8); pixel.writeUInt16BE(255, 10); pixel.writeUInt16BE(255, 12); pixel[14] = 16; pixel[15] = 8;
    this.send(pixel); this.send(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]));
  }
  requestFrame(incremental = true) {
    const b = Buffer.alloc(10); b[0] = 3; b[1] = incremental ? 1 : 0; b.writeUInt16BE(this.width, 6); b.writeUInt16BE(this.height, 8); this.send(b);
  }
  async frame() {
    for (;;) {
      const type = (await this.bytes.read(1))[0]; if (type === 2) continue; assert.equal(type, 0);
      const header = await this.bytes.read(3), count = header.readUInt16BE(1);
      for (let i = 0; i < count; i++) {
        const rect = await this.bytes.read(12), x = rect.readUInt16BE(), y = rect.readUInt16BE(2), w = rect.readUInt16BE(4), h = rect.readUInt16BE(6), encoding = rect.readInt32BE(8); assert.equal(encoding, 0);
        const pixels = await this.bytes.read(w * h * 4);
        for (let row = 0; row < h; row++) pixels.copy(this.framebuffer, ((y + row) * this.width + x) * 4, row * w * 4, (row + 1) * w * 4);
      }
      if (count) return Buffer.from(this.framebuffer);
    }
  }
  pointer(x: number, y: number, buttons = 0) { const b = Buffer.alloc(6); b[0] = 5; b[1] = buttons; b.writeUInt16BE(x, 2); b.writeUInt16BE(y, 4); this.send(b); }
  key(keysym: number, down: boolean) { const b = Buffer.alloc(8); b[0] = 4; b[1] = down ? 1 : 0; b.writeUInt32BE(keysym, 4); this.send(b); }
  text(text: string) { for (const char of text) { this.key(char.codePointAt(0)!, true); this.key(char.codePointAt(0)!, false); } }
}
