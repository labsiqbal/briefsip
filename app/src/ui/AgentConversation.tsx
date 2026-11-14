import type { ReactNode } from 'react';
import { AgentAvatar } from '../AgentAvatar';
import { Markdown } from '../Markdown';
import { AgentMessage } from './ChatPrimitives';
import { Collapsible } from './kit';
import type { TurnActivityData } from './transcript';
import { TurnActivity } from './TurnActivity';

export type Exchange = { id: string; agent: string; name: string; role?: string; machine?: string; thread: string; task?: string; reply: string | null; detailReply?: string | null; error: string | null; status: string; paused: number; truncated: boolean; activity?: TurnActivityData; created?: string; generatedFiles?: { id: string; name: string; size: number; thread: string }[] };
export function AgentConversation({ items, sender, scope, onOpen }: { items: Exchange[]; sender: string; scope: string; onOpen?: (agent: string, thread: string) => void }) {
  return <section className="inline-delegation" aria-label="Agent conversation">{items.map(item => <div className="inline-delegation__exchange" key={item.id}>
    <div className="inline-delegation__request"><span className="exchange-label"><strong>{sender}</strong><span>to {item.name}{item.machine ? ` @ ${item.machine}` : ''}</span></span><p className="message-plain">{item.task ?? 'Shared task'}</p></div>
    <div className="inline-delegation__reply"><AgentAvatar agent={{ id: item.agent, name: item.name }} size={24} /><div className="message-column"><div className="agent-identity"><strong>{item.name}</strong>{item.machine && <span className="message-role">{item.machine}</span>}{item.role && <span className="message-role">{item.role}</span>}</div>
      {item.reply ? <div className="legacy"><Markdown text={item.reply} scope={scope} origin={window.location.origin} /></div> : <p className={item.error ? 'message-error' : 'message-muted'}>{item.error ?? (item.paused ? 'Paused' : item.status === 'done' ? 'No reply' : item.status === 'running' ? 'Replying...' : item.status === 'queued' ? 'Queued' : item.status)}</p>}
      <Collapsible title="Exchange details">{item.activity && <TurnActivity turn={{ status: item.status, paused: item.paused, created: item.created ?? '', activity: item.activity }} agentName={item.name} onOpenTask={() => onOpen?.(item.agent, item.thread)} remote={!!item.machine} />}{item.truncated && <div className="legacy"><Markdown text={item.detailReply ?? item.reply ?? ''} scope={scope} origin={window.location.origin} /></div>}{item.generatedFiles?.map(file => <p key={file.id}><a className="k-link" href={`/api/threads/${file.thread}/files/${file.id}`} download={file.name}>{file.name}</a><span className="message-role"> {file.size} bytes</span></p>)}{onOpen && <button type="button" className="link-btn" onClick={() => onOpen(item.agent, item.thread)}>Open conversation with {item.name}</button>}</Collapsible>
    </div></div>
  </div>)}</section>;
}
export type RoomView = { root: string; round: number; silent: string | null; note: string | null; quiet: { agent: string; name: string; silent: string }[]; messages: { seq: number; turn: string; agent: string; name: string; role: string; target_name?: string; text: string; kind: string }[] };
export function RoomMessages({ room, members, pending, scope, details }: { room: RoomView; members: { id: string; name: string; role: string; avatar_revision?: number }[]; pending: { id: string; agent: string; status: string; error: string | null }[]; scope: string; details: (turn: string) => ReactNode }) {
  return <div className="room-conversation" aria-label="Room conversation">
    {room.messages.map(item => <AgentMessage key={item.seq} identity={<div className="agent-identity"><AgentAvatar agent={members.find(member => member.id === item.agent) ?? { id: item.agent, name: item.name }} size={24} /><strong className="message-name">{item.name}</strong><span className="message-role">{item.role}</span>{item.target_name && <span className="message-role">to {item.target_name}</span>}</div>}>
      <div className={item.kind === 'request' ? 'room-message-request' : 'message-body'}><div className="legacy"><Markdown text={item.text} scope={scope} origin={window.location.origin} /></div></div>
      {item.kind === 'reply' && details(item.turn)}
    </AgentMessage>)}
    {pending.map(turn => <div className="room-pending" key={turn.id}><AgentAvatar agent={members.find(member => member.id === turn.agent) ?? { id: turn.agent, name: turn.agent }} size={20} /><span>{members.find(member => member.id === turn.agent)?.name} · {turn.error ?? (turn.status === 'running' ? 'Replying...' : turn.status === 'queued' ? 'Queued' : turn.status)}</span>{details(turn.id)}</div>)}
    {room.note && <p className="room-system-note" role="status">{room.note}</p>}
  </div>;
}
