import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';

// The kernel assigns listen(0) and outbound connections from ip_local_port_range. A test
// server that must keep its port across a launcher restart takes one below that range, so
// no other process can be handed the port while the server is down.
function ephemeralLow() {
  try { return Number(readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0]) || 32768; }
  catch { return 32768; }
}

export async function freePort() {
  const high = Math.min(ephemeralLow(), 32768), low = Math.max(1024, high - 12000);
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = low + Math.floor(Math.random() * (high - low));
    if (port === 4317 || port === 4318) continue;
    const socket = createServer();
    const bound = await new Promise(ready => {
      socket.once('error', () => ready(false));
      socket.listen(port, '127.0.0.1', () => ready(true));
    });
    if (bound) {
      await new Promise(ready => socket.close(ready));
      return port;
    }
  }
  throw new Error('No free test port below the ephemeral range.');
}
