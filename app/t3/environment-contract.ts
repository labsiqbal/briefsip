// Native adaptation of T3 contracts at revision
// 0af2d21647416e3092347d4be82af6cfa6fa6b2d.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see NOTICE and provenance.json.

export const ORCHESTRATION_PROTOCOL_VERSION = 2;

export type ExecutionEnvironmentPlatformOs = "darwin" | "linux" | "windows" | "unknown";
export type ExecutionEnvironmentPlatformArch = "arm64" | "x64" | "other";
export type ThreadEnvMode = "local" | "worktree";
export type ExecutionEnvironmentCapabilities = {
  readonly threadRestartContinuation?: boolean;
};

// ponytail: only restart continuation is retained; audit source closure before adding capabilities.
export function decodeEnvironmentCapabilities(input: unknown): ExecutionEnvironmentCapabilities {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid environment capabilities");
  if (!Object.hasOwn(input, "threadRestartContinuation")) return {};
  const value = (input as Record<string, unknown>).threadRestartContinuation;
  if (typeof value !== "boolean") throw new Error("Invalid restart continuation capability");
  return { threadRestartContinuation: value };
}
