export const harnessRuntimes = ['codex', 'claude', 'hermes', 'antigravity', 'grok', 'pi', 'opencode', 'gemini', 'kiro'] as const;
export type Runtime = 'api' | typeof harnessRuntimes[number];
export const harnessLabels = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes', antigravity: 'Antigravity', grok: 'Grok', pi: 'Pi', opencode: 'OpenCode', gemini: 'Gemini', kiro: 'Kiro' };
export type AcpRuntime = Exclude<HarnessRuntime, 'codex' | 'claude' | 'pi'>;
export type HarnessRuntime = Exclude<Runtime, 'api'>;
