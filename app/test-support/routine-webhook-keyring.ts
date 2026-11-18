export type RoutineWebhookKeyring = {
  create(routine: string, generation: number): { secretRef: string; secret: string };
  read(secretRef?: string): string | undefined;
};
