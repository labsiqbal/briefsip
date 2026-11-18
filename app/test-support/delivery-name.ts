export function deliveryName(sender: string, text: string, machine?: string) {
  const prefix = machine ? `${sender.slice(0, 28)} on ${machine.slice(0, 24)}: ` : `${sender.slice(0, 40)} asked: `;
  return `${prefix}${text.replace(/\s+/g, ' ').trim()}`.slice(0, 80);
}
