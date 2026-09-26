/**
 * Authority key custody gate self-test [AUDIT AOF-H1].
 *
 * Exercises the PURE decision function (src/security/authorityGate.ts) that
 * config.ts applies at boot. Covers the production matrix:
 *
 *   hot + prod without explicit ack      -> REFUSE (the fail-closed default)
 *   hot + prod + ALLOW_HOT_AUTHORITY_KEY -> accepted, with a loud warning
 *   hot + dev                            -> ok (documented devnet posture)
 *   read-only + secret present           -> REFUSE (misconfiguration: the key
 *                                           must be OUT of the environment)
 *   read-only + pubkey only              -> ok (signing paths then return 503)
 *   bad/unknown AUTHORITY_MODE           -> REFUSE
 *
 * Run: npm run test:authority-gate
 */
import { strict as assert } from "assert";
import { evaluateAuthorityGate } from "../src/security/authorityGate";

const SECRET = "not-a-real-secret"; // never logged by the gate
const PUBKEY = "FakePubkey11111111111111111111111111111111";

function case_(name: string, env: Record<string, string | undefined>, production: boolean, expectOk: boolean) {
  const d = evaluateAuthorityGate(env, production);
  assert.equal(d.ok, expectOk, `${name}: expected ok=${expectOk}, got ${JSON.stringify(d.reason)}`);
  if (!expectOk) assert.ok(d.reason, `${name}: must carry a reason`);
  return d;
}

// 1. hot + dev (default mode) — ok, the documented devnet posture
case_("hot dev default", { AUTHORITY_SECRET_KEY: SECRET }, false, true);
case_("hot dev explicit", { AUTHORITY_MODE: "hot", AUTHORITY_SECRET_KEY: SECRET }, false, true);

// 2. hot + prod WITHOUT acknowledgment — the fail-closed default [AOF-H1]
case_("hot prod no ack (default mode)", { AUTHORITY_SECRET_KEY: SECRET }, true, false);
const refused = evaluateAuthorityGate({ AUTHORITY_SECRET_KEY: SECRET }, true);
assert.ok(/ALLOW_HOT_AUTHORITY_KEY=1/.test(refused.reason || ""), "reason must name the escape hatch");
assert.ok(/read-only/.test(refused.reason || ""), "reason must name read-only alternative");

// 3. hot + prod + explicit acknowledgment — allowed, with a warning
const acked = case_("hot prod acked (file)", { AUTHORITY_MODE: "hot", AUTHORITY_SECRET_KEY_FILE: "/run/secrets/authority_secret_key", ALLOW_HOT_AUTHORITY_KEY: "1" }, true, true);
assert.equal(acked.warnings.length, 1, "must warn once");
assert.ok(/Squads\/KMS/.test(acked.warnings[0]), "warning must point to the real fix");

// 3b. [SECURITY_CHECKLIST #65] production never takes the key from an env var,
// even acknowledged; both forms at once are ambiguous everywhere.
const envInProd = case_("hot prod acked but env var", { AUTHORITY_MODE: "hot", AUTHORITY_SECRET_KEY: SECRET, ALLOW_HOT_AUTHORITY_KEY: "1" }, true, false);
assert.ok(/AUTHORITY_SECRET_KEY_FILE/.test(envInProd.reason || ""), "reason must point to the Docker-secret file");
case_("both forms", { AUTHORITY_SECRET_KEY: SECRET, AUTHORITY_SECRET_KEY_FILE: "/run/secrets/k" }, false, false);
case_("hot dev file", { AUTHORITY_SECRET_KEY_FILE: "/run/secrets/k" }, false, true);
case_("read-only with file", { AUTHORITY_MODE: "read-only", AUTHORITY_SECRET_KEY_FILE: "/run/secrets/k", AUTHORITY_PUBKEY: PUBKEY }, true, false);

// 3c. readSecret: file form, production refusal of the env form, ambiguity.
{
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readSecret } = require("../src/security/secretFiles");
  const fs = require("fs"), os = require("os"), path = require("path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aof-secret-")), "k");
  fs.writeFileSync(file, "  s3cret\n", { mode: 0o600 });
  assert.equal(readSecret("K", { K_FILE: file }, true), "s3cret", "file form, trimmed");
  assert.equal(readSecret("K", { K: "dev" }, false), "dev", "env form allowed outside production");
  assert.throws(() => readSecret("K", { K: "prod" }, true), /Docker secret/, "env form refused in production");
  assert.throws(() => readSecret("K", { K: "a", K_FILE: file }, false), /both set/);
  assert.equal(readSecret("K", {}, true), undefined);
}

// 4. hot without a secret — refuse
case_("hot no secret", { AUTHORITY_MODE: "hot" }, false, false);

// 5. read-only: the production posture — ok without any secret
case_("read-only ok", { AUTHORITY_MODE: "read-only", AUTHORITY_PUBKEY: PUBKEY }, true, true);
case_("read-only ok dev", { AUTHORITY_MODE: "read-only", AUTHORITY_PUBKEY: PUBKEY }, false, true);

// 6. read-only WITH a secret in env — refuse: the key must be removed
const leaked = evaluateAuthorityGate({ AUTHORITY_MODE: "read-only", AUTHORITY_SECRET_KEY: SECRET, AUTHORITY_PUBKEY: PUBKEY }, true);
assert.equal(leaked.ok, false, "read-only must refuse when the secret is still in env");
assert.ok(/removed from the backend environment/.test(leaked.reason || ""), "reason must demand removing the key");

// 7. read-only without pubkey — refuse (PDA derivation needs it)
case_("read-only no pubkey", { AUTHORITY_MODE: "read-only" }, true, false);

// 8. unknown mode — refuse (fail closed on typos)
case_("bad mode", { AUTHORITY_MODE: "squads", AUTHORITY_SECRET_KEY: SECRET, AUTHORITY_PUBKEY: PUBKEY }, true, false);

// 9. empty string secret counts as absent
case_("hot empty secret", { AUTHORITY_MODE: "hot", AUTHORITY_SECRET_KEY: "" }, false, false);

console.log("authority gate self-test: 11 production custody matrix cases passed (fail-closed by default, explicit ack, read-only posture)");
