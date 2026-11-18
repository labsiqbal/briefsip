export type QuestionAnswer = { id: string; text: string; acknowledgeUncertain: boolean };
export function parseQuestionAnswer(value: unknown, choices: string[] = []): QuestionAnswer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid answer data.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['id', 'text', 'acknowledgeUncertain'].includes(key)) || typeof v.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.id) || typeof v.text !== 'string' || !v.text.trim() || v.text.length > 4000 || (v.acknowledgeUncertain !== undefined && typeof v.acknowledgeUncertain !== 'boolean') || choices.length && !choices.includes(v.text.trim())) throw new Error('Invalid answer or answer does not match the choices.');
  return { id: v.id, text: v.text, acknowledgeUncertain: v.acknowledgeUncertain === true };
}
