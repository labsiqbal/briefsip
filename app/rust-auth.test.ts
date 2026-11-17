import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createClerkClient } from '@clerk/backend';
import { initializeCanonicalSchema } from './schema.ts';
import { startCanonicalApp } from './server.ts';
import { startRustServer } from './rust-test-server.ts';

test('Rust Clerk sessions match Node response bytes, metadata errors, account scope and durable logout', { skip: process.env.BRIEFSIP_TEST_SERVER !== 'rust' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'briefsip-rust-auth-'));
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwtKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const auth = { secretKey: 'sk_test_fixture', publishableKey: `pk_test_${Buffer.from('fixture.clerk.accounts.dev$').toString('base64')}`, issuer: 'https://fixture.clerk.accounts.dev', origin: 'https://briefsip.example', development: true };
  const account = randomUUID(), project = randomUUID();
  const token = (overrides: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const input = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: auth.issuer, sub: 'user_fixture', sid: 'sess_fixture', azp: auth.origin, exp: now + 60, nbf: now - 1, iat: now - 1, ...overrides })).toString('base64url')}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
  };
  for (const name of ['node', 'rust']) {
    const db = new DatabaseSync(join(root, name)); initializeCanonicalSchema(db);
    db.prepare('INSERT INTO accounts(id,issuer,clerk_sub,created) VALUES(?,?,?,?)').run(account, auth.issuer, 'user_fixture', Date.now());
    db.prepare('INSERT INTO projects(id,account,name,private) VALUES(?,?,?,0)').run(project, account, 'Fixture');
    db.prepare("INSERT INTO project_members VALUES(?,?,'owner',1,0)").run(project, account); db.close();
  }
  const clerk = createClerkClient({ secretKey: auth.secretKey, publishableKey: auth.publishableKey, jwtKey, telemetry: { disabled: true } });
  const upstream = createServer((_req,res) => { res.statusCode = 503; res.end('{}'); });
  await new Promise<void>(ready => upstream.listen(0,'127.0.0.1',ready));
  const address = upstream.address(); assert(address && typeof address !== 'string');
  const rustAuth = { ...auth, jwtKey, apiUrl: `http://127.0.0.1:${address.port}` };
  const node = await startCanonicalApp({ database: join(root, 'node'), auth, clerk });
  let rust = await startRustServer({ database: join(root, 'rust'), auth: rustAuth });
  const compare = async (path: string, options: { method?: string; headers?: Record<string,string>; body?: string } = {}) => {
    const requestId = randomUUID();
    const headers = { Authorization: `Bearer ${token()}`, Origin: auth.origin, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': requestId, ...options.headers };
    const replies = await Promise.all([node.origin, rust.origin].map(async origin => { const response = await fetch(origin + path, { ...options, headers }); return { status: response.status, body: await response.text(), headers: Object.fromEntries(['content-type', 'cache-control', 'x-content-type-options', 'x-briefsip-protocol', 'x-briefsip-request-id', 'set-cookie'].map(key => [key,response.headers.get(key)])) }; }));
    assert.deepEqual(replies[1], replies[0]); return replies[1];
  };
  try {
    assert.equal((await compare('/api/session')).status, 200);
    for (const overrides of [{ exp: Math.floor(Date.now()/1000) }, { nbf: Math.floor(Date.now()/1000)+30 }, { iss: 'https://wrong.example' }, { azp: 'https://wrong.example' }, { sub: '' }, { sid: '' }, { sts: 'pending' }]) assert.equal((await compare('/api/session', { headers: { Authorization: `Bearer ${token(overrides)}` } })).status, 401);
    const invalidHeaders: Record<string,string>[] = [{ 'X-Briefsip-Protocol': '2' }, { 'Content-Type': 'text/plain' }, { 'X-Briefsip-Request-Id': 'invalid' }, { Authorization: '' }, { Authorization: '', Cookie: `__session=${token()}` }];
    for (const headers of invalidHeaders) await compare('/api/session', { headers });
    await compare('/api/session?invalid=1');
    await compare('/api/session/logout', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' });
    const id = randomUUID();
    await compare('/api/session/logout', { method: 'POST', headers: { 'X-Briefsip-Request-Id': id }, body: `{"requestId":"${id}","requestId":"${id}"}` });
    await compare('/api/session/logout', { method: 'POST', headers: { 'X-Briefsip-Request-Id': id }, body: JSON.stringify({ requestId: id, extra: true }) });
    await compare('/api/session/logout', { method: 'POST', body: JSON.stringify({ requestId: 'invalid' }) });
    for (const body of ['{}', '[]', 'null', '"text"', JSON.stringify({ requestId: randomUUID() }), JSON.stringify({ requestId: id, extra: 'x'.repeat(65536) })]) await compare('/api/session/logout', { method: 'POST', headers: { 'X-Briefsip-Request-Id': id }, body });
    const response = await fetch(rust.origin + '/api/session/logout', { method: 'POST', headers: { Authorization: `Bearer ${token()}`, Origin: auth.origin, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': id }, body: JSON.stringify({ requestId: id }) });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, data: { state: 'upstream_pending' } });
    await rust.close(); rust = await startRustServer({ database: join(root, 'rust'), auth: rustAuth });
    const denied = await fetch(rust.origin + '/api/session', { headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', 'X-Briefsip-Protocol': '1', 'X-Briefsip-Request-Id': randomUUID() } }); assert.equal(denied.status, 401); await denied.text();
  } finally { await rust.close(); await node.close(); upstream.closeAllConnections(); await new Promise<void>(ready => upstream.close(() => ready())); rmSync(root, { recursive: true, force: true }); }
});

test('Rust JWKS rotates keys, rejects unknown signatures and enforces audience', { skip: process.env.BRIEFSIP_TEST_SERVER !== 'rust' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'briefsip-rust-jwks-'));
  const keys = [generateKeyPairSync('rsa', { modulusLength: 2048 }), generateKeyPairSync('rsa', { modulusLength: 2048 })];
  let rotated = false, calls = 0;
  const api = createServer((req,res) => { res.setHeader('Content-Type','application/json'); if (req.url === '/v1/jwks') { calls++; res.end(JSON.stringify({ keys: keys.slice(0,rotated?2:1).map((key,index) => ({ ...key.publicKey.export({ format:'jwk' }), kid:String(index), use:'sig', alg:'RS256' })) })); } else { res.statusCode=503; res.end('{}'); } });
  await new Promise<void>(ready => api.listen(0,'127.0.0.1',ready)); const address=api.address(); assert(address&&typeof address!=='string');
  const auth = { secretKey:'sk_test_fixture',publishableKey:'pk_test_fixture',issuer:'https://fixture.clerk.accounts.dev',origin:'https://briefsip.example',development:true,audience:'briefsip',apiUrl:`http://127.0.0.1:${address.port}` };
  const app=await startRustServer({database:join(root,'db.sqlite'),auth});
  const send=async (index:number,overrides:Record<string,unknown>={}) => { const now=Math.floor(Date.now()/1000); const input=`${Buffer.from(JSON.stringify({alg:'RS256',kid:String(index)})).toString('base64url')}.${Buffer.from(JSON.stringify({iss:auth.issuer,sub:'user_fixture',sid:'sess_fixture',azp:auth.origin,nbf:now-1,exp:now+60,aud:'briefsip',...overrides})).toString('base64url')}`; const jwt=`${input}.${sign('RSA-SHA256',Buffer.from(input),keys[index%2].privateKey).toString('base64url')}`; const response=await fetch(app.origin+'/api/session',{headers:{Authorization:`Bearer ${jwt}`,'Content-Type':'application/json','X-Briefsip-Protocol':'1','X-Briefsip-Request-Id':randomUUID()}}); const body=await response.json(); return {status:response.status,body}; };
  try { const first=await send(0); assert.equal(first.status,200); assert(calls>0); rotated=true; const before=calls; assert.equal((await send(1)).body.data.accountId,first.body.data.accountId); assert(calls>before); assert.equal((await send(2)).status,401); assert.equal((await send(0,{aud:'wrong'})).status,401); assert.equal((await send(0,{aud:['other','briefsip']})).status,200); }
  finally { await app.close(); api.closeAllConnections(); await new Promise<void>(ready=>api.close(()=>ready())); rmSync(root,{recursive:true,force:true}); }
});

test('Rust and Node cross-open every canonical schema version and reject migration drift', { skip: process.env.BRIEFSIP_TEST_SERVER !== 'rust' }, async () => {
  const root=mkdtempSync(join(tmpdir(),'briefsip-rust-schema-'));
  const auth={secretKey:'sk_test_fixture',publishableKey:'pk_test_fixture',issuer:'https://fixture.clerk.accounts.dev',origin:'https://briefsip.example',development:true};
  const inspect=(database:string) => { const db=new DatabaseSync(database); try { initializeCanonicalSchema(db); return db.prepare("SELECT type,name,tbl_name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row => ({...row, ...(row.type==='table'?{columns:db.prepare(`PRAGMA table_info(${row.name})`).all()}:{} )})); } finally {db.close();} };
  try {
    const reference=join(root,'reference'),expected=inspect(reference);
    for (const version of [1,2,3,4] as const) {
      const database=join(root,`v${version}`),db=new DatabaseSync(database); initializeCanonicalSchema(db,123,version); db.close();
      const app=await startRustServer({database,auth}); await app.close(); assert.deepEqual(inspect(database),expected,`Node v${version} upgraded by Rust`);
    }
    const database=join(root,'rust-new'),app=await startRustServer({database,auth});
    try { const second=await startRustServer({database,auth}).then(async server => { await server.close(); return true; }, error => { assert.match(error.message,/Another canonical server is still running/); return false; }); assert.equal(second,false); }
    finally { await app.close(); }
    assert.deepEqual(inspect(database),expected,'Rust schema reopened by Node');
    const db=new DatabaseSync(database); db.prepare("INSERT INTO schema_migrations VALUES(5,'future','future',0)").run(); db.close();
    await assert.rejects(startRustServer({database,auth}),/Database schema is newer than this server/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('Rust canonical TLS serves protocol errors over a verified fixture certificate', { skip: process.env.BRIEFSIP_TEST_SERVER !== 'rust' }, async () => {
  const root=mkdtempSync(join(tmpdir(),'briefsip-rust-tls-'));
  try {
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key'),'-out',join(root,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
    const cert=readFileSync(join(root,'cert'),'utf8'),key=readFileSync(join(root,'key'),'utf8');
    const app=await startRustServer({database:join(root,'db.sqlite'),tls:{cert,key},auth:{secretKey:'sk_test_fixture',publishableKey:'pk_test_fixture',issuer:'https://fixture.clerk.accounts.dev',origin:'https://briefsip.example'}});
    try {
      assert(app.origin.startsWith('https:'));
      const response=await new Promise<{status:number;body:string}>((ready,reject)=>{ const request=httpsRequest(app.origin+'/api/session',{ca:cert},response=>{let body='';response.setEncoding('utf8');response.on('data',chunk=>{body+=chunk;});response.on('end',()=>ready({status:response.statusCode!,body}));});request.on('error',reject);request.end(); });
      assert.equal(response.status,426);assert.deepEqual(JSON.parse(response.body),{ok:false,error:{code:'unsupported_version',message:'Unsupported protocol version.',retryable:false,requestId:''}});
    } finally {await app.close();}
  } finally {rmSync(root,{recursive:true,force:true});}
});
