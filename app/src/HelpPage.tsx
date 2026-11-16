import { Card, Row, Section } from './ui/kit';

const shortcuts = [
  ['Ctrl/Cmd + Shift + O', 'New conversation'],
  ['Ctrl/Cmd + K', 'Quick switcher'],
  ['Ctrl/Cmd + F', 'Find in conversation'],
  ['Ctrl/Cmd + ,', 'Settings'],
  ['Ctrl/Cmd + B', 'Toggle sidebar'],
  ['Ctrl/Cmd + Shift + B', 'Toggle conversation panel'],
  ['Ctrl/Cmd + 1', 'Agents'],
  ['Ctrl/Cmd + 2', 'Projects'],
  ['F6', 'Focus message composer'],
  ['Enter', 'Send or queue message'],
  ['Shift + Enter', 'New line'],
  ['Esc', 'Close search or dialog'],
];

export function HelpPage() {
  return <div className="k-page bs-root help-page">
    <Section title="Workspace"><Card>{shortcuts.map(([keys, action]) => <Row key={keys} title={action} trailing={<kbd>{keys}</kbd>} />)}</Card></Section>
  </div>;
}
