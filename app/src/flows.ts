export type FlowLink = { from: string; to: string };
export type FlowGraph = { root: string; nodes: string[]; links: FlowLink[] };

export function validateFlow(value: unknown, root: string, agents: ReadonlySet<string>): FlowGraph {
  if (!agents.has(root) || !Array.isArray(value) || value.length > 64) throw new Error('Flow requires a source agent and up to 64 links.');
  const seen = new Set<string>(), nodes = new Set([root]), links: FlowLink[] = [];
  for (const link of value) {
    if (!link || typeof link !== 'object' || Array.isArray(link) || Object.keys(link).some(key => !['from', 'to'].includes(key)) ||
        typeof link.from !== 'string' || typeof link.to !== 'string' || !agents.has(link.from) || !agents.has(link.to) || link.from === link.to || link.to === root) throw new Error('Flow links must connect two different agents without returning to the source.');
    const key = JSON.stringify([link.from, link.to]);
    if (seen.has(key)) throw new Error('Flow links must not be duplicated.');
    seen.add(key); nodes.add(link.from); nodes.add(link.to); links.push({ from: link.from, to: link.to });
  }
  if (nodes.size > 32) throw new Error('A flow supports up to 32 agents.');
  const ordered: string[] = [], remaining = new Set(nodes);
  while (remaining.size) {
    const ready = [...remaining].filter(node => !links.some(link => link.to === node && remaining.has(link.from))).sort();
    if (!ready.length) throw new Error('Flow must not contain cycles.');
    for (const node of ready) { ordered.push(node); remaining.delete(node); }
  }
  const reached = new Set([root]);
  for (const node of ordered) if (links.some(link => link.to === node && reached.has(link.from))) reached.add(node);
  if (reached.size !== nodes.size) throw new Error('All links must be reachable from the source agent.');
  return { root, nodes: ordered, links };
}
