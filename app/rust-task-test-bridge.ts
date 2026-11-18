import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import type { HumanActor } from './auth.ts';
import { deviceProofBody, type LinkChallengeResponse } from './device-protocol.ts';
import { ProtocolError, sha256, type Receipt } from './protocol.ts';
import { startRustServer } from './rust-test-server.ts';

type Result = { status: number; data: Record<string, unknown>; receipt: Receipt };
type Envelope = Omit<Result, 'status'> & { ok: true } | {
  ok: false;
  error: { code: string; message: string; retryable?: boolean; details?: Record<string, unknown> };
};
type Principal = { deviceId: string; generation: number; authorityGeneration: string };

export async function rustTaskTestBridge(database: string, signing: ReturnType<typeof generateKeyPairSync>, testPathPrefix?: string) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const auth = { secretKey: 'sk_test_fixture', publishableKey: 'pk_test_fixture', issuer: 'https://fixture.example', origin: 'https://briefsip.example', development: true, jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const app = await startRustServer({ database, auth, testKeyring: {}, testPathPrefix });
  let previousRequest = 0, session = '';
  const pause = new Int32Array(new SharedArrayBuffer(4));
  function authenticated(method: string, path: string, body: unknown, actor: HumanActor | Principal, token?: string) {
    const requestId = String((body as { requestId?: string })?.requestId ?? randomUUID());
    const raw = body === undefined ? '' : JSON.stringify(body), at = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = { Origin: auth.origin, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': requestId };
    if ('deviceId' in actor) {
      const proof = { deviceId: actor.deviceId, deviceGeneration: actor.generation, authorityGeneration: actor.authorityGeneration, requestId, nonce: randomBytes(32).toString('base64url'), iat: at, exp: at + 60, method, path, bodyDigest: sha256(raw) };
      headers.Authorization = `Device ${session}`;
      headers['X-Briefsip-Proof'] = JSON.stringify({ ...proof, signature: sign(null, Buffer.from(JSON.stringify(deviceProofBody(proof))), signing.privateKey).toString('base64url') });
      if (token) headers['X-Briefsip-Executor'] = token;
    } else {
      const input = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: actor.issuer, sub: actor.subject, sid: actor.sessionId, azp: auth.origin, exp: Math.floor(actor.expiresAt / 1000), nbf: at - 1, iat: at - 1 })).toString('base64url')}`;
      headers.Authorization = `Bearer ${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
    }
    return { headers, raw };
  }
  function request(path: string, body: unknown, actor: HumanActor | Principal, token?: string, recovery?: string): Result;
  function request(path: string, body: unknown, actor: HumanActor | Principal, token: string | undefined, recovery: string | undefined, asynchronous: true): Promise<Result>;
  function request(path: string, body: unknown, actor: HumanActor, token: undefined, recovery: undefined, asynchronous: false, method: 'PUT'): Result;
  function request(path: string, body: unknown, actor: HumanActor | Principal, token?: string, recovery?: string, asynchronous = false, method = body === undefined ? 'GET' : 'POST'): Result | Promise<Result> {
    // Leave room for the device proof limiter during fan-in tests.
    Atomics.wait(pause, 0, 0, Math.max(0, previousRequest + 51 - performance.now()));
    previousRequest = performance.now();
    const { headers, raw } = authenticated(method, path, body, actor, token);
    if (recovery) headers['X-Briefsip-Recovery'] = recovery;
    const decode = (status: number, value: Envelope): Result => {
      if (!value.ok) throw new ProtocolError(status, value.error.code, value.error.message, value.error.retryable, value.error.details);
      return { status, data: value.data, receipt: value.receipt };
    };
    if (asynchronous) return fetch(app.origin + path, { method, headers, signal: AbortSignal.timeout(30000), ...(body === undefined ? {} : { body: raw }) }).then(async response => decode(response.status, await response.json()));
    const args = ['--silent', '--show-error', '--max-time', '30', '--write-out', '\n%{http_code}', '--request', method, app.origin + path];
    for (const [name, value] of Object.entries(headers)) args.push('--header', `${name}: ${value}`);
    if (body !== undefined) args.push('--data-binary', '@-');
    const response = spawnSync('curl', args, { input: raw, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (response.error || response.status !== 0) throw response.error ?? new Error(response.stderr);
    const split = response.stdout.lastIndexOf('\n'), status = Number(response.stdout.slice(split + 1)), value = JSON.parse(response.stdout.slice(0, split));
    return decode(status, value);
  }
  const device = (op: string) => (principal: Principal, task: string, body: unknown, token: string) =>
    request(`/api/tasks/${task}/${op}`, body, principal, token);
  const tasks = {
    admit: (actor: HumanActor, body: unknown) => request('/api/tasks', body, actor),
    lookup: (actor: HumanActor, task: string, after = -1) => request(`/api/tasks/${task}${after < 0 ? '' : `?afterResultSequence=${after}`}`, undefined, actor),
    control: (actor: HumanActor, task: string, body: unknown) => request(`/api/tasks/${task}/control`, body, actor),
    answer: (actor: HumanActor, task: string, question: string, body: unknown) => request(`/api/tasks/${task}/questions/${question}/answer`, body, actor),
    recoverySession: (actor: HumanActor, task: string, body: unknown) => request(`/api/tasks/${task}/recovery-session`, body, actor),
    recoveryImport: (actor: HumanActor, task: string, body: unknown, proof: string) => request(`/api/tasks/${task}/recovery-import`, body, actor, undefined, proof),
    recoveryResults: (actor: HumanActor, task: string, body: unknown, proof: string) => request(`/api/tasks/${task}/recovery-results`, body, actor, undefined, proof),
    acquire: (principal: Principal, body: Record<string, unknown>, token: string) => request(`/api/devices/${principal.deviceId}/acquire`, body, principal, token),
    prepare: (principal: Principal, task: string, action: string, body: unknown, token: string) => request(`/api/tasks/${task}/actions/${action}/prepare`, body, principal, token),
    commit: (principal: Principal, task: string, action: string, body: unknown, token: string) => request(`/api/tasks/${task}/actions/${action}/commit`, body, principal, token),
    context: device('context'), execution: (...args: Parameters<ReturnType<typeof device>>) => device('execution')(...args).data, reconcile: device('reconcile'), contextMutations: device('context-mutations'),
    runContextMutation: async (principal: Principal, task: string, body: unknown, token: string) => request(`/api/tasks/${task}/context-mutations`, body, principal, token, undefined, true),
    waitSecretResult: (principal: Principal, body: unknown) => request(`/api/devices/${principal.deviceId}/wait-secret-results`, body, principal),
  };
  const access = {
    createProject: (actor: HumanActor, body: unknown) => request('/api/projects', body, actor),
    createAgent: (actor: HumanActor, body: unknown) => request('/api/agents', body, actor),
    editAgentRules: (actor: HumanActor, project: string, agent: string, body: unknown) =>
      request(`/api/projects/${project}/agents/${agent}/rules`, body, actor, undefined, undefined, false, 'PUT'),
  };
  const devices = {
    createChallenge: (actor: HumanActor, body: unknown) => request('/api/devices/link-challenges', body, actor).data as LinkChallengeResponse,
    link: (actor: HumanActor, body: unknown) => {
      const result = request('/api/devices/link', body, actor);
      if (typeof result.data.deviceSession !== 'string') throw new Error('Rust did not issue a device session.');
      session = result.data.deviceSession;
      return result;
    },
    connect: async (principal: Principal, zone: string, zoneRevision: number) => {
      const path = `/api/devices/${principal.deviceId}/stream`;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 5000);
      try {
        const { headers } = authenticated('GET', path, undefined, principal);
        const response = await fetch(app.origin + path, { headers, signal: abort.signal });
        if (!response.ok || !response.body) throw new Error(`Device stream failed with HTTP ${response.status}`);
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let data = '';
        while (!data.includes('\n')) {
          const next = await reader.read();
          if (next.done) throw new Error('Device stream closed before the connected frame.');
          data += decoder.decode(next.value, { stream: true });
        }
        reader.releaseLock();
        const frame = JSON.parse(data.slice(0, data.indexOf('\n')));
        if (frame.kind !== 'connected') throw new Error('Rust did not acknowledge the device connection.');
        request(`/api/devices/${principal.deviceId}/heartbeat`, {
          requestId: randomUUID(), connectionGeneration: frame.connectionGeneration, zone, zoneRevision, journalWatermark: 0,
        }, principal);
        return () => abort.abort();
      } catch (error) {
        abort.abort();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    revoke: (actor: HumanActor, device: string, body: unknown) => request(`/api/devices/${device}/revoke`, body, actor),
  };
  return { tasks, access, devices, close: app.close };
}
