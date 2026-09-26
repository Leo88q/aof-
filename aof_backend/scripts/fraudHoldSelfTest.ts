/**
 * [SECURITY_CHECKLIST #48/#55] Value is held for wallets with an open fraud
 * case at/above the threshold; gameplay routes are untouched; lookup failures
 * fail closed; the reward is not consumed (423, retry after review).
 */
import assert from "node:assert/strict";
import { assertNoFraudHold, FraudHoldError, fraudHoldMinSeverity, heldCase, requireNoFraudHold, OpenCase } from "../src/security/fraudHold";

const cases: OpenCase[] = [
  { id: "c1", wallet: "Bad1", severity: 3, status: "open" },
  { id: "c2", wallet: "Meh2", severity: 2, status: "open" },
  { id: "c3", wallet: "Old3", severity: 3, status: "dismissed" },
];
const lookup = async (wallets: string[], min: number) => cases.filter((c) => wallets.includes(c.wallet) && c.severity >= min && c.status === "open");

(async () => {
  // Threshold parsing.
  assert.equal(fraudHoldMinSeverity({}), 3, "default is severity 3");
  assert.equal(fraudHoldMinSeverity({ FRAUD_HOLD_MIN_SEVERITY: "2" }), 2);
  assert.equal(fraudHoldMinSeverity({ FRAUD_HOLD_MIN_SEVERITY: "off" }), Number.POSITIVE_INFINITY);
  assert.throws(() => fraudHoldMinSeverity({ FRAUD_HOLD_MIN_SEVERITY: "9" }));

  // Pure decision.
  assert.equal(heldCase(cases, ["Bad1"], 3)?.id, "c1");
  assert.equal(heldCase(cases, ["Meh2"], 3), null, "severity 2 below the default threshold");
  assert.equal(heldCase(cases, ["Meh2"], 2)?.id, "c2");
  assert.equal(heldCase(cases, ["Old3"], 1), null, "resolved cases never hold");

  // Any party of a payout triggers the hold (e.g. the referrer).
  await assert.rejects(assertNoFraudHold(["Clean", "Bad1"], "referral_payout", lookup, {}), (e: any) => e instanceof FraudHoldError && e.caseId === "c1");
  await assertNoFraudHold(["Clean", "Meh2"], "vault_payout", lookup, {});
  await assertNoFraudHold(["Bad1"], "vault_payout", lookup, { FRAUD_HOLD_MIN_SEVERITY: "off" });
  await assert.rejects(assertNoFraudHold(["Bad1"], "vault_payout", async () => { throw new Error("db down"); }, {}), /db down/, "lookup failure propagates (fail closed)");

  // Middleware: 423 for a hold, 503 when the check cannot run, next() otherwise.
  const run = async (body: any, lk = lookup) => {
    let status = 0, payload: any = null, passed = false;
    const res: any = { status(s: number) { status = s; return this; }, json(p: any) { payload = p; return this; } };
    await requireNoFraudHold("user", "inbox_claim", lk)({ body } as any, res, () => { passed = true; });
    return { status, payload, passed };
  };
  const held = await run({ user: "Bad1" });
  assert.equal(held.status, 423); assert.equal(held.payload.error, "FRAUD_REVIEW_HOLD"); assert.equal(held.passed, false);
  assert.equal((await run({ user: "Clean" })).passed, true);
  assert.equal((await run({ user: "Clean" }, async () => { throw new Error("db down"); })).status, 503, "fail closed");
  console.log("fraud hold self-test: threshold, pure decision, all payout parties, fail-closed lookup, 423 middleware passed");
})().catch((e) => { console.error(e); process.exit(1); });
