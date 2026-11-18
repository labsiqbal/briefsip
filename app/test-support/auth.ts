export type HumanActor = Readonly<{ accountId: string; issuer: string; subject: string; sessionId: string; expiresAt: number }>;
export type AuthConfig = { jwtKey?: string; secretKey: string; publishableKey: string; issuer: string; origin: string; audience?: string; development?: boolean };

export type HumanAuth = {
  authenticate(request: Request): Promise<HumanActor>;
  requireCurrent(actor: HumanActor): HumanActor;
  verifiedMailboxes(actor: HumanActor): Promise<string[]>;
};
