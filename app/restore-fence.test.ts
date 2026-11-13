import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { initializeCanonicalSchema } from './schema.ts';
import { canonicalServerLock, prepareRestoreBootstrap, issueRestoreSession, restoreWorkspace, workspaceSnapshot } from './backup.ts';
import { createAuth, type HumanActor } from './auth.ts';
import { canonicalJson } from './protocol.ts';
import { fenceEvidenceBody, prepareRestoreFence, verifyRestoreFence, type FenceEvidence, type FenceRequest, type FenceTrust } from './restore-fence.ts';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'briefsip-fence-')), database = join(dir, 'restored.sqlite');
  let db = new DatabaseSync(join(dir, 'source.sqlite')); initializeCanonicalSchema(db);
  const owner: HumanActor = { accountId: '11111111-1111-4111-8111-111111111111', issuer: 'https://fixture.clerk.accounts.dev', subject: 'user_owner', sessionId: 'sess_owner', expiresAt: Date.now() + 300000 };
  const config = { origin: 'https://briefsip.example', issuer: owner.issuer, secretKey: 'sk_test_fixture', publishableKey: `pk_test_${Buffer.from('fixture.clerk.accounts.dev$').toString('base64')}` };
  const project = '22222222-2222-4222-8222-222222222222';
  db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES (?,?,?,?)').run(owner.accountId, owner.issuer, owner.subject, Date.now());
  db.prepare('INSERT INTO projects(id,account,name,private,deleted,revision) VALUES (?,?,?,1,0,1)').run(project, owner.accountId, 'Restore');
  db.prepare("INSERT INTO project_members(project,account,role,grant_revision,deleted) VALUES (?,?,'owner',1,0)").run(project, owner.accountId);
  const snapshot = await workspaceSnapshot(db); db.close();
  try { restoreWorkspace(snapshot.file, database, { canonicalOnly: true }); } finally { snapshot.cleanup(); }
  db = new DatabaseSync(database);
  const auth = () => createAuth(db, config);
  const bootstrap = prepareRestoreBootstrap(db), proof = issueRestoreSession(db, auth(), owner, bootstrap.bootstrap);
  const pair = generateKeyPairSync('ed25519');
  const trust: FenceTrust = { v: 1, endpoint: config.origin, controllerId: 'fixture-controller', targetId: 'restored-target', signingPublicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') };
  const prepare = () => prepareRestoreFence(db, auth(), owner, proof.session, proof.recoveryGeneration, trust);
  const signed = (request: FenceRequest, overrides: Partial<Omit<FenceEvidence, 'signature'>> = {}): FenceEvidence => {
    const unsigned = { request, fenceId: 'fixture-fence-1', processFenced: true as const, routeFenced: true as const, admissionsFenced: true as const, observedAt: Date.now(), expiresAt: Date.now() + 30000, ...overrides };
    return { ...unsigned, signature: sign(null, Buffer.from(canonicalJson(fenceEvidenceBody(unsigned))), pair.privateKey).toString('base64url') };
  };
  const verify = (input: unknown, pin: unknown = trust) => verifyRestoreFence(db, auth(), owner, proof.session, proof.recoveryGeneration, pin, input);
  return { dir, database, owner, config, proof, trust, prepare, signed, verify, db: () => db, auth,
    reopen() { db.close(); db = new DatabaseSync(database); }, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('signed infrastructure fence preflight survives restart and exact retry without activating restore', async () => {
  const f = await fixture();
  try {
    const request = f.prepare(), evidence = f.signed(request), before = f.db().prepare('SELECT * FROM authority_state').get();
    const result = f.verify(evidence);
    assert.deepEqual(result, { state: 'read_only_recovery', fenceVerified: true, requestId: request.requestId, fenceId: 'fixture-fence-1', expiresAt: evidence.expiresAt });
    assert.deepEqual(f.db().prepare('SELECT * FROM authority_state').get(), before);
    f.reopen(); assert.deepEqual(f.verify(evidence), result);
    assert.equal(f.db().prepare('SELECT count(*) n FROM tasks').get()!.n, 0);
    f.db().exec("CREATE TRIGGER reject_fence_request BEFORE UPDATE ON restore_fence_request BEGIN SELECT RAISE(ABORT,'fixture request failure'); END");
    assert.throws(() => f.prepare(), /fixture request failure/); assert.deepEqual(f.verify(evidence), result);
    f.db().exec('DROP TRIGGER reject_fence_request');
    f.prepare(); assert.throws(() => f.verify(evidence), /Bukti fence/);
    assert.equal(f.db().prepare('SELECT serving_state FROM authority_state').get()!.serving_state, 'read_only_recovery');
  } finally { f.close(); }
});

test('restore fence rejects forged, stale, mismatched, self-supplied and replaced-session proofs', async () => {
  const f = await fixture();
  try {
    const request = f.prepare(), evidence = f.signed(request), otherId = '33333333-3333-4333-8333-333333333333';
    const wrongKey = generateKeyPairSync('ed25519');
    for (const input of [
      { ...evidence, signature: sign(null, Buffer.from(canonicalJson(fenceEvidenceBody(evidence))), wrongKey.privateKey).toString('base64url') },
      { ...evidence, signature: evidence.signature + '=' },
      { ...evidence, signingPublicKey: f.trust.signingPublicKey },
      { ...evidence, processFenced: false }, { ...evidence, routeFenced: false }, { ...evidence, admissionsFenced: false },
      f.signed({ ...request, endpoint: 'https://other.example' }), f.signed({ ...request, controllerId: 'other' }), f.signed({ ...request, targetId: 'other' }),
      f.signed({ ...request, sourceAuthority: otherId }), f.signed({ ...request, recoveryGeneration: otherId }), f.signed({ ...request, ownerAccount: otherId }), f.signed({ ...request, requestId: otherId }),
      f.signed({ ...request, challenge: randomBytes(32).toString('base64url') }), f.signed(request, { observedAt: request.createdAt - 1 }),
      f.signed(request, { observedAt: Date.now() + 60000 }), f.signed(request, { expiresAt: Date.now() - 1 }), f.signed(request, { expiresAt: Date.now() + 120000 }),
    ]) assert.throws(() => f.verify(input));
    for (const pin of [{ ...f.trust, signingPublicKey: wrongKey.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') }, { ...f.trust, endpoint: 'https://other.example' }, { ...f.trust, targetId: 'other' }]) assert.throws(() => f.verify(evidence, pin));
    assert.throws(() => verifyRestoreFence(f.db(), f.auth(), f.owner, f.proof.session, f.proof.recoveryGeneration, undefined, evidence));
    assert.throws(() => verifyRestoreFence(f.db(), f.auth(), { ...f.owner, issuer: 'https://other.example' }, f.proof.session, f.proof.recoveryGeneration, f.trust, evidence));
    const gate = prepareRestoreBootstrap(f.db()), replacement = issueRestoreSession(f.db(), f.auth(), f.owner, gate.bootstrap);
    assert.throws(() => f.verify(evidence)); assert.throws(() => verifyRestoreFence(f.db(), f.auth(), f.owner, replacement.session, replacement.recoveryGeneration, f.trust, evidence));
    assert.equal(f.db().prepare('SELECT serving_state FROM authority_state').get()!.serving_state, 'read_only_recovery');
  } finally { f.close(); }
});

test('operator CLI creates and verifies bounded private fence files while keeping recovery read-only', async () => {
  const f = await fixture(), jwtKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sessionFile = join(f.dir, 'session.json'), trustFile = join(f.dir, 'trust.json'), evidenceFile = join(f.dir, 'evidence.json');
  for (const [path, value] of [[sessionFile, f.proof], [trustFile, f.trust]] as const) writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  const childSource = `globalThis.fetch=async input=>{const url=typeof input==='string'?input:input.url??String(input);if(url!=='https://api.clerk.com/v1/jwks')throw new Error('Unexpected fixture network: '+url);return new Response(process.env.FIXTURE_JWKS,{headers:{'Content-Type':'application/json'}})};try{const result=await(await import('./cli.ts')).cli(JSON.parse(process.env.FIXTURE_ARGS),undefined);console.log(JSON.stringify(result));process.exitCode=result.exitCode}catch(error){console.log(JSON.stringify({error:error.message}));process.exitCode=1}`;
  async function run(args: string[], subject = f.owner.subject) {
    const now = Math.floor(Date.now() / 1000), header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fence-cli', typ: 'JWT' })).toString('base64url'), claims = Buffer.from(JSON.stringify({ iss: f.config.issuer, sub: subject, sid: f.owner.sessionId, azp: f.config.origin, exp: now + 300, nbf: now - 1, iat: now - 1 })).toString('base64url');
    const token = `${header}.${claims}.${sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), jwtKeys.privateKey).toString('base64url')}`;
    return new Promise<{ code: number | null; value: Record<string, any>; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', childSource], { cwd: import.meta.dirname, env: { ...process.env, BRIEFSIP_ORIGIN: f.config.origin, CLERK_SECRET_KEY: f.config.secretKey, CLERK_PUBLISHABLE_KEY: f.config.publishableKey, CLERK_ISSUER: f.config.issuer, BRIEFSIP_RESTORE_TRUST: trustFile, FIXTURE_ARGS: JSON.stringify(args), FIXTURE_JWKS: JSON.stringify({ keys: [{ ...jwtKeys.publicKey.export({ format: 'jwk' }), kid: 'fence-cli', use: 'sig', alg: 'RS256' }] }) }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume(); child.on('error', reject); child.on('close', code => { try { resolve({ code, value: JSON.parse(output), output }); } catch { reject(new Error(output)); } }); child.stdin.end(JSON.stringify({ token }));
    });
  }
  const prepareArgs = ['restore', 'fence-request', '--db', f.database, '--session', sessionFile], verifyArgs = ['restore', 'verify-fence', '--db', f.database, '--session', sessionFile, '--evidence', evidenceFile];
  try {
    const lock = canonicalServerLock(f.database); try { const busy = await run(prepareArgs); assert.equal(busy.code, 1); assert.match(busy.value.error, /canonical/i); } finally { lock.close(); }
    const prepared = await run(prepareArgs); assert.equal(prepared.code, 0, prepared.output); assert.equal(prepared.value.state, 'read_only_recovery'); assert.equal(statSync(prepared.value.requestFile).mode & 0o777, 0o600); assert(!prepared.output.includes(f.proof.session));
    const request: FenceRequest = JSON.parse(readFileSync(prepared.value.requestFile, 'utf8')); writeFileSync(evidenceFile, JSON.stringify(f.signed(request)), { mode: 0o600 });
    const verified = await run(verifyArgs); assert.equal(verified.code, 0, verified.output); assert.equal(verified.value.fenceVerified, true); assert.deepEqual((await run(verifyArgs)).value, verified.value);
    const symlink = join(f.dir, 'proof-link.json'); symlinkSync(evidenceFile, symlink); assert.equal((await run([...verifyArgs.slice(0, -1), symlink])).code, 1); chmodSync(evidenceFile, 0o644); assert.equal((await run(verifyArgs)).code, 1); chmodSync(evidenceFile, 0o600);
    writeFileSync(evidenceFile, 'x'.repeat(65537)); assert.equal((await run(verifyArgs)).code, 1); writeFileSync(evidenceFile, JSON.stringify({ ...f.signed(request), routeFenced: false })); assert.equal((await run(verifyArgs)).code, 1);
    assert.equal((await run(['restore', 'activate', '--db', f.database])).code, 1); assert.equal(f.db().prepare('SELECT serving_state FROM authority_state').get()!.serving_state, 'read_only_recovery');
  } finally { f.close(); }
});
