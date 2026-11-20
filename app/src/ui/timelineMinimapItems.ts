// Adapted from T3 (MIT); source hashes and notices: app/t3/provenance.json.
import { marked, type Token, type Tokens } from 'marked';
import { decodeHTML } from 'entities';

type MinimapTurn = {
  id: string; text: string; reply: string | null; partial?: { text: string } | null;
  parent?: string | null; routineReport?: unknown; messageOrigin?: unknown;
  room?: { root: string; messages: { kind: string; text: string }[] } | null;
};
export type TimelineMinimapItem = { id: string; rowIndex: number; userText: string | null; assistantText: string | null };

export function deriveTimelineMinimapItems(turns: readonly MinimapTurn[]): TimelineMinimapItem[] {
  return turns.flatMap((turn, rowIndex) => {
    if (turn.parent || turn.routineReport || turn.messageOrigin || (turn.room && turn.room.root !== turn.id && turns.some(root => root.id === turn.room!.root))) return [];
    const roomReplies = turn.room?.messages.filter(message => message.kind === 'reply');
    const pending = turn.room && turns.filter(item => item.room?.root === turn.room!.root && item.partial?.text && !item.reply).at(-1);
    return [{ id: turn.id, rowIndex, userText: turn.text, assistantText: pending?.partial?.text ?? roomReplies?.at(-1)?.text ?? turn.reply ?? turn.partial?.text ?? null }];
  });
}

// Reuse Minarbot's Markdown lexer/entity decoder; preview never creates model-supplied DOM.
function tokenText(tokens: Token[], depth = 0): string {
  if (depth > 40) return '';
  return tokens.map(token => {
    if (token.type === 'space' || token.type === 'br' || token.type === 'hr') return ' ';
    if (token.type === 'def') return '';
    if (token.type === 'list') return token.items.map((item: Tokens.ListItem) => tokenText(item.tokens, depth + 1)).join(' ');
    if (token.type === 'table') return [token.header, ...token.rows].map(row => row.map((cell: Tokens.TableCell) => tokenText(cell.tokens, depth + 1)).join(' ')).join(' ');
    const text = 'tokens' in token && token.tokens ? tokenText(token.tokens, depth + 1) : 'text' in token ? token.text : token.raw;
    return ['paragraph', 'heading', 'blockquote', 'code'].includes(token.type) ? ` ${text} ` : text;
  }).join('');
}

export function resolveTimelineMinimapPreview(item: TimelineMinimapItem | null): TimelineMinimapItem | null {
  const compact = (text: string | null) => text?.replace(/\s+/g, ' ').trim() || null;
  return item && { ...item, userText: compact(item.userText), assistantText: compact(item.assistantText === null ? null : decodeHTML(tokenText(marked.lexer(item.assistantText.slice(0, 1500))))) };
}

export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export function resolveTimelineMinimapHeightStyle(count: number): string {
  return `min(${Math.max(1, (count - 1) * 8)}px, max(4rem, calc(100% - 14.75rem)))`;
}
export function resolveTimelineMinimapTopPercent(index: number, count: number): number {
  return count <= 1 ? 0 : Math.max(0, Math.min(index, count - 1)) / (count - 1) * 100;
}
export function resolveTimelineMinimapIndexFromPointer(count: number, top: number, height: number, pointerY: number): number | null {
  return count <= 0 || height <= 0 ? null : Math.round(Math.max(0, Math.min(1, (pointerY - top) / height)) * (count - 1));
}
