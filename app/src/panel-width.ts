/** Keep the main conversation readable; side panels share the remaining physical pixels. */
export const mainChatMinWidth = 360;
export function maxPanelWidth(available: number, reserved = 0): number {
  return Math.max(0, Math.floor(available - mainChatMinWidth - reserved));
}
export function clampPanelWidth(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(Math.min(minimum, maximum), Math.round(Number.isFinite(value) ? value : minimum)));
}
