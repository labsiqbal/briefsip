export type AgentSessionIssuer = {
  mintAgentSession(input: { agent: string; turn: string; scopes: string[]; ttlMs: number }): Promise<{ id: string; token: string }> | { id: string; token: string };
  revokeAgentSession(id: string): Promise<void> | void;
};
