#!/usr/bin/env node
/**
 * [SECURITY_CHECKLIST #58, decision 2026-09-26] Propose per-resource supply
 * caps from the on-chain economy constants and emit the `set_supply_cap`
 * instructions for the admin multisig (Squads) to review and sign.
 *
 *   npm ci   # workspace root: provides @solana/web3.js for PDAs/messages
 *   node scripts/economy/propose-caps.mjs --vault <SQUADS_VAULT_PUBKEY> \
 *        [--dau 1000] [--days 42] [--safety 1.5] [--other-daily 100] \
 *        [--rpc https://...] [--out caps-plan.json]
 *
 * Model (display units per player per day, all constants read from
 * aof-core/src/constants.rs so the model cannot drift from the program):
 *   mining   DEFAULT_VILLAGERS x BASE_RATE_MINING x legendary yield x 24h,
 *            split over Circuit / Silicon / Neuron / Dataset
 *   Power    24h x expected well rate (weather odds 10/50/30/10 %, pinned by
 *            the Rust test weather_distribution_matches_the_documented_odds)
 *   Synapse  Neuron x SYNAPSE_YIELD_MULT; Signal/Model <= their input
 *   season   Circuit += SEASON_REWARD_UNITS_PER_LEVEL x (1+..+max level) x 2
 *            tracks per player per season (claim_season_reward)
 *   other    --other-daily for crafted / operator-issued kinds
 * cap = current supply + daily x DAU x days x safety (in atomic units).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const KIND_NAMES = [
  "Data", "Circuit", "Silicon", "Neuron", "Synapse", "Signal", "Model", "Power", "Compute", "Dataset",
  "BlueCore", "PurpleCore", "RedCore", "ClearQuartz", "RoseQuartz", "AmberQuartz", "QuantumBit", "NeuralChip",
  "PhotonBit", "BioChip", "CryoFluid", "VoltFluid", "BioFluid", "NanoFluid", "QuantumFluid", "SoulCore", "Mind",
];
const U64_MAX = 0xffffffffffffffffn;

function product(expr, unit) {
  return expr.split("*").map((t) => t.trim()).reduce((acc, t) => acc * (t === "RESOURCE_UNIT" ? unit : Number(t.replace(/_/g, ""))), 1);
}

/** Economy constants straight from the Rust source. */
export function readConstants(src = readFileSync(path.join(root, "aof-core/src/constants.rs"), "utf8")) {
  const raw = (name) => {
    const m = new RegExp(`pub const ${name}: [a-z0-9]+ = ([^;]+);`).exec(src);
    if (!m) throw new Error(`constant ${name} not found in constants.rs`);
    return m[1];
  };
  const unit = Number(raw("RESOURCE_UNIT").replace(/_/g, ""));
  const units = (name) => product(raw(name), unit) / unit;
  return {
    unit,
    baseRate: product(raw("BASE_RATE_MINING"), unit),
    yieldLegendaryBps: product(raw("YIELD_BPS_LEGENDARY"), unit),
    villagers: product(raw("DEFAULT_VILLAGERS"), unit),
    well: ["WELL_RATE_BLACKOUT", "WELL_RATE_NOMINAL", "WELL_RATE_SURGE", "WELL_RATE_FRENZY"].map(units),
    synapseMultBps: product(raw("SYNAPSE_YIELD_MULT_BPS"), unit),
    rewardPerLevel: product(raw("SEASON_REWARD_UNITS_PER_LEVEL"), unit),
    maxLevel: product(raw("SEASON_PASS_MAX_LEVEL"), unit),
    seasonDays: product(raw("SEASON_LENGTH_SECONDS"), unit) / 86_400,
  };
}

export function dailyPerPlayer(c, otherDaily) {
  const d = new Array(KIND_NAMES.length).fill(otherDaily);
  // Integer arithmetic first, one division last: exact for the shipped constants.
  const mining = (c.villagers * c.baseRate * c.yieldLegendaryBps * 24) / 10_000;
  for (const k of [1, 2, 3, 9]) d[k] = mining / 4;
  d[7] = ((10 * c.well[0] + 50 * c.well[1] + 30 * c.well[2] + 10 * c.well[3]) * 24) / 100;
  d[4] = (d[3] * c.synapseMultBps) / 10_000;
  d[5] = d[4];
  d[6] = d[5];
  return d;
}

/** Circuit a player can claim in one season: every level on both tracks. */
export function seasonRewardPerPlayer(c) {
  return c.rewardPerLevel * ((c.maxLevel * (c.maxLevel + 1)) / 2) * 2;
}

export function proposeCaps({ c, dau, days, safety, otherDaily, supply = [] }) {
  if (!(dau > 0 && days > 0 && safety >= 1 && otherDaily >= 0)) throw new Error("invalid model parameters");
  const daily = dailyPerPlayer(c, otherDaily);
  const seasons = Math.ceil(days / c.seasonDays);
  return daily.map((perDay, kind) => {
    let units = perDay * dau * days;
    if (kind === 1) units += seasonRewardPerPlayer(c) * dau * seasons;
    const capUnits = Math.ceil(units * safety);
    const capAtomic = BigInt(supply[kind] ?? 0) + BigInt(capUnits) * BigInt(c.unit);
    if (capAtomic > U64_MAX) throw new Error(`${KIND_NAMES[kind]}: cap exceeds u64`);
    return { kind, name: KIND_NAMES[kind], dailyPerPlayer: perDay, capUnits, capAtomic };
  });
}

/** `set_supply_cap(kind, max_supply)` instruction data from the committed IDL. */
export function encodeSetSupplyCap(kind, capAtomic, idl = JSON.parse(readFileSync(path.join(root, "aof_backend/src/idl/aof_core.json"), "utf8"))) {
  const ix = idl.instructions.find((i) => i.name === "set_supply_cap");
  const data = Buffer.alloc(17);
  Buffer.from(ix.discriminator).copy(data, 0);
  data[8] = kind;
  data.writeBigUInt64LE(BigInt(capAtomic), 9);
  return { data, accounts: ix.accounts.map((a) => ({ name: a.name, signer: !!a.signer, writable: !!a.writable })), programId: idl.address };
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

// ---------------------------------------------------------------- CLI

function args(argv) {
  const o = { dau: 1000, days: 42, safety: 1.5, otherDaily: 100, out: "caps-plan.json" };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    o[k] = ["vault", "rpc", "out"].includes(k) ? argv[i + 1] : Number(argv[i + 1]);
  }
  return o;
}

async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function currentSupply(url, web3, programId) {
  const pda = (seed) => web3.PublicKey.findProgramAddressSync([Buffer.from(seed)], programId)[0];
  const [cfg, mm] = (await rpc(url, "getMultipleAccounts", [[pda("config").toBase58(), pda("material_mints").toBase58()], { encoding: "base64" }])).value
    .map((a) => Buffer.from(a.data[0], "base64"));
  const key = (buf, at) => new web3.PublicKey(buf.subarray(at, at + 32)).toBase58();
  // ResourceKind -> mint, as state::mint_for_kind / orderbook::expected_resource_mint.
  const mints = [key(cfg, 72), key(cfg, 104), key(cfg, 136), ...Array.from({ length: 23 }, (_, i) => key(mm, 8 + 32 * i)), key(cfg, 232)];
  const accounts = (await rpc(url, "getMultipleAccounts", [mints, { encoding: "base64" }])).value;
  return accounts.map((a) => (a ? Buffer.from(a.data[0], "base64").readBigUInt64LE(36) : 0n));
}

async function main() {
  const o = args(process.argv.slice(2));
  if (!o.vault) throw new Error("--vault <Squads vault pubkey> is required (it is the admin authority)");
  const web3 = await import("@solana/web3.js");
  const idl = JSON.parse(readFileSync(path.join(root, "aof_backend/src/idl/aof_core.json"), "utf8"));
  const programId = new web3.PublicKey(idl.address);
  const supply = o.rpc ? await currentSupply(o.rpc, web3, programId) : [];
  if (!o.rpc) console.warn("[warn] no --rpc: current supply assumed 0 (devnet/fresh deployment only)");
  const caps = proposeCaps({ c: readConstants(), dau: o.dau, days: o.days, safety: o.safety, otherDaily: o.otherDaily, supply });
  const vault = new web3.PublicKey(o.vault);
  const pda = (seed) => web3.PublicKey.findProgramAddressSync([Buffer.from(seed)], programId)[0];
  const blockhash = o.rpc ? (await rpc(o.rpc, "getLatestBlockhash", [])).value.blockhash : web3.PublicKey.default.toBase58();
  const batches = [];
  for (let i = 0; i < caps.length; i += 9) {
    const tx = new web3.Transaction({ feePayer: vault, recentBlockhash: blockhash });
    for (const cap of caps.slice(i, i + 9)) {
      const enc = encodeSetSupplyCap(cap.kind, cap.capAtomic, idl);
      tx.add(new web3.TransactionInstruction({
        programId,
        keys: [
          { pubkey: pda("config"), isSigner: false, isWritable: false },
          { pubkey: vault, isSigner: true, isWritable: false },
          { pubkey: pda("material_mints"), isSigner: false, isWritable: true },
        ],
        data: enc.data,
      }));
    }
    batches.push(base58(tx.compileMessage().serialize()));
  }
  console.table(caps.map((c) => ({ kind: c.kind, name: c.name, perPlayerPerDay: c.dailyPerPlayer, capUnits: c.capUnits })));
  const plan = { generatedAt: new Date().toISOString(), params: { dau: o.dau, days: o.days, safety: o.safety, otherDaily: o.otherDaily, rpc: !!o.rpc },
    caps: caps.map((c) => ({ ...c, capAtomic: c.capAtomic.toString() })), squadsMessagesBase58: batches };
  writeFileSync(o.out, JSON.stringify(plan, null, 2));
  console.log(`wrote ${o.out}: ${caps.length} caps in ${batches.length} unsigned messages for the Squads vault ${o.vault}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
