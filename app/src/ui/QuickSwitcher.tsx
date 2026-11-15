// Adapted from T3 command palette patterns (MIT); see app/t3/provenance.json.
import { useId, useState } from 'react';
import { Search, MessageSquare } from 'lucide-react';
import { Dialog, Input } from './kit';
import { usePolling } from '../hooks/usePolling';
import './quick-switcher.css';

export type SwitcherItem = { id: string; label: string; group: string; detail?: string; onSelect: () => void };
type Conversation = { id: string; agent: string; name: string; archived: number; deleted: number; delivery?: boolean };
type Props = { items: SwitcherItem[]; agents: { id: string; name: string }[]; onClose: () => void; onChoose: (item: SwitcherItem) => void; onThread: (agent: string, thread: string) => void };

export function QuickSwitcher({ items, agents, onClose, onChoose, onThread }: Props) {
  const [query, setQuery] = useState(''), [active, setActive] = useState(0);
  const [threads, setThreads] = useState<Conversation[]>([]), [error, setError] = useState('');
  const list = useId();
  usePolling(async signal => {
    const results = await Promise.allSettled(agents.map(async agent => {
      const response = await fetch(`/api/agents/${agent.id}/threads`, { signal });
      if (!response.ok) throw new Error('Conversations could not load. Reopen to retry.');
      return response.json() as Promise<Conversation[]>;
    }));
    if (signal.aborted) return;
    setThreads(results.flatMap(result => result.status === 'fulfilled' ? result.value : []));
    setError(results.some(result => result.status === 'rejected') ? 'Some conversations could not load. Reopen to retry.' : '');
  }, { interval: 30000 });
  const all = [...items, ...threads.filter(thread => !thread.deleted && !thread.archived && !thread.delivery).map(thread => ({ id: `thread:${thread.id}`, label: thread.name, group: 'Conversations', detail: agents.find(agent => agent.id === thread.agent)?.name, onSelect: () => onThread(thread.agent, thread.id) }))];
  const terms = query.trim().toLocaleLowerCase().split(/\s+/);
  const matches = all.filter(item => terms.every(term => `${item.label} ${item.detail ?? ''} ${item.group}`.toLocaleLowerCase().includes(term))).sort((a, b) => a.group.localeCompare(b.group));
  const current = Math.max(0, Math.min(active, matches.length - 1));
  function choose(item: SwitcherItem) { onChoose(item); }
  return <Dialog open title="Quick switcher" hideHeader onOpenChange={open => { if (!open) onClose(); }}>
    <div className="quick-switcher">
      <div className="quick-switcher__search"><Search size={18} aria-hidden /><Input role="combobox" aria-label="Jump to" placeholder="Jump to…" value={query} aria-expanded aria-autocomplete="list" aria-controls={list} aria-activedescendant={matches.length ? `${list}-${current}` : undefined} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? matches.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % Math.max(1, matches.length);
          setActive(index);
          document.getElementById(`${list}-${index}`)?.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter' && matches[current]) { event.preventDefault(); choose(matches[current]); }
      }} /><kbd>Esc</kbd></div>
      <div id={list} role="listbox" aria-label="Destinations" className="quick-switcher__list">
        {matches.map((item, index) => <div key={item.id}>
          {(index === 0 || matches[index - 1].group !== item.group) && <div className="quick-switcher__group">{item.group}</div>}
          <div id={`${list}-${index}`} role="option" aria-selected={index === current} className="quick-switcher__item" onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}><MessageSquare size={15} aria-hidden /><span>{item.label}{item.detail && <small>{item.detail}</small>}</span></div>
        </div>)}
      </div>
      {!matches.length && <p className="quick-switcher__empty" role="status">No results</p>}
      {error && <p className="message-error" role="alert">{error}</p>}
    </div>
  </Dialog>;
}
