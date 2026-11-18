import { createHash } from 'node:crypto';

export function composioToolName(slug: string) {
  const digest = createHash('sha256').update(JSON.stringify(slug)).digest('hex');
  return `composio__${digest.slice(0, 24)}`;
}
