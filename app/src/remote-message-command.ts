export type RemoteMessageCommand = { id: string; machine: string; agent: string; text: string };
export function restoreRemoteMessage(raw: string | null, machine: string, agent: string): RemoteMessageCommand | null {
  if (!raw) return null;
  if (raw.length > 100_000) throw new Error('Invalid remote message recovery data.');
  const value = JSON.parse(raw), uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 || !['id','machine','agent'].every(key => typeof value[key] === 'string' && uuid.test(value[key])) || value.machine !== machine || value.agent !== agent || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 16_000) throw new Error('Invalid remote message recovery data.');
  return value;
}
