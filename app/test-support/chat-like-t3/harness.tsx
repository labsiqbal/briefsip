import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { marked } from '../../node_modules/marked';
import { Copy, GitFork, RotateCcw, Mic, Square, Wrench, MessageSquare, ChevronDown, Plus, ArrowUp } from '../../node_modules/lucide-react';
import { ChatComposer, HumanMessage, AgentMessage } from '../../src/ui/ChatPrimitives';
import { StreamingMarkdown } from '../../src/Markdown';
import { RoomMessages } from '../../src/ui/AgentConversation';
import { TurnActivity } from '../../src/ui/TurnActivity';
import { themeTokenValues, type ColorMode, type ColorTheme } from '../../src/ui/themes';
import '../../node_modules/@fontsource-variable/inter';
import '../../src/ui/tokens.css';
import '../../src/ui/base.css';
import '../../src/ui/kit.css';
import '../../src/ui/chat.css';
import '../../src/ui/legacy.css';
import '../../src/ui/minarbot.css';
import '../../src/ui/density.css';
import './reference.css';

const user = 'Review the release plan. Show the checks, code, and result.';
const answer = '# Release plan\n\nShip **readable chat** with `npm test`. [Release notes](https://example.test/notes).\n\n- Keep attachments and approvals.\n- Verify dark and light themes.\n\n## Checks\n\n```ts\nconst ready = checks.every(check => check.passed);\nconsole.log(ready);\n```\n\n| Check | Result |\n| --- | --- |\n| Native tests | Passed |\n| Chat smoke | Passed |\n\n> Ready for review.';
const second = 'Both agents agree. Keep the release local until approval.';
const streaming = 'Stable first block.\n\nGrowing second block with `streaming` text';
const members = [{ id: 'fixture-lead', name: 'Release Lead', role: 'Engineering' }, { id: 'fixture-reviewer', name: 'Review Agent', role: 'Review' }];
const activity = { stream: [{seq:1,id:'thinking',kind:'text',text:'Thinking through the release checks.',final:false}], calls: [{seq:1,model:'fixture-model',purpose:'reply',phase:'reply',status:'done',created:'2026-11-15T00:00:00Z',finished:'2026-11-15T00:00:12Z'}], tools: [{ id: 'read', name: 'read_file', failed: false, after_action: 0 }, { id: 'test', name: 'run_tests', failed: false, after_action: 0 }], elapsed_ms: 12000 };
const turn = { id: 'fixture-turn', agent: members[0].id, status: 'done', paused: 0, created: '2026-11-15T00:00:00Z', error: null, activity };
function Actions() { return <div className="turn-controls" role="group" aria-label="Message actions">{[[Copy, 'Copy reply'], [RotateCcw, 'Restore'], [GitFork, 'Fork']].map(([Icon, label]) => <button className="k-icon-btn" aria-label={label as string} key={label as string}><Icon size={12} aria-hidden /></button>)}<time className="message-time">07:00 AM</time></div>; }
function App() {
 const [value, setValue] = useState('');
 const params = new URLSearchParams(location.search), kind = params.get('kind') ?? 'direct';
 const theme = params.get('theme') ?? 'dark', palette = params.get('palette') ?? 'minarbot';
 Object.assign(document.documentElement.dataset, {theme, colorTheme: palette, textSize: params.get('size') ?? 'default'});
 const tokens = themeTokenValues(palette as ColorTheme, theme as ColorMode);
 const refMarkdown = (text: string) => { const renderer = new marked.Renderer(); renderer.code = ({text,lang}) => `<div class="ref-code"><div class="ref-code-header"><span>${lang ?? ''}</span><button aria-label="Copy code"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div><pre><code>${text.replaceAll('&','&amp;').replaceAll('<','&lt;')}</code></pre></div>`; return <div className="chat-markdown" dangerouslySetInnerHTML={{__html: marked.parse(text,{renderer}) as string}} />; };
 const refLog = <details open className="ref-log"><summary>Worked for 12s <ChevronDown size={14}/></summary><p className="ref-model">fixture-model</p><div className="ref-tool"><MessageSquare size={16}/>Thinking through the release checks.</div><div className="ref-tool"><Wrench size={16}/>read_file · Result recorded</div><div className="ref-tool"><Wrench size={16}/>run_tests · Result recorded</div></details>;
 const details = <TurnActivity turn={turn} agentName="Release Lead" onOpenTask={() => {}} />;
 return <><style>{`:root{${Object.entries(tokens).map(([key,value]) => `${key}:${value}`).join(';')}}`}</style><div className="comparison">
 <section className="t3-side"><h2 className="fixture-label">T3 source values · {kind}</h2><div className="ref-lane"><div className="ref-user"><div>{user}</div><time>07:00 AM</time></div>{kind === 'room' && <div className="ref-speaker">Release Lead</div>}{refLog}<div className="ref-answer">{refMarkdown(answer)}<div className="ref-actions"><Copy size={12}/><RotateCcw size={12}/><GitFork size={12}/><time>07:00 AM</time></div></div>{kind === 'room' && <><div className="ref-speaker">Review Agent</div><div className="ref-answer">{refMarkdown(second)}</div></>}<div className="ref-live"><div className="ref-tool">Working… <Square size={12}/></div>{refMarkdown(streaming)}</div><div className="ref-composer"><div className="ref-input">Message Release Lead</div><div className="ref-toolbar"><span><Plus size={16}/></span><Mic size={16}/><span className="ref-send"><ArrowUp size={16}/></span></div></div></div></section>
 <section className="minarbot-side bs-root"><h2 className="fixture-label">Minarbot · {kind}</h2><main className="chat"><div className="transcript__col"><article className="turn-block is-latest"><HumanMessage text={user}><time className="message-time">07:00 AM</time></HumanMessage>{kind === 'direct' ? <AgentMessage>{details}<div className="message-body"><div className="legacy"><StreamingMarkdown text={answer} scope="/fixture" origin={location.origin}/></div></div><Actions/></AgentMessage> : <RoomMessages room={{ root:'fixture', generation:'fixture', active:false, stopped:false, round:1, silent:null, note:null, quiet:[], messages:members.map((member,i) => ({ seq:i,turn:i?'second':turn.id,agent:member.id,name:member.name,role:member.role,text:i?second:answer,kind:'reply' })) }} members={members} pending={[]} turns={[turn]} scope="/fixture" details={() => <TurnActivity turn={turn} agentName="Release Lead" onOpenTask={() => {}} logOnly/>} controls={() => <button className="k-icon-btn" aria-label="Copy reply"><Copy size={14}/></button>} extras={() => null}/>}</article><article className="turn-block is-latest"><AgentMessage><TurnActivity turn={{...turn,status:'running',created:new Date().toISOString(),activity:{...activity,calls:[],tools:[],stream:[]}}} agentName="Release Lead" onOpenTask={() => {}}/><div className="message-body"><div className="legacy"><StreamingMarkdown text={streaming} scope="/fixture" origin={location.origin}/></div></div><span className="stream-caret" aria-hidden/><button className="k-icon-btn" aria-label="Stop"><Square size={14}/></button></AgentMessage></article></div><footer className="composer-area"><ChatComposer label="Message Release Lead" input={{id:'fixture-input',value,onChange:event => setValue(event.target.value)}} onSubmit={event=>event.preventDefault()} onSendKey={()=>{}} onAttach={()=>{}} actions={<button type="button" className="k-icon-btn" aria-label="Record audio"><Mic size={16}/></button>} busy={false} retry={false} sendDisabled={false} sendLabel="Send" sendTitle="Send" /></footer></main></section></div></>;
}
createRoot(document.getElementById('root')!).render(<App/>);
