import { useState, type ReactNode } from 'react';
import { Collapsible } from 'radix-ui';
import { ChevronRight } from 'lucide-react';

/** Legacy /api/sidebar labels stay saved; Agents is now a direct-chat dropdown per machine. */
export function AgentSidebar({ machine = 'local', label = 'Choose agent', agents, renderAgent, searching = false, children }: {
  machine?: string; label?: string; agents: { id: string }[]; renderAgent: (id: string) => ReactNode;
  searching?: boolean; children?: ReactNode;
}) {
  const key = `briefsip:sidebar-agents:${machine}`;
  const [expanded, setExpanded] = useState(() => { try { return localStorage.getItem(key) !== 'closed'; } catch { return true; } });
  return <Collapsible.Root className="agent-sidebar" open={searching || expanded} onOpenChange={open => {
    setExpanded(open); try { localStorage.setItem(key, open ? 'open' : 'closed'); } catch { /* Keep dropdown usable without storage. */ }
  }}>
    <Collapsible.Trigger className="agents-dropdown"><ChevronRight size={14} aria-hidden/><span>Agents</span><span className="machine-group__count">{agents.length}</span></Collapsible.Trigger>
    <Collapsible.Content><nav aria-label={label} className="bot-list">{agents.map(agent => <div key={agent.id}>{renderAgent(agent.id)}</div>)}{children}</nav></Collapsible.Content>
  </Collapsible.Root>;
}

export function HiddenAgents({ agents, renderAgent, searching = false }: { agents: { id: string }[]; renderAgent: (id: string) => ReactNode; searching?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (!agents.length) return null;
  return <Collapsible.Root className="hidden-agents" open={searching || expanded} onOpenChange={setExpanded}>
    <Collapsible.Trigger className="machine-group__header"><ChevronRight className="machine-group__chevron" size={14} aria-hidden /><span className="machine-group__name">Hidden</span><span className="machine-group__count">{agents.length}</span></Collapsible.Trigger>
    <Collapsible.Content><nav className="bot-list" aria-label="Hidden agents">{agents.map(agent => <div key={agent.id}>{renderAgent(agent.id)}</div>)}</nav></Collapsible.Content>
  </Collapsible.Root>;
}
