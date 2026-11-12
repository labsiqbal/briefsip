import test from "node:test";
import assert from "node:assert/strict";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  MAX_RELAY_RETRY_AFTER_MILLIS,
  parseRetryAfterMillis,
} from "./t3/connection-registry.ts";
import type { ConnectionAttemptError, ConnectionDiagnostics, SupervisorConnectionState } from "./t3/connection-registry.ts";
import type { ExecutionEnvironmentPlatformOs, ExecutionEnvironmentPlatformArch, ThreadEnvMode } from "./t3/environment-contract.ts";
import {
  canLinkHere,
  hasBoundedCloudProofLifetime,
  hasExactScope,
  hasForwardedAuthorityHeaders,
  isAllowedEndpointOrigin,
  parseManagedEndpointLocalOrigin,
  requestAbsoluteUrl,
} from "./t3/environment-link.ts";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  decodeEnvironmentCapabilities,
} from "./t3/environment-contract.ts";

const request = (headers: Record<string, string | undefined> = {}) => ({
  originalUrl: "/health",
  headers,
});

test("native T3 contract keeps protocol and capability boundaries", () => {
  assert.equal(ORCHESTRATION_PROTOCOL_VERSION, 2);
  assert.deepEqual(decodeEnvironmentCapabilities({}), {});
  assert.deepEqual(decodeEnvironmentCapabilities({ threadRestartContinuation: true }), { threadRestartContinuation: true });
  assert.deepEqual(decodeEnvironmentCapabilities({ threadRestartContinuation: false, future: { unsafe: true } }), { threadRestartContinuation: false });
  assert.deepEqual(decodeEnvironmentCapabilities({ future: true }), {});
  assert.deepEqual(decodeEnvironmentCapabilities(Object.create({ threadRestartContinuation: true })), {});
  for (const value of [null, [], true, "yes", 1]) assert.throws(() => decodeEnvironmentCapabilities(value));
  for (const value of [null, "true", 1, {}, undefined]) {
    assert.throws(() => decodeEnvironmentCapabilities({ threadRestartContinuation: value }), /Invalid restart continuation/);
  }
});

test("link helpers require local bootstrap subject and reject forwarded authority or widened scopes", () => {
  assert.equal(requestAbsoluteUrl(request()), "http://127.0.0.1/health");
  assert.equal(canLinkHere(request(), "briefsip-local-bootstrap"), true);
  assert.equal(canLinkHere(request({ "x-forwarded-host": "evil.test" }), "briefsip-local-bootstrap"), false);
  assert.equal(canLinkHere(request({ "x-forwarded-proto": "https, http" }), "briefsip-local-bootstrap"), false);
  assert.equal(hasForwardedAuthorityHeaders(request({ "x-forwarded-host": " " })), false);
  assert.equal(requestAbsoluteUrl({ originalUrl: "/health", headers: { host: "localhost:3210, other.test" } }), "http://localhost:3210/health");
  assert.equal(requestAbsoluteUrl({ originalUrl: "http://[", headers: { host: "[" } }), null);
  assert.equal(canLinkHere(request(), "desktop-bootstrap"), false);
  assert.equal(hasExactScope({ scopes: ["expected"], expected: "expected" }), true);
  assert.equal(hasExactScope({ scopes: ["expected", "extra"], expected: "expected" }), false);
  assert.equal(hasExactScope({ scopes: ["expected", "expected"], expected: "expected" }), false);
  assert.equal(hasExactScope({ scopes: [], expected: "expected" }), false);
});

test("local origin and proof lifetime stay bounded", () => {
  const parsed = parseManagedEndpointLocalOrigin("http://127.0.0.1:3210/");
  assert.deepEqual(parsed.origin, { localHttpHost: "127.0.0.1", localHttpPort: 3210 });
  assert.equal(parsed.wsBaseUrl, "ws://127.0.0.1:3210");
  assert.throws(() => parseManagedEndpointLocalOrigin("http://user:pass@127.0.0.1/"), /Invalid local origin/);
  for (const value of [" http://localhost", "ftp://localhost", "http://localhost/path", "http://localhost/?", "http://localhost/#", "http://localhost/?x=1"]) {
    assert.throws(() => parseManagedEndpointLocalOrigin(value), /Invalid local origin/);
  }
  const secure = parseManagedEndpointLocalOrigin("https://[::1]/");
  assert.equal(secure.wsBaseUrl, "wss://[::1]");
  assert.equal(secure.origin.localHttpPort, 443);
  assert.equal(isAllowedEndpointOrigin({ origin: parsed.origin, requestUrl: "http://127.0.0.1:3210/" }), true);
  assert.equal(isAllowedEndpointOrigin({ origin: parsed.origin, requestUrl: "http://127.0.0.1:3211/" }), false);
  assert.equal(isAllowedEndpointOrigin({ origin: parsed.origin, requestUrl: "http://remote.test:3210/" }), false);
  assert.equal(isAllowedEndpointOrigin({ origin: parsed.origin, requestUrl: "http://remote.test:3210/", allowNonLoopbackRequestHost: true }), true);
  assert.equal(isAllowedEndpointOrigin({ origin: { localHttpHost: "remote.test", localHttpPort: 3210 }, requestUrl: "http://remote.test:3210/", allowNonLoopbackRequestHost: true }), false);
  assert.equal(hasBoundedCloudProofLifetime({ iat: 100, exp: 400, nowSeconds: 100 }), true);
  assert.equal(hasBoundedCloudProofLifetime({ iat: 100, exp: 401, nowSeconds: 100 }), false);
  assert.equal(hasBoundedCloudProofLifetime({ iat: 160, exp: 400, nowSeconds: 100 }), true);
  assert.equal(hasBoundedCloudProofLifetime({ iat: 161, exp: 400, nowSeconds: 100 }), false);
  assert.equal(hasBoundedCloudProofLifetime({ iat: 100, exp: 100, nowSeconds: 100 }), false);
  // Retained helper checks duration/issued-at only. P2 must also verify expiry, nonce and signature.
  assert.equal(hasBoundedCloudProofLifetime({ iat: 100, exp: 200, nowSeconds: 300 }), true);
});

test("Retry-After preserves bounded native behavior", () => {
  assert.equal(parseRetryAfterMillis("2", 0), 2000);
  assert.equal(parseRetryAfterMillis("0", 0), undefined);
  assert.equal(parseRetryAfterMillis("999999", 0), 15 * 60 * 1000);
  const now = Date.UTC(2026, 0, 1);
  assert.equal(parseRetryAfterMillis(new Date(now + 5000).toUTCString(), now), 5000);
  assert.equal(parseRetryAfterMillis(" 2 ", now), 2000);
  assert.equal(parseRetryAfterMillis(undefined, now), undefined);
  assert.equal(parseRetryAfterMillis("invalid", now), undefined);
  assert.equal(parseRetryAfterMillis(new Date(now).toUTCString(), now), undefined);
  assert.equal(parseRetryAfterMillis("9".repeat(400), now), undefined);
  assert.equal(parseRetryAfterMillis("9000000", now), MAX_RELAY_RETRY_AFTER_MILLIS);
});

test("native connection records retain complete diagnostics and tag-specific reasons", () => {
  const transient: SupervisorConnectionState = {
    desired: true, network: "online", phase: "backoff", stage: null, attempt: 1,
    generation: 2, retryAt: 5, lastFailure: ConnectionTransientError({
      reason: "timeout", detail: "late", hop: "relay", via: "relay",
      failureCause: "tunnel_down", httpStatus: 503, traceId: "fixture",
    }),
  };
  const blocked: SupervisorConnectionState = { ...transient, phase: "blocked", lastFailure: ConnectionBlockedError({ reason: "permission", detail: "denied", serverUpdateRequired: true }) };
  assert.equal(transient.lastFailure?.message, "late");
  assert.equal(blocked.lastFailure?.message, "denied");
  assert.equal(transient.lastFailure instanceof Error, false);
  if (false) {
    // @ts-expect-error blocked reason cannot tag a transient failure
    const wrongReason: ConnectionAttemptError = { _tag: "ConnectionTransientError", reason: "permission", detail: "x", message: "x" };
    // @ts-expect-error unknown failure cause is outside source vocabulary
    const wrongCause: ConnectionDiagnostics = { failureCause: "imaginary" };
    // @ts-expect-error failure requires complete discriminated record
    const incomplete: ConnectionAttemptError = { _tag: "ConnectionBlockedError", reason: "authentication" };
    // @ts-expect-error runtime factory preserves the discriminant reason
    ConnectionTransientError({ reason: "permission", detail: "denied" });
    // @ts-expect-error source platform literal is closed
    const wrongOs: ExecutionEnvironmentPlatformOs = "freebsd";
    // @ts-expect-error source architecture literal is closed
    const wrongArch: ExecutionEnvironmentPlatformArch = "riscv";
    // @ts-expect-error source environment mode literal is closed
    const wrongMode: ThreadEnvMode = "synced";
  }
});
