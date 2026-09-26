/**
 * [SECURITY_CHECKLIST #48/#55, decision 2026-09-26] "An inflated balance must
 * not be withdrawn, but the game must not suffer": while a wallet has an OPEN
 * fraud case at or above FRAUD_HOLD_MIN_SEVERITY (default 3), the backend
 * (operator) does not sign anything that hands out value to it — vault payouts,
 * referral payouts, inbox reward claims, quest and season reward claims. The
 * reward is not lost: the request fails with 423 and succeeds after an admin
 * resolves the case (/admin/fraud/cases/:id/resolve). Gameplay (craft, mining,
 * farming, trading own items) is never held. A lookup failure fails closed.
 */
import type { NextFunction, Request, Response } from "express";

export type OpenCase = { id: string; wallet: string; severity: number; status: string };
export type CaseLookup = (wallets: string[], minSeverity: number) => Promise<OpenCase[]>;

export function fraudHoldMinSeverity(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.FRAUD_HOLD_MIN_SEVERITY ?? "3").trim().toLowerCase();
  if (raw === "off") return Number.POSITIVE_INFINITY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 3) throw new Error("FRAUD_HOLD_MIN_SEVERITY must be 1, 2, 3 or off");
  return value;
}

/** Pure decision: the first open case that holds one of `wallets`, if any. */
export function heldCase(cases: OpenCase[], wallets: string[], minSeverity: number): OpenCase | null {
  const targets = new Set(wallets.filter(Boolean));
  return cases.find((c) => c.status === "open" && c.severity >= minSeverity && targets.has(c.wallet)) ?? null;
}

export class FraudHoldError extends Error {
  constructor(readonly caseId: string, readonly wallet: string, readonly action: string) {
    super(`FRAUD_REVIEW_HOLD: ${action} for ${wallet} is held until fraud case ${caseId} is reviewed`);
  }
}

async function dbLookup(wallets: string[], minSeverity: number): Promise<OpenCase[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { db } = require("../lib/db");
  return db.fraudCase.findMany({
    where: { wallet: { in: wallets }, status: "open", severity: { gte: minSeverity } },
    select: { id: true, wallet: true, severity: true, status: true },
  });
}

export async function assertNoFraudHold(
  wallets: Array<string | undefined | null>,
  action: string,
  lookup: CaseLookup = dbLookup,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const minSeverity = fraudHoldMinSeverity(env);
  if (!Number.isFinite(minSeverity)) return;
  const targets = wallets.filter((w): w is string => typeof w === "string" && w.length > 0);
  if (!targets.length) return;
  const hit = heldCase(await lookup(targets, minSeverity), targets, minSeverity);
  if (hit) {
    // eslint-disable-next-line no-console
    console.warn(`[fraud-hold] ${action} held for case ${hit.id} (severity ${hit.severity})`);
    throw new FraudHoldError(hit.id, hit.wallet, action);
  }
}

/** Middleware for routes whose recipient wallet is a body field. */
export function requireNoFraudHold(field: string, action: string, lookup: CaseLookup = dbLookup) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await assertNoFraudHold([req.body?.[field]], action, lookup);
      next();
    } catch (e) {
      if (!sendFraudHold(res, e)) res.status(503).json({ error: "FRAUD_HOLD_CHECK_UNAVAILABLE" });
    }
  };
}

/** Reply 423 for a hold; returns false for any other error. */
export function sendFraudHold(res: Response, e: unknown): boolean {
  if (!(e instanceof FraudHoldError)) return false;
  res.status(423).json({ error: "FRAUD_REVIEW_HOLD", caseId: e.caseId, action: e.action });
  return true;
}
