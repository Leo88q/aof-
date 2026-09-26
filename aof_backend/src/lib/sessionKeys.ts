/**
 * [ФИКС Группы 3] Кейстор сессионных ключей Farm-Trader.
 * Сессионный ключ — эфемерная пара, которой пользователь делегирует право
 * исполнять определённые инструкции (session_create в aof-market).
 *
 * [SECURITY_CHECKLIST #65] The session key is an SPL delegate on the user's
 * tool ATA, so a leaked keystore file is a stolen NFT. Keys are therefore
 * encrypted at rest with AES-256-GCM (SESSION_KEYSTORE_KEY, 32 bytes as base64
 * or hex — load it from a KMS/secret manager, never commit it):
 *   - no key configured  -> no key is ever created (fail closed);
 *   - legacy plaintext files are re-encrypted on first read;
 *   - the user id must be a canonical base58 pubkey (no path traversal).
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { readSecret } from "../security/secretFiles";

const KEYSTORE_DIR =
  process.env.SESSION_KEYSTORE_DIR ||
  path.join(process.cwd(), "data", "session-keys");

type EncryptedEntry = { v: 2; user: string; publicKey: string; iv: string; tag: string; ct: string; createdAt: string };

/** 32-byte keystore key from SESSION_KEYSTORE_KEY (base64 or hex), or null. */
export function keystoreKey(): Buffer | null {
  const raw = (readSecret("SESSION_KEYSTORE_KEY") || "").trim();
  if (!raw) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("SESSION_KEYSTORE_KEY must decode to exactly 32 bytes");
  return key;
}

function requireKey(): Buffer {
  const key = keystoreKey();
  if (!key) throw new Error("SESSION_KEYSTORE_KEY is not configured: refusing to handle session keys in plaintext");
  return key;
}

/** Only canonical base58 pubkeys name a keystore file. */
function canonicalUser(user: string): string {
  const pk = new PublicKey(user);
  if (pk.toBase58() !== user) throw new Error("user must be a canonical base58 public key");
  return user;
}

function fileFor(user: string): string {
  return path.join(KEYSTORE_DIR, `${canonicalUser(user)}.json`);
}

function encrypt(user: string, kp: Keypair, key: Buffer, createdAt = new Date().toISOString()): EncryptedEntry {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${user}:${kp.publicKey.toBase58()}`));
  const ct = Buffer.concat([cipher.update(Buffer.from(kp.secretKey)), cipher.final()]);
  return {
    v: 2, user, publicKey: kp.publicKey.toBase58(),
    iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64"), createdAt,
  };
}

function decrypt(entry: EncryptedEntry, key: Buffer): Keypair {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"));
  decipher.setAAD(Buffer.from(`${entry.user}:${entry.publicKey}`));
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  const secret = Buffer.concat([decipher.update(Buffer.from(entry.ct, "base64")), decipher.final()]);
  const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
  if (kp.publicKey.toBase58() !== entry.publicKey) throw new Error("keystore entry public key mismatch");
  return kp;
}

function write(file: string, entry: EncryptedEntry): void {
  fs.mkdirSync(KEYSTORE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function read(user: string, file: string, key: Buffer): Keypair {
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (raw && raw.v === 2) {
    if (raw.user !== user) throw new Error("keystore entry belongs to another user");
    return decrypt(raw as EncryptedEntry, key);
  }
  // Legacy plaintext entry: migrate it to the encrypted format immediately.
  const kp = Keypair.fromSecretKey(Uint8Array.from(raw.secretKey));
  write(file, encrypt(user, kp, key, raw.createdAt));
  return kp;
}

/** Получить или создать сессионный ключ пользователя */
export function getOrCreateSessionKeypair(user: string): Keypair {
  const key = requireKey();
  const file = fileFor(user);
  if (fs.existsSync(file)) return read(user, file, key);
  const kp = Keypair.generate();
  write(file, encrypt(user, kp, key));
  return kp;
}

/** Загрузить существующий ключ (null если нет или ключ шифрования не задан) */
export function loadSessionKeypair(user: string): Keypair | null {
  const key = keystoreKey();
  if (!key) return null;
  let file: string;
  try {
    file = fileFor(user);
  } catch {
    return null;
  }
  if (!fs.existsSync(file)) return null;
  try {
    return read(user, file, key);
  } catch {
    return null;
  }
}
