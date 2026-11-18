export function usageTokens(value: unknown): [number | null, number | null, number | null] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [null, null, null];
  const usage = value as Record<string, unknown>;
  // ponytail: reject implausible per-call counts; widen with provider-specific accounting if needed.
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
  return [count(usage.prompt_tokens), count(usage.completion_tokens), count(usage.total_tokens)];
}
