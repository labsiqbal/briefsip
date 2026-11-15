import { useRef, useState, type ReactNode } from 'react';
import { DropdownMenu } from 'radix-ui';
import { Ellipsis, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import type { Agent } from './AgentProfileDialog';
import { IconButton, useConfirm } from './ui/kit';

type Request = <T>(path: string, body?: unknown) => Promise<T>;

export function useDeleteAgent(request: Request, onDeleted: (id: string) => Promise<void>) {
  const confirm = useConfirm(), flight = useRef(false);
  return async (agent: Agent) => {
    if (flight.current) return;
    flight.current = true;
    try {
      if (!await confirm({ title: `Delete ${agent.name}?`, description: 'Permanently removes agent data and access.', confirm: 'Delete agent', danger: true })) return;
      await request(`/api/agents/${agent.id}/delete`, { id: crypto.randomUUID() });
      await onDeleted(agent.id);
    } finally { flight.current = false; }
  };
}

export function AgentActions({ agent, children, request, onEdit, onDelete, onChanged, onError }: {
  agent: Agent; children: ReactNode; request: Request; onEdit: () => void;
  onDelete: () => Promise<void>; onChanged: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await action(); } catch (error) { onError(error); } finally { setBusy(false); }
  }
  return <DropdownMenu.Root open={open} onOpenChange={setOpen}>
    <div className="sidebar-agent" onContextMenu={event => { event.preventDefault(); setOpen(true); }} onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); setOpen(true); } }}>
      {children}
      <DropdownMenu.Trigger asChild><IconButton className="agent-actions" label={`Actions for ${agent.name}`}><Ellipsis size={16} aria-hidden /></IconButton></DropdownMenu.Trigger>
    </div>
    <DropdownMenu.Portal><DropdownMenu.Content className="k-pop k-menu" align="end" sideOffset={4}>
      <DropdownMenu.Item className="k-menu__item" disabled={busy} onSelect={onEdit}><Pencil size={15} aria-hidden />Edit</DropdownMenu.Item>
      <DropdownMenu.Item className="k-menu__item" disabled={busy} onSelect={() => void act(async () => { await request(`/api/agents/${agent.id}/visibility`, { id: crypto.randomUUID(), revision: agent.visibility_revision ?? 0, hidden: !agent.hidden }); await onChanged(); })}>{agent.hidden ? <Eye size={15} aria-hidden /> : <EyeOff size={15} aria-hidden />}{agent.hidden ? 'Restore' : 'Hide'}</DropdownMenu.Item>
      <DropdownMenu.Separator className="k-menu__sep" />
      <DropdownMenu.Item className="k-menu__item is-danger" disabled={busy} onSelect={() => void act(onDelete)}><Trash2 size={15} aria-hidden />Delete</DropdownMenu.Item>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
