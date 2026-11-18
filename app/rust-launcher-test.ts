import { connect } from 'node:net';

export async function launcherRequest(options: { launcherSocket: string }, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(options.launcherSocket);
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { raw += chunk; });
    socket.on('error', reject);
    socket.on('close', () => {
      try {
        const value = JSON.parse(raw.trim());
        if (value.error) reject(new Error(String(value.error)));
        else resolve(value);
      } catch (error) { reject(error); }
    });
    socket.on('connect', () => socket.end(JSON.stringify(request) + '\n'));
  });
}
