import { BN } from "bn.js";
import { Router } from "express";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram, PublicKey } from "@solana/web3.js";
import {AUTHORITY_PUBKEY} from "../config";
import { program } from "../provider";
import {
  authPda,
  configPda,
  craftEconomyPda,
  gastankPda,
  playerPda,
  rarityCounterPda,
  toolPda,
  vaultPda,
  materialMintsPda,
  vaultGuardPda,
} from "../lib/pda";
import { authorityOnly, coSign, pk } from "../lib/tx";
import { simulateTransaction } from "../security/txSimulator";
import { fetchOne } from "../lib/decode";
import { miningEnabledOnChain } from "../lib/configState";
import { Keypair, Transaction } from "@solana/web3.js";
import { MINT_SIZE, createInitializeMintInstruction, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { connection } from "../provider";
import { criticalOperationGuard, requireCircuitOpen, requireWalletLimits } from "../middleware/security";
import { requireAdmin } from "../middleware/adminAuth";
import { assertNoFraudHold, sendFraudHold } from "../security/fraudHold";

/**
 * [AUDIT F-01] Resolve the wallet that owns a token account (SPL layout:
 * `mint` at 0..32, `owner` at 32..64). Read from chain instead of trusting a
 * body field, so `player` can never be mismatched with `userToken`.
 */
async function tokenAccountOwner(tokenAccount: PublicKey): Promise<PublicKey> {
  const { connection } = await import("../provider");
  const info = await connection.getAccountInfo(tokenAccount, "confirmed");
  if (!info) throw new Error("destination token account does not exist");
  if (info.data.length < 64) throw new Error("destination is not a token account");
  return new PublicKey(info.data.subarray(32, 64));
}

const r = Router();
const RESOURCE_UNIT = 1_000_000_000;
const displayResource = (value: number) => value / RESOURCE_UNIT;

const rarityMap: Record<string, any> = {
  common: { common: {} },
  uncommon: { uncommon: {} },
  rare: { rare: {} },
  epic: { epic: {} },
  legendary: { legendary: {} },
};

r.post("/mint", requireAdmin, async (req, res) => {
  try {
    const owner = pk(req.body.owner);
    const mint = pk(req.body.mint);
    const toolType = req.body.toolType;
    const rarity = rarityMap[req.body.rarity];
    const [config] = configPda();
    const [auth] = authPda();
    const [toolData] = toolPda(mint);
    const tokenAccount = getAssociatedTokenAddressSync(mint, owner);

    const ix = await (program.methods as any)
      .mintTool(toolType, rarity)
      .accounts({
        config,
        authority: AUTHORITY_PUBKEY,
        auth,
        mint,
        tokenAccount,
        // [AUDIT F-22] the destination ATA must belong to the intended owner.
        recipient: owner,
        toolData,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const sig = await authorityOnly([ix]);
    res.json({ sig });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});


// [NEW] Калькулятор стоимости крафта (WOOD + STONE + FOOD)
r.post("/craft-quote", async (req, res) => {
  try {
    const rarity = req.body.rarity; // "uncommon" | "rare" | "epic" | "legendary"
    const rarityIdx = ["common", "uncommon", "rare", "epic", "legendary"].indexOf(rarity);
    if (rarityIdx < 1 || rarityIdx > 4) return res.status(400).json({ error: "invalid rarity" });
    
    const [craftEconomy] = craftEconomyPda();
    const [rarityCounter] = rarityCounterPda(rarityIdx);
    const econ: any = await fetchOne("craftEconomy", craftEconomy);
    const counter: any = await fetchOne("rarityCounter", rarityCounter);
    
    if (!econ || !counter) {
      return res.status(503).json({ error: "craft economy or rarity counter unavailable from canonical chain" });
    }

    const idx = rarityIdx - 1;
    const minted = Number(counter.mintedCount?.toString?.() ?? counter.mintedCount ?? 0);
    const requiredArrays = [
      econ.woodBase, econ.woodMult, econ.stoneBase, econ.stoneMult,
      econ.foodBase, econ.foodMult, econ.seedsBase, econ.seedsMult,
      econ.waterBase, econ.waterMult, econ.potatoBase, econ.potatoMult,
    ];
    if (requiredArrays.some((values: any) => !Array.isArray(values) || values.length < 4)) {
      return res.status(503).json({ error: "craft economy arrays are incomplete on canonical chain" });
    }
    const circuit = displayResource(Number(econ.woodBase[idx]) + minted * Number(econ.woodMult[idx]));
    const silicon = displayResource(Number(econ.stoneBase[idx]) + minted * Number(econ.stoneMult[idx]));
    const data = displayResource(Number(econ.foodBase?.[idx] || 0) + minted * Number(econ.foodMult?.[idx] || 0));
    const neuron = displayResource(Number(econ.seedsBase?.[idx] || 0) + minted * Number(econ.seedsMult?.[idx] || 0));
    const power = displayResource(Number(econ.waterBase?.[idx] || 0) + minted * Number(econ.waterMult?.[idx] || 0));
    const mind = displayResource(Number(econ.potatoBase?.[idx] || 0) + minted * Number(econ.potatoMult?.[idx] || 0));
    
    // SKR discount is deliberately fail-closed. There is no canonical SKR
    // mint in Config/MaterialMints and the on-chain craft instruction does
    // not apply a discount, so the quote must never advertise reduced POTATO.
    const privilege = {
      source: "DISABLED_UNTIL_CANONICAL_MINT",
      discountBps: 0,
    };
    res.json({ circuit, silicon, data, neuron, power, mind, minted, privilege }); // [REBRAND] ex wood/stone/food/seeds/water/potato
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

r.post("/craft", requireCircuitOpen, requireWalletLimits("tools_craft"), async (req, res) => {
  try {
    const user = pk(req.body.user);
    const prevMint = pk(req.body.prevMint);
    const newMint = pk(req.body.newMint);
    const toolType = req.body.toolType;
    const rarity = rarityMap[req.body.rarity];
    const rarityIdx = ["common", "uncommon", "rare", "epic", "legendary"].indexOf(req.body.rarity);

    const [config] = configPda();
    const [gastank] = gastankPda(user);
    const [prevTool] = toolPda(prevMint);
    const [newToolData] = toolPda(newMint);
    const [auth] = authPda();
    const [rarityCounter] = rarityCounterPda(rarityIdx);
    const [craftEconomy] = craftEconomyPda();
    const prevToken = getAssociatedTokenAddressSync(prevMint, user);
    const newToken = getAssociatedTokenAddressSync(newMint, user);
    const woodMint = pk(req.body.woodMint);
    const stoneMint = pk(req.body.stoneMint);
    const foodMint = pk(req.body.foodMint);
    // The legacy Craft account map still contains skrMint/userSkr, but the
    // program intentionally ignores them until a canonical SKR mint exists.
    // Bind the unused compatibility accounts to canonical FOOD instead of
    // accepting an arbitrary caller-supplied mint or failing on an empty one.
    const skrMint = foodMint;
    const userWood = getAssociatedTokenAddressSync(woodMint, user);
    const userStone = getAssociatedTokenAddressSync(stoneMint, user);

    const ix = await (program.methods as any)
      .craft(toolType, rarity)
      .accounts({
        config,
        authority: AUTHORITY_PUBKEY,
        user,
        gastank,
        prevTool,
        prevMint,
        prevToken,
        newMint,
        newToken,
        newToolData,
        auth,
        rarityCounter,
        craftEconomy,
        woodMint,
        userWood,
        stoneMint,
        userStone,
        // [НОВОЕ] 4 дополнительных ресурса
        foodMint,
        userFood: getAssociatedTokenAddressSync(foodMint, user),
        seedsMint: pk(req.body.seedsMint),
        userSeeds: getAssociatedTokenAddressSync(pk(req.body.seedsMint), user),
        waterMint: pk(req.body.waterMint),
        userWater: getAssociatedTokenAddressSync(pk(req.body.waterMint), user),
        potatoMint: pk(req.body.potatoMint),
        userPotato: getAssociatedTokenAddressSync(pk(req.body.potatoMint), user),
        // [НОВОЕ] SKR для ончейн-проверки скидки
        skrMint,
        userSkr: getAssociatedTokenAddressSync(skrMint, user),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // [ФИКС] FOOD теперь сжигается внутри контракта в инструкции craft
    // Отдельный burnResource больше не нужен
    const tx = await coSign([ix], user);
    res.json({ tx });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});


// Atomic repair quote: the on-chain instruction burns STONE and WOOD.
r.post("/repair-quote", async (req, res) => {
  try {
    const mint = pk(req.body.mint);
    const amount = Number(req.body.amount);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 20) {
      return res.status(400).json({ error: "amount must be a positive integer" });
    }
    const [tool] = toolPda(mint);
    const toolData: any = await fetchOne("toolData", tool);
    if (!toolData) return res.status(400).json({ error: "tool not found" });
    
    // These values mirror Rarity::repair_*_cost_per_unit() in aof-core.
    const siliconCosts: Record<string, number> = {
      common: 2_000_000_000, uncommon: 4_000_000_000, rare: 9_000_000_000,
      epic: 20_000_000_000, legendary: 45_000_000_000,
    };
    const circuitCosts: Record<string, number> = {
      common: 3_000_000_000, uncommon: 6_000_000_000, rare: 14_000_000_000,
      epic: 30_000_000_000, legendary: 70_000_000_000,
    };
    const rarQ = toolData.rarity;
    const rkQ = typeof rarQ === "object" && rarQ ? Object.keys(rarQ)[0] : String(rarQ || "common");
    const silicon = (siliconCosts[rkQ] || 0) * amount;
    const circuit = (circuitCosts[rkQ] || 0) * amount;

    res.json({ silicon, circuit, amount }); // [REBRAND] ex stone/wood
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

r.post("/repair", async (req, res) => {
  try {
    const user = pk(req.body.user);
    const mint = pk(req.body.mint);
    const amount = Number(req.body.amount);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 20) {
      return res.status(400).json({ error: "amount must be a positive integer" });
    }
    const [config] = configPda();
    const [tool] = toolPda(mint);
    const cfg: any = await fetchOne("config", config);
    if (!cfg?.stoneMint || !cfg?.woodMint) {
      return res.status(503).json({ error: "REPAIR_RESOURCES_NOT_CONFIGURED" });
    }
    // The program binds both mints to Config. Do not trust caller-supplied
    // resource addresses and do not build a second burn transaction: Repair
    // burns stone and wood atomically with the durability update.
    const stoneMint = new PublicKey(cfg.stoneMint);
    const woodMint = new PublicKey(cfg.woodMint);
    const userStone = getAssociatedTokenAddressSync(stoneMint, user);
    const userWood = getAssociatedTokenAddressSync(woodMint, user);
    const repairIx = await (program.methods as any)
      .repair(amount)
      .accounts({
        config,
        user,
        tool,
        mint,
        stoneMint,
        userStone,
        woodMint,
        userWood,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const createStoneAta = createAssociatedTokenAccountIdempotentInstruction(
      user, userStone, user, stoneMint,
    );
    const createWoodAta = createAssociatedTokenAccountIdempotentInstruction(
      user, userWood, user, woodMint,
    );
    const tx = await coSign([createStoneAta, createWoodAta, repairIx], user);
    res.json({ tx });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

r.post("/stake", requireCircuitOpen, requireWalletLimits("tools_stake"), async (req, res) => {
  try {
    const user = pk(req.body.user);
    const mint = pk(req.body.mint);
    const lockSeconds = new BN(req.body.lockSeconds);
    const [config] = configPda();
    const [tool] = toolPda(mint);
    const [vault] = vaultPda();
    const userToken = getAssociatedTokenAddressSync(mint, user);
    const vaultToken = getAssociatedTokenAddressSync(mint, vault, true);

    const ix = await (program.methods as any)
      .stake(lockSeconds as any)
      .accounts({
        config,
        user,
        tool,
        mint,
        userToken,
        vault,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = await coSign([ix], user);
    res.json({ tx });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

r.post("/unstake", requireCircuitOpen, requireWalletLimits("tools_unstake"), async (req, res) => {
  try {
    const user = pk(req.body.user);
    const mint = pk(req.body.mint);
    const [config] = configPda();
    const [tool] = toolPda(mint);
    const [vault] = vaultPda();
    const [gastank] = gastankPda(user);
    const userToken = getAssociatedTokenAddressSync(mint, user);
    const vaultToken = getAssociatedTokenAddressSync(mint, vault, true);

    const ix = await (program.methods as any)
      .unstake()
      .accounts({
        config,
        user,
        tool,
        mint,
        userToken,
        gastank,
        vault,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = await coSign([ix], user);
    res.json({ tx });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Mining settlement is atomic on aof-core: the same signed instruction
// checks the completed session, mints the canonical resource, decrements
// durability, and frees the villager. No authority payout worker or
// second transaction is involved.
r.post("/start-mining", requireCircuitOpen, requireWalletLimits("tools_start_mining"), async (req, res) => {
  // [AUDIT F-27] read the flag from the chain, not from `.env`.
  if (!(await miningEnabledOnChain())) {
    return res.status(503).json({ error: "MINING_DISABLED_ONCHAIN" });
  }
  try {
    const user = pk(req.body.user);
    const mint = pk(req.body.mint);
    const hours = Number(req.body.hours);
    if (!Number.isInteger(hours) || hours <= 0) {
      return res.status(400).json({ error: "hours must be a positive integer" });
    }

    const [config] = configPda();
    const [tool] = toolPda(mint);
    const [player] = playerPda(user);
    const ix = await (program.methods as any)
      .startMining(hours)
      .accounts({
        config,
        user,
        tool,
        mint,
        player,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = await coSign([ix], user);
    res.json({ tx });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

r.post("/collect-mining", requireCircuitOpen, requireWalletLimits("tools_collect_mining"), async (req, res) => {
  // [AUDIT F-27] read the flag from the chain, not from `.env`.
  if (!(await miningEnabledOnChain())) {
    return res.status(503).json({ error: "MINING_DISABLED_ONCHAIN" });
  }
  try {
    const user = pk(req.body.user);
    const mint = pk(req.body.mint);
    const [config] = configPda();
    const [tool] = toolPda(mint);
    const [player] = playerPda(user);
    const [materialMints] = materialMintsPda();
    const [auth] = authPda();

    // Resolve only the destination account. The program repeats this mapping
    // and rejects any caller-supplied/non-canonical payout mint.
    const toolData: any = await fetchOne("toolData", tool);
    const cfg: any = await fetchOne("config", config);
    const materials: any = await fetchOne("materialMints", materialMints);
    if (!toolData || !cfg || !materials) {
      return res.status(503).json({ error: "MINING_NOT_CONFIGURED_ON_CHAIN" });
    }
    const toolType = String(toolData.toolType || "").toLowerCase();
    const resourceMint = toolType === "axe"
      ? cfg.woodMint
      : toolType === "pick"
      ? cfg.stoneMint
      : toolType === "bow"
      ? materials.meat
      : toolType === "reaper"
      ? materials.seeds
      : null;
    if (!resourceMint) {
      return res.status(503).json({ error: "MINING_TOOL_REWARD_NOT_CONFIGURED" });
    }

    const payoutMint = resourceMint instanceof PublicKey ? resourceMint : new PublicKey(resourceMint);
    const payoutToken = getAssociatedTokenAddressSync(payoutMint, user);
    const ix = await (program.methods as any)
      .collectMining()
      .accounts({
        config,
        user,
        tool,
        mint,
        player,
        materialMints,
        auth,
        payoutMint,
        payoutToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    // The ATA creation and the settlement are one wallet-signed transaction.
    const createPayoutAta = createAssociatedTokenAccountIdempotentInstruction(
      user, payoutToken, user, payoutMint,
    );
    const tx = await coSign([createPayoutAta, ix], user);
    res.json({ tx, resourceMint: payoutMint.toBase58() });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

r.post("/burn", requireCircuitOpen, requireWalletLimits("tools_burn"), async (req, res) => {
  try {
    const user = pk(req.body.user);
    const mint = pk(req.body.mint);
    const [config] = configPda();
    const [tool] = toolPda(mint);
    const tokenAccount = getAssociatedTokenAddressSync(mint, user);

    const ix = await (program.methods as any)
      .burnNft()
      .accounts({
        config,
        user,
        mint,
        tool,
        tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = await coSign([ix], user);
    res.json({ tx });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

r.post("/pay-out", requireAdmin, requireCircuitOpen, requireWalletLimits("tools_payout"), async (req, res) => {
  try {
    const userToken = pk(req.body.userToken);
    const mint = pk(req.body.mint);
    const amount = new BN(req.body.amount);
    const [config] = configPda();
    const [vault] = vaultPda();
    const [materialMints] = materialMintsPda();
    const vaultToken = getAssociatedTokenAddressSync(mint, vault, true);
    // [AUDIT F-01] `pay_out` now requires the recipient to be an existing Player
    // PDA and charges a per-mint VaultGuard budget. The Player is derived from
    // the owner of the destination token account, which we read from chain so a
    // caller cannot pass a mismatched player.
    const recipient = await tokenAccountOwner(userToken);
    // [SECURITY_CHECKLIST #48] no vault payout to a wallet under fraud review
    await assertNoFraudHold([recipient.toBase58()], "vault_payout");
    const [player] = playerPda(recipient);
    const [vaultGuard] = vaultGuardPda(mint);

    const ix = await (program.methods as any)
      .payOut(amount as any)
      .accounts({
        config,
        authority: AUTHORITY_PUBKEY,
        materialMints,
        vaultGuard,
        player,
        vault,
        mint,
        vaultToken,
        userToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const sig = await authorityOnly([ix]);
    res.json({ sig });
  } catch (e: any) {
    if (sendFraudHold(res, e)) return;
    res.status(400).json({ error: e.message });
  }
});


// [NEW] Подготовка нового минта для Крафта/Паков: создаём SPL-минт (власть = auth-PDA) + ATA владельца
// User pays rent and network fees; the authority never sponsors arbitrary mints.
r.post("/prep-mint", requireCircuitOpen, requireWalletLimits("tools_prep_mint"), async (req, res) => {
  try {
    const owner = pk(req.body.owner);
    const mintKp = Keypair.generate();
    const [auth] = authPda();
    const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
    const userToken = getAssociatedTokenAddressSync(mintKp.publicKey, owner);
    const tx = await coSign([
      SystemProgram.createAccount({
        fromPubkey: owner,
        newAccountPubkey: mintKp.publicKey,
        lamports,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(mintKp.publicKey, 0, auth, null),
      createAssociatedTokenAccountIdempotentInstruction(owner, userToken, owner, mintKp.publicKey),
    ], owner, [mintKp]);
    res.json({ tx, mint: mintKp.publicKey.toBase58() });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});


// Disabled because aof-core does not expose a verified use_flask instruction.
r.post("/use-flask", (_req, res) => {
  res.status(503).json({ error: "FLASK_USE_DISABLED_UNTIL_ONCHAIN_INSTRUCTION_EXISTS" });
});

/*
r.post("/use-flask", async (req, res) => {
  try {
    const user = pk(req.body.user);
    const flaskType = Number(req.body.flaskType); // 1-5
    const flaskMint = pk(req.body.flaskMint);
    
    // Валидация типа флакона
    if (flaskType < 1 || flaskType > 5) {
      return res.status(400).json({ error: "Invalid flask type (must be 1-5)" });
    }
    
    const [playerState] = playerPda(user);
    const userFlask = getAssociatedTokenAddressSync(flaskMint, user);
    
    const ix = await (program.methods as any)
      .useFlask(flaskType)
      .accounts({
        player: user,
        playerState,
        userFlask,
        flaskMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    
    const tx = await coSign([ix], user);
    res.json({ tx, message: `Flask type ${flaskType} used! Buff active for 1 hour.` });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
*/

export default r;
