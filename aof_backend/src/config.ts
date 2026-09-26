import "dotenv/config";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { evaluateAuthorityGate } from "./security/authorityGate";
import { readSecret } from "./security/secretFiles";

const isProduction = process.env.NODE_ENV === "production";
export const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
if (isProduction && (!process.env.RPC_URL || /devnet|localhost|127\.0\.0\.1/i.test(RPC_URL))) {
  throw new Error("Production requires an explicit non-devnet RPC_URL");
}
if (!process.env.PROGRAM_ID || !process.env.TREASURY_PUBKEY) {
  throw new Error("PROGRAM_ID and TREASURY_PUBKEY are required");
}
// [AUDIT AOF-H1] Authority key custody gate (see src/security/authorityGate.ts):
// production starts with a hot authority secret only behind an explicit,
// reviewable acknowledgment; AUTHORITY_MODE=read-only forbids the secret
// entirely and the backend then refuses every signing attempt with 503.
const authorityDecision = evaluateAuthorityGate(process.env, isProduction);
if (!authorityDecision.ok) {
  throw new Error(`Authority gate [AOF-H1]: ${authorityDecision.reason}`);
}
for (const warning of authorityDecision.warnings) {
  // No key material in logs — the warning names modes/flags only.
  // eslint-disable-next-line no-console
  console.warn(`[authority-gate] ${warning}`);
}
if (isProduction) {
  if (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.length < 32) {
    throw new Error("Production requires a random ADMIN_TOKEN of at least 32 characters");
  }
  if (!process.env.EXPECTED_GENESIS_HASH) throw new Error("Production requires EXPECTED_GENESIS_HASH");
  if (!process.env.WALLET_PROOF_DOMAIN || !/^[A-Za-z0-9._-]{1,64}$/.test(process.env.WALLET_PROOF_DOMAIN)) {
    throw new Error("Production requires a deployment-specific WALLET_PROOF_DOMAIN");
  }
}
export const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);

/**
 * [AUDIT AOF-H1] Null in read-only mode: no hot secret in this process.
 * Signing paths (lib/tx.ts) fail closed on null with HTTP 503.
 */
export const AUTHORITY: Keypair | null =
  authorityDecision.mode === "hot"
    ? Keypair.fromSecretKey(bs58.decode(readSecret("AUTHORITY_SECRET_KEY") as string))
    : null;
/** The authority PUBLIC key in both modes — use this for accounts/PDAs. */
export const AUTHORITY_PUBKEY: PublicKey = AUTHORITY
  ? AUTHORITY.publicKey
  : new PublicKey(process.env.AUTHORITY_PUBKEY as string);
export const TREASURY = new PublicKey(process.env.TREASURY_PUBKEY);
export const PORT = Number(process.env.PORT || 8080);

// Optional read-only admin credential (audit logs, economy snapshots, security
// stats). Must differ from the operator token, otherwise the split is moot.
export const ADMIN_READ_TOKEN = process.env.ADMIN_READ_TOKEN || "";
if (ADMIN_READ_TOKEN) {
  if (ADMIN_READ_TOKEN.length < 32) throw new Error("ADMIN_READ_TOKEN must be at least 32 characters");
  if (ADMIN_READ_TOKEN === process.env.ADMIN_TOKEN) throw new Error("ADMIN_READ_TOKEN must differ from ADMIN_TOKEN");
}

// Number of trusted reverse-proxy hops in front of Express (nginx, Caddy, a
// cloud load balancer). Rate limiting and audit IPs are derived from
// X-Forwarded-For only up to this depth; anything beyond is attacker-controlled.
// 0 disables proxy trust entirely. Production must set it explicitly so the
// per-IP limiter does not collapse every client into the proxy's address.
const trustProxyRaw = process.env.TRUST_PROXY_HOPS;
if (isProduction && (trustProxyRaw === undefined || trustProxyRaw === "")) {
  throw new Error("Production requires TRUST_PROXY_HOPS (0 if the app is exposed directly)");
}
export const TRUST_PROXY_HOPS = Number(trustProxyRaw ?? 0);
if (!Number.isInteger(TRUST_PROXY_HOPS) || TRUST_PROXY_HOPS < 0 || TRUST_PROXY_HOPS > 10) {
  throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 10");
}

// Mining remains fail-closed until the on-chain program and validator suite
// have been verified. Set explicitly in the test environment first; do not
// enable in production as part of a build-only deploy.
export const MINING_ENABLED = !isProduction && process.env.MINING_ENABLED === "true";
