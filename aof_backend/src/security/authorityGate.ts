/**
 * [AUDIT AOF-H1] Authority key custody gate — pure decision logic.
 *
 * The backend used to require a raw `AUTHORITY_SECRET_KEY` in its process
 * environment in EVERY mode: a hot signing key living in env is a production
 * incident waiting to happen. The real fix (Squads multisig / KMS so the
 * backend never holds the authority secret) is an operator action; this gate
 * makes the code FAIL CLOSED in the meantime:
 *
 *   AUTHORITY_MODE=hot (default, devnet posture)
 *     - needs AUTHORITY_SECRET_KEY;
 *     - in production REFUSES to start unless the deploy manifest explicitly
 *       carries ALLOW_HOT_AUTHORITY_KEY=1 (loud, reviewable, greppable).
 *
 *   AUTHORITY_MODE=read-only (required production posture until Squads/KMS)
 *     - AUTHORITY_SECRET_KEY must be ABSENT from the environment (its
 *       presence is a misconfiguration: the key would sit in env for no
 *       reason) — fail closed;
 *     - AUTHORITY_PUBKEY is required (PDA derivation, account wiring);
 *     - the backend starts, but every signing attempt returns 503.
 *
 * The logic is pure (takes an env snapshot) so it can be regression-tested
 * without importing the real config: scripts/authorityGateSelfTest.ts.
 */

export type AuthorityMode = "hot" | "read-only";

export interface AuthorityEnv {
  AUTHORITY_MODE?: string | undefined;
  AUTHORITY_SECRET_KEY?: string | undefined;
  /** [SECURITY_CHECKLIST #65] Docker-secret file holding the key (production form). */
  AUTHORITY_SECRET_KEY_FILE?: string | undefined;
  AUTHORITY_PUBKEY?: string | undefined;
  ALLOW_HOT_AUTHORITY_KEY?: string | undefined;
}

export interface AuthorityGateDecision {
  ok: boolean;
  mode: AuthorityMode;
  /** set when ok === false */
  reason?: string;
  /** non-fatal notes (e.g. hot key acknowledged in production) */
  warnings: string[];
}

export function evaluateAuthorityGate(env: AuthorityEnv, isProduction: boolean): AuthorityGateDecision {
  const rawMode = (env.AUTHORITY_MODE || "hot").trim().toLowerCase();
  if (rawMode !== "hot" && rawMode !== "read-only") {
    return {
      ok: false,
      mode: "hot",
      warnings: [],
      reason: `AUTHORITY_MODE must be "hot" or "read-only", got "${rawMode}"`,
    };
  }
  const mode: AuthorityMode = rawMode;
  const hasSecret = Boolean(env.AUTHORITY_SECRET_KEY || env.AUTHORITY_SECRET_KEY_FILE);
  const warnings: string[] = [];
  if (env.AUTHORITY_SECRET_KEY && env.AUTHORITY_SECRET_KEY_FILE) {
    return {
      ok: false,
      mode,
      warnings,
      reason: "AUTHORITY_SECRET_KEY and AUTHORITY_SECRET_KEY_FILE are both set: keep only the file",
    };
  }

  if (mode === "hot") {
    if (!hasSecret) {
      return {
        ok: false,
        mode,
        warnings,
        reason:
          "AUTHORITY_MODE=hot requires AUTHORITY_SECRET_KEY_FILE (or AUTHORITY_SECRET_KEY outside production), " +
          "or switch to AUTHORITY_MODE=read-only",
      };
    }
    if (isProduction && env.ALLOW_HOT_AUTHORITY_KEY !== "1") {
      return {
        ok: false,
        mode,
        warnings,
        reason:
          "Production refuses a hot AUTHORITY_SECRET_KEY by default [AOF-H1]. " +
          "Set AUTHORITY_MODE=read-only (authority signing disabled, routes " +
          "return 503 until Squads/KMS is wired up), or explicitly " +
          "acknowledge the hot-key risk with ALLOW_HOT_AUTHORITY_KEY=1.",
      };
    }
    if (isProduction && env.AUTHORITY_SECRET_KEY) {
      return {
        ok: false,
        mode,
        warnings,
        reason:
          "Production takes the hot key only from AUTHORITY_SECRET_KEY_FILE (a Docker secret), " +
          "never from an environment variable [SECURITY_CHECKLIST #65]",
      };
    }
    if (isProduction) {
      warnings.push(
        "AUTHORITY_MODE=hot in production is ACKNOWLEDGED (ALLOW_HOT_AUTHORITY_KEY=1) — " +
          "replace with Squads/KMS as soon as available [AOF-H1]",
      );
    }
    return { ok: true, mode, warnings };
  }

  // mode === "read-only"
  if (hasSecret) {
    return {
      ok: false,
      mode,
      warnings,
      reason:
        "AUTHORITY_MODE=read-only must NOT receive AUTHORITY_SECRET_KEY — " +
        "the secret must be removed from the backend environment entirely [AOF-H1]",
    };
  }
  if (!env.AUTHORITY_PUBKEY) {
    return {
      ok: false,
      mode,
      warnings,
      reason: "AUTHORITY_MODE=read-only requires AUTHORITY_PUBKEY",
    };
  }
  return { ok: true, mode, warnings };
}
