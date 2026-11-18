import { Badge, Tooltip } from './ui/kit';

export function NeedsYouBadge({ count }: { count?: number }) {
  if (!count) return null;
  const label = count === 1 ? 'Needs you' : `Needs you in ${count} conversations`;
  return <Tooltip content={label}><span className="needs-you-badge"><Badge tone="warn"><span aria-hidden>{count}</span><span className="sr-only">{label}</span></Badge></span></Tooltip>;
}
