import { attachmentSize } from '../attachments';
import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, CircleAlert } from 'lucide-react';
import { Collapsible as Disclosure } from 'radix-ui';
import { AgentAvatar } from '../AgentAvatar';
import { Markdown, StreamingMarkdown } from '../Markdown';
import { AgentMessage } from './ChatPrimitives';
import { Collapsible, IconButton } from './kit';
import { activityLabel, livePartial, liveTurn, streamIdentity, type TurnActivityData } from './transcript';
import { TurnActivity } from './TurnActivity';
import type { StreamPartial } from '../../turn-stream';

export type Exchange = { id: string; agent: string; name: string; role?: string; machine?: string; thread: string; task?: string; reply: string | null; detailReply?: string | null; error: string | null; status: string; paused: number; truncated: boolean; activity?: TurnActivityData; created?: string; generatedFiles?: { id: string; name: string; size: number; thread: string }[] };
export function AgentConversation({ items, sender, scope, onOpen }: { items: Exchange[]; sender: string; scope: string; onOpen?: (agent: string, thread: string) => void }) {
  return <section className="inline-delegation" aria-label="Agent conversation">{items.map(item => <div className="inline-delegation__exchange" key={item.id}>
    <div className="inline-delegation__request"><span className="exchange-label"><strong>{sender}</strong><span>to {item.name}{item.machine ? ` @ ${item.machine}` : ''}</span></span><p className="message-plain">{item.task ?? 'Shared task'}</p></div>
    <div className="inline-delegation__reply"><AgentAvatar agent={{ id: item.agent, name: item.name }} size={24} /><div className="message-column"><div className="agent-identity"><strong>{item.name}</strong>{item.machine && <span className="message-role">{item.machine}</span>}{item.role && <span className="message-role">{item.role}</span>}</div>
      {item.reply ? <div className="legacy"><Markdown text={item.reply} scope={scope} origin={window.location.origin} /></div> : <p className={item.error ? 'message-error' : 'message-muted'}>{item.error ?? (item.paused ? 'Paused' : item.status === 'done' ? 'No reply' : item.status === 'running' ? 'Replying...' : item.status === 'queued' ? 'Queued' : item.status)}</p>}
      <Collapsible title="Exchange details">{item.activity && <TurnActivity turn={{ status: item.status, paused: item.paused, created: item.created ?? '', activity: item.activity }} agentName={item.name} onOpenTask={() => onOpen?.(item.agent, item.thread)} remote={!!item.machine} />}{item.truncated && <div className="legacy"><Markdown text={item.detailReply ?? item.reply ?? ''} scope={scope} origin={window.location.origin} /></div>}{item.generatedFiles?.map(file => <p key={file.id}><a className="k-link" href={`/api/threads/${file.thread}/files/${file.id}`} download={file.name}>{file.name}</a><span className="message-role"> {attachmentSize(file.size)}</span></p>)}{onOpen && <button type="button" className="link-btn" onClick={() => onOpen(item.agent, item.thread)}>Open conversation with {item.name}</button>}</Collapsible>
    </div></div>
  </div>)}</section>;
}
export type RoomView = { root: string; generation: string; active: boolean; stopped: boolean; round: number; silent: string | null; note: string | null; quiet: { agent: string; name: string; silent: string }[]; messages: { seq: number; turn: string; agent: string; name: string; role: string; target_name?: string; text: string; kind: string }[] };
type RoomTurn = { id: string; agent: string; status: string; paused: number; created: string; error: string | null; partial?: StreamPartial | null; activity?: TurnActivityData; questions?: { answer: string | null }[] };
type RoomMember = { id: string; name: string; role: string; avatar_revision?: number };
function RoomReply({ turn, member, text, scope, details, controls, extras }: { turn: RoomTurn; member: RoomMember; text?: string; scope: string; details: ReactNode; controls: ReactNode; extras: ReactNode }) {
  const [open, setOpen] = useState(false), [now, setNow] = useState(Date.now);
  const live = liveTurn(turn), streaming = livePartial(turn);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  useEffect(() => { if (turn.status === 'done') setOpen(false); }, [turn.status]);
  const answer = text ?? turn.partial?.text ?? '';
  return <Disclosure.Root open={open} onOpenChange={setOpen} asChild><section className="room-agent" aria-label={`Reply from ${member.name}`}>
    <div className={`${text ? 'room-agent__line' : 'room-pending'}${live ? ' is-working' : ''}`}>
      <AgentAvatar agent={member} size={20} /><strong className="room-agent__name message-name" title={member.name}>{member.name}</strong>
      <span className="room-agent__status" title={activityLabel(turn, now)}>{live && turn.status !== 'queued' && <span className="activity-working" aria-hidden />}{activityLabel(turn, now)}{turn.activity?.fallback_model && <CircleAlert size={12} role="img" aria-label="Fallback model used" />}</span>
      <div className="room-agent__actions"><Disclosure.Trigger asChild><IconButton label={`${open ? 'Hide' : 'Show'} activity for ${member.name}`}>{open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}</IconButton></Disclosure.Trigger>{controls}</div>
    </div>
    <Disclosure.Content className="room-agent__activity">{details}</Disclosure.Content>
    {answer && <div className="message-body" aria-label={streaming ? `Streaming answer from ${member.name}` : `Answer from ${member.name}`}>{!text && !streaming && <span className="message-muted">Partial reply</span>}<div className="legacy"><StreamingMarkdown key={streamIdentity(turn)} text={answer} scope={scope} origin={window.location.origin} /></div></div>}
    {extras}
    {turn.error && turn.status !== 'cancelled' && <p className="message-error">{turn.error}</p>}
  </section></Disclosure.Root>;
}
export function RoomMessages({ room, members, pending, turns, scope, details, controls, extras }: { room: RoomView; members: RoomMember[]; pending: RoomTurn[]; turns: RoomTurn[]; scope: string; details: (turn: string) => ReactNode; controls: (turn: string) => ReactNode; extras: (turn: string) => ReactNode }) {
  const rows = [...room.messages.map(item => ({ key: `${item.kind}-${item.turn}`, item, turn: turns.find(turn => turn.id === item.turn) })), ...pending.map(turn => ({ key: `reply-${turn.id}`, item: undefined, turn }))];
  return <div className="room-conversation" aria-label="Section conversation">
    {rows.map(({ key, item, turn }) => item?.kind === 'request' ? <AgentMessage key={key} identity={<div className="agent-identity"><AgentAvatar agent={members.find(member => member.id === item.agent) ?? { id: item.agent, name: item.name }} size={24} /><strong className="message-name">{item.name}</strong>{item.target_name && <span className="message-role">to {item.target_name}</span>}</div>}><div className="room-message-request legacy"><Markdown text={item.text} scope={scope} origin={window.location.origin} /></div></AgentMessage>
      : <RoomReply key={key} turn={turn ?? { id: item!.turn, agent: item!.agent, status: 'done', paused: 0, created: '', error: null }} member={members.find(member => member.id === (turn?.agent ?? item?.agent)) ?? { id: item?.agent ?? turn!.agent, name: item?.name ?? turn!.agent, role: '' }} text={item?.text} scope={scope} details={details(turn?.id ?? item!.turn)} controls={controls(turn?.id ?? item!.turn)} extras={extras(turn?.id ?? item!.turn)} />)}
    {room.note && <p className="room-system-note" role="status">{room.note}</p>}
  </div>;
}
