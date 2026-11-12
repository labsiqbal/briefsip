// Native adaptation of T3 connection model and Retry-After helpers at revision
// 0af2d21647416e3092347d4be82af6cfa6fa6b2d.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see NOTICE and provenance.json.

export type NetworkStatus = "unknown" | "offline" | "online";
export type ConnectionTransientReason =
  | "network" | "timeout" | "transport" | "endpoint-unavailable"
  | "relay-unavailable" | "remote-unavailable" | "session-pending";
export type ConnectionBlockedReason = "authentication" | "configuration" | "permission" | "unsupported";
export type ConnectionHop = "device" | "relay" | "tunnel" | "server";
export type ConnectionFailureCause =
  | "tunnel_down" | "origin_unreachable" | "dns" | "tls" | "refused"
  | "timeout" | "invalid_response" | "unknown" | "clock_skew" | "not_linked"
  | "relay_error" | "tunnel_pending" | "tunnel_not_enabled";

export type ConnectionDiagnostics = {
  readonly hop?: ConnectionHop;
  readonly via?: "relay" | "direct";
  readonly failureCause?: ConnectionFailureCause;
  readonly httpStatus?: number;
  readonly traceId?: string;
};

export type ConnectionTransientError = ConnectionDiagnostics & {
  readonly _tag: "ConnectionTransientError"; readonly reason: ConnectionTransientReason; readonly detail: string; readonly message: string;
};
export type ConnectionBlockedError = ConnectionDiagnostics & {
  readonly _tag: "ConnectionBlockedError"; readonly reason: ConnectionBlockedReason; readonly detail: string; readonly message: string; readonly serverUpdateRequired?: boolean;
};
export type ConnectionAttemptError = ConnectionTransientError | ConnectionBlockedError;

export function ConnectionTransientError(input: Omit<ConnectionTransientError, "_tag" | "message">): ConnectionTransientError {
  return { ...input, _tag: "ConnectionTransientError", message: input.detail };
}

export function ConnectionBlockedError(input: Omit<ConnectionBlockedError, "_tag" | "message">): ConnectionBlockedError {
  return { ...input, _tag: "ConnectionBlockedError", message: input.detail };
}

export type SupervisorConnectionPhase = "available" | "offline" | "connecting" | "backoff" | "connected" | "blocked";
export type ConnectionAttemptStage = "preparing" | "opening" | "synchronizing";
export type SupervisorConnectionState = {
  readonly desired: boolean;
  readonly network: NetworkStatus;
  readonly phase: SupervisorConnectionPhase;
  readonly stage: ConnectionAttemptStage | null;
  readonly attempt: number;
  readonly generation: number;
  readonly lastFailure: ConnectionAttemptError | null;
  readonly retryAt: number | null;
};

export const MAX_RELAY_RETRY_AFTER_MILLIS = 15 * 60 * 1000;

export function parseRetryAfterMillis(value: string | undefined, nowMillis: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const millis = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - nowMillis;
  if (!Number.isFinite(millis) || millis <= 0) return undefined;
  return Math.min(millis, MAX_RELAY_RETRY_AFTER_MILLIS);
}
