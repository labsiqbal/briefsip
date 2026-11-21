import { Bot, Circle, Code, Eclipse, Globe, Mountain, Orbit, Sparkles, Terminal, Wind, type LucideIcon } from 'lucide-react';
import type { Runtime } from '../shared/runtime';

const runtimeIcons: Record<Runtime, LucideIcon> = {
  api: Globe,
  codex: Terminal,
  claude: Sparkles,
  hermes: Wind,
  antigravity: Orbit,
  grok: Eclipse,
  pi: Circle,
  opencode: Code,
  gemini: Bot,
  kiro: Mountain,
};

export function RuntimeIcon({ runtime }: { runtime: Runtime }) {
  const Icon = runtimeIcons[runtime];
  return <Icon size={16} aria-hidden />;
}
