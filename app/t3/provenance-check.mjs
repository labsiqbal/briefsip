import { productEnv } from '../../desktop/src/rename-env.mjs';
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const app = resolve(root, "app");
const { values } = parseArgs({ options: { source: { type: "string" }, receipt: { type: "string" }, phase: { type: "boolean" } } });
const read = path => readFileSync(path, "utf8");
const hash = value => createHash("sha256").update(value).digest("hex");
const revision = "0af2d21647416e3092347d4be82af6cfa6fa6b2d";
const pinnedSources = {
  "apps/server/src/cloud/linkChecks.ts": ["9576e368b40d72c61e3c6beb340d02b3678893266e6e20d9ce86c358724b96db", "app/t3/environment-link.ts"],
  "apps/server/src/cloud/relayResponse.ts": ["020a5bade2b8c9be70d0940838404f9e168115dd3047c06b5a48bb0bda86d928", "app/t3/connection-registry.ts"],
  "packages/contracts/src/environment.ts": ["ef7ab1d9f0b5f636490607f95653d517009eebc0d6d0e71d5eea069f7eb1ff35", "app/t3/environment-contract.ts"],
  "packages/client-runtime/src/connection/model.ts": ["b2ff91808ab24078dc667e7e14c1b8671fdde54ac9932e997e73a1560745f8dd", "app/t3/connection-registry.ts"],
  "packages/contracts/src/relay.ts": ["94ff0570c801adf8fe72ecf17f812e19d8100acc8aa13eece8c44c7265f5ce3b", "app/t3/connection-registry.ts"],
};
const sourceDirectory = values.source ?? productEnv('MINARBOT_T3_SOURCE');
assert(sourceDirectory, "Pass --source or set MINARBOT_T3_SOURCE to the pinned upstream checkout.");
const cache = resolve(sourceDirectory);
const manifestPath = resolve(app, "t3/provenance.json");
const provenance = JSON.parse(read(manifestPath));
for (const records of Object.values(provenance).filter(Array.isArray)) {
  for (const record of records) {
    for (const check of record.compatibilityCheck?.split("; ") ?? []) {
      const path = check.match(/^(?:app|crates)\/[^\s]+/)?.[0];
      if (path) assert(existsSync(resolve(root, path)), `Missing compatibility check: ${path}`);
    }
  }
}
const entries = provenance.sourceEntries.filter(entry => entry.compatibilityCheck === "app/t3/provenance-check.mjs");
const ts = createRequire(resolve(app, "package.json"))("typescript");
const checks = [];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: app, stdio: "inherit" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} failed or was interrupted`);
  checks.push({ command: [command, ...args].join(" "), status: result.status });
}
if (values.phase) {
  assert(values.receipt, "--phase requires --receipt");
  run("npm", ["run", "build"]);
  run(process.execPath, ["--experimental-strip-types", "--test", "--test-concurrency=2", "t3-connection.test.ts"]);
}

assert.equal(provenance.repository, "https://github.com/pingdotgg/t3code");
assert.equal(provenance.revision, revision);
assert.deepEqual(provenance.runtimeDependencies, []);
assert.equal(provenance.license, "MIT");
const notice = read(resolve(root, provenance.notice));
assert.equal(hash(notice), "935d8f2af0c703f9c39517ee57cc4930b19d02d533be930b63f0e82f93614b43");
assert.equal(notice, read(resolve(cache, "LICENSE")));
assert.deepEqual(entries.map(entry => entry.sourcePath).sort(), Object.keys(pinnedSources).sort());
const sources = new Map();
for (const entry of entries) {
  const [sourceHash, destination] = pinnedSources[entry.sourcePath];
  assert.equal(entry.sourceRevision, revision);
  assert.equal(entry.sourceSha256, sourceHash);
  assert.equal(entry.localPath, destination);
  assert.equal(entry.license, "MIT");
  assert.equal(entry.notice, provenance.notice);
  assert.deepEqual(entry.dependencies, []);
  assert.equal(entry.compatibilityCheck, "app/t3/provenance-check.mjs");
  const source = read(resolve(cache, entry.sourcePath));
  assert.equal(hash(source), entry.sourceSha256, entry.sourcePath);
  for (const symbol of entry.symbols) assert(source.includes(symbol), `missing source symbol ${symbol}`);
  sources.set(entry.sourcePath, source);
}

function parse(source) { return ts.createSourceFile("adapter.ts", source, ts.ScriptTarget.ES2023, true); }
function declaration(source, name) {
  const nodes = parse(source).statements;
  const node = nodes.find(node => node.name?.text === name ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText() === name)));
  assert(node, `missing declaration ${name}`);
  return node.getText();
}
function tokens(source) {
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, removeComments: true } }).outputText;
  const scanner = ts.createScanner(ts.ScriptTarget.ES2023, true, ts.LanguageVariant.Standard, output);
  const result = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.ExportKeyword) result.push(scanner.getTokenText());
  }
  return result;
}
const localFiles = {};
for (const destination of new Set(entries.map(entry => entry.localPath))) {
  assert(relative(root, resolve(root, destination)).startsWith("app/t3/"));
  const source = read(resolve(root, destination));
  assert(source.includes(provenance.revision) && source.includes("Copyright (c) 2026 T3 Tools Inc."));
  assert.equal(hash(source), provenance.localFiles[destination], `unrecorded adapter change ${destination}`);
  const visit = node => {
    assert(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) &&
      !(ts.isExportDeclaration(node) && node.moduleSpecifier), `adapter dependency in ${destination}`);
    if (ts.isCallExpression(node)) assert(node.expression.kind !== ts.SyntaxKind.ImportKeyword && node.expression.getText() !== "require", `dynamic dependency in ${destination}`);
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  localFiles[destination] = hash(source);
}
for (const entry of entries.filter(entry => entry.sourcePath.startsWith("apps/server/"))) {
  const upstream = sources.get(entry.sourcePath);
  const local = read(resolve(root, entry.localPath));
  const symbols = [...entry.symbols];
  if (entry.sourcePath.endsWith("linkChecks.ts")) symbols.push("CLOUD_PROOF_MAX_LIFETIME_SECONDS", "CLOUD_PROOF_CLOCK_SKEW_SECONDS", "LOOPBACK_HOSTNAMES");
  for (const symbol of symbols) {
    assert.deepEqual(tokens(declaration(local, symbol)), tokens(declaration(upstream, symbol).replace("desktop-bootstrap", "briefsip-local-bootstrap")), `changed source behavior ${symbol}`);
  }
}
function literals(source, name) { return [...declaration(source, name).matchAll(/"([^"]+)"/g)].map(match => match[1]).sort(); }
const environment = sources.get("packages/contracts/src/environment.ts");
const localEnvironment = read(resolve(app, "t3/environment-contract.ts"));
assert.deepEqual(tokens(declaration(localEnvironment, "ORCHESTRATION_PROTOCOL_VERSION")), tokens(declaration(environment, "ORCHESTRATION_PROTOCOL_VERSION")));
for (const name of ["ExecutionEnvironmentPlatformOs", "ExecutionEnvironmentPlatformArch", "ThreadEnvMode"]) {
  assert.deepEqual(literals(localEnvironment, name), literals(environment, name), name);
}
const model = sources.get("packages/client-runtime/src/connection/model.ts");
const localModel = read(resolve(app, "t3/connection-registry.ts"));
for (const name of ["NetworkStatus", "ConnectionTransientReason", "ConnectionBlockedReason", "ConnectionHop", "SupervisorConnectionPhase", "ConnectionAttemptStage"]) {
  assert.deepEqual(literals(localModel, name), literals(model, name), name);
}
assert.deepEqual(literals(localModel, "ConnectionFailureCause"), [
  ...literals(model, "ConnectionFailureCause"), ...literals(sources.get("packages/contracts/src/relay.ts"), "RelayEnvironmentEndpointFailure"),
].sort());

const configPath = resolve(app, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, app, {}, configPath);
const program = ts.createProgram([resolve(app, "t3-connection.test.ts")], parsed.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: file => file, getCurrentDirectory: () => app, getNewLine: () => "\n",
}));
checks.push({ command: "pinned source/license/helper equivalence, zero imports, native type fixtures", status: 0 });
if (values.receipt) {
  const git = args => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0);
    return result.stdout.trim();
  };
  const receipt = {
    phase: values.phase ? "P0" : "P0-provenance", status: "pass", createdAt: new Date().toISOString(),
    baseCommit: git(["rev-parse", "HEAD"]), sourceRevision: provenance.revision,
    sourceHashes: Object.fromEntries(entries.map(entry => [entry.sourcePath, entry.sourceSha256])),
    localFiles, manifestSha256: hash(read(manifestPath)), checks,
    cleanup: "no processes or disposable fixtures retained",
    limits: ["Pure adapters only; no runtime transport, auth, device enrollment, project isolation or E2E acceptance.", "Native type fixtures compile; source is read from --source or the audited local cache."],
  };
  const path = resolve(values.receipt);
  writeFileSync(`${path}.tmp`, JSON.stringify(receipt, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}
console.log(`t3 provenance PASS: ${entries.length} pinned sources, exact helpers, zero imports, native type fixtures`);
