import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import type { HumanActor } from './auth.ts';
import { deviceProofBody } from './devices.ts';
import type { createTaskRecovery } from './task-recovery.ts';
import { ProtocolError, sha256 } from './protocol.ts';
import { startCanonicalApp } from './test-bridge.ts';

type Result = ReturnType<ReturnType<typeof createTaskRecovery>['admit']>;
type Principal = { deviceId: string; generation: number; authorityGeneration: string };

export async function rustTaskTestBridge(database: string, signing: ReturnType<typeof generateKeyPairSync>, session: string) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const auth = { secretKey: 'sk_test_fixture', publishableKey: 'pk_test_fixture', issuer: 'https://fixture.example', origin: 'https://briefsip.example', development: true, jwtKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const app = await startCanonicalApp({ database, auth, testKeyring: {} });
  let previousRequest = 0;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  function request(path: string, body: unknown, actor: HumanActor | Principal, token?: string, recovery?: string): Result;
  function request(path: string, body: unknown, actor: HumanActor | Principal, token: string | undefined, recovery: string | undefined, asynchronous: true): Promise<Result>;
  function request(path: string, body: unknown, actor: HumanActor | Principal, token?: string, recovery?: string, asynchronous = false): Result | Promise<Result> {
    Atomics.wait(pause, 0, 0, Math.max(0, previousRequest + 51 - performance.now()));
    previousRequest = performance.now();
    const method = body === undefined ? 'GET' : 'POST', requestId = String((body as { requestId?: string })?.requestId ?? randomUUID());
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
    if (recovery) headers['X-Briefsip-Recovery'] = recovery;
    const decode = (status: number, value: any): Result => {
      if (!value.ok) throw new ProtocolError(status, value.error.code, value.error.message, value.error.retryable, value.error.details);
      return { status, data: value.data, receipt: value.receipt };
    };
    if (asynchronous) return fetch(app.origin + path, { method, headers, ...(body === undefined ? {} : { body: raw }) }).then(async response => decode(response.status, await response.json()));
    const args = ['--silent', '--show-error', '--max-time', '30', '--write-out', '\n%{http_code}', '--request', method, app.origin + path];
    for (const [name, value] of Object.entries(headers)) args.push('--header', `${name}: ${value}`);
    if (body !== undefined) args.push('--data-binary', '@-');
    const response = spawnSync('curl', args, { input: raw, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (response.error || response.status !== 0) throw response.error ?? new Error(response.stderr);
    const split = response.stdout.lastIndexOf('\n'), status = Number(response.stdout.slice(split + 1)), value = JSON.parse(response.stdout.slice(0, split));
    return decode(status, value);
  }
  const device = (op: string) => (principal: Principal, task: string, body: unknown, token: string) => {
    const result = request(`/api/tasks/${task}/${op}`, body, principal, token);
    return op === 'execution' ? result.data : result;
  };
  const tasks = {
    admit: (actor: HumanActor, body: unknown) => request('/api/tasks', body, actor),
    lookup: (actor: HumanActor, task: string, after = -1) => request(`/api/tasks/${task}${after < 0 ? '' : `?afterResultSequence=${after}`}`, undefined, actor),
    control: (actor: HumanActor, task: string, body: unknown) => request(`/api/tasks/${task}/control`, body, actor),
    answer: (actor: HumanActor, task: string, question: string, body: unknown) => request(`/api/tasks/${task}/questions/${question}/answer`, body, actor),
    recoverySession: (actor: HumanActor, task: string, body: unknown) => request(`/api/tasks/${task}/recovery-session`, body, actor),
    recoveryImport: (actor: HumanActor, task: string, body: unknown, proof: string) => request(`/api/tasks/${task}/recovery-import`, body, actor, undefined, proof),
    recoveryResults: (actor: HumanActor, task: string, body: unknown, proof: string) => request(`/api/tasks/${task}/recovery-results`, body, actor, undefined, proof),
    acquire: (principal: Principal, body: { taskId: string }, token: string) => request(`/api/devices/${principal.deviceId}/acquire`, body, principal, token),
    prepare: (principal: Principal, task: string, action: string, body: unknown, token: string) => request(`/api/tasks/${task}/actions/${action}/prepare`, body, principal, token),
    commit: (principal: Principal, task: string, action: string, body: unknown, token: string) => request(`/api/tasks/${task}/actions/${action}/commit`, body, principal, token),
    context: device('context'), execution: device('execution'), reconcile: device('reconcile'), contextMutations: device('context-mutations'),
    runContextMutation: async (principal: Principal, task: string, body: unknown, token: string) => request(`/api/tasks/${task}/context-mutations`, body, principal, token, undefined, true),
    waitSecretResult: (principal: Principal, body: unknown) => request(`/api/devices/${principal.deviceId}/wait-secret-results`, body, principal),
  } as unknown as ReturnType<typeof createTaskRecovery>;
  return { tasks, close: app.close };
}
