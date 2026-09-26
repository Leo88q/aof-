import { BN } from "bn.js";
import { Router } from "express";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import {AUTHORITY_PUBKEY} from "../config";
import { program } from "../provider";
import { authPda, configPda, materialMintsPda, seasonPassPda, seasonPda } from "../lib/pda";
import { authorityOnly, coSign, pk } from "../lib/tx";
import { requireAdmin } from "../middleware/adminAuth";
import { requireNoFraudHold } from "../security/fraudHold";

const r = Router();

r.post("/init", requireAdmin, async (req, res) => {
  try {
    const seasonId = Number(req.body.seasonId);
    const [config] = configPda();
    const [materialMints] = materialMintsPda();
    const [season] = seasonPda(seasonId);

    const ix = await (program.methods as any)
      .initSeason(seasonId)
      .accounts({
        config,
        authority: AUTHORITY_PUBKEY,
        season,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const sig = await authorityOnly([ix]);
    res.json({ sig });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

r.post("/pass/purchase", async (req, res) => {
  try {
    const user = pk(req.body.user);
    const seasonId = Number(req.body.seasonId);
    const treasury = pk(req.body.treasury);
    const [config] = configPda();
    const [season] = seasonPda(seasonId);
    const [seasonPass] = seasonPassPda(user, seasonId);

    const ix = await (program.methods as any)
      .purchaseSeasonPass()
      .accounts({
        config,
        user,
        treasury,
        season,
        seasonPass,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = await coSign([ix], user);
    res.json({ tx });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

r.post("/xp/grant", requireAdmin, async (req, res) => {
  try {
    const user = pk(req.body.user);
    const seasonId = Number(req.body.seasonId);
    const amount = Number(req.body.amount);
    const [config] = configPda();
    const [season] = seasonPda(seasonId);
    const [seasonPass] = seasonPassPda(user, seasonId);

    const ix = await (program.methods as any)
      .grantSeasonXp(amount)
      .accounts({
        config,
        authority: AUTHORITY_PUBKEY,
        user,
        season,
        seasonPass,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const sig = await authorityOnly([ix]);
    res.json({ sig });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

r.post("/reward/claim", requireAdmin, requireNoFraudHold("owner", "season_reward_claim"), async (req, res) => {
  try {
    const owner = pk(req.body.owner);
    const seasonId = Number(req.body.seasonId);
    const level = Number(req.body.level);
    const premiumTrack = Boolean(req.body.premiumTrack);
    const woodMint = pk(req.body.woodMint);
    const [config] = configPda();
    const [materialMints] = materialMintsPda();
    const [season] = seasonPda(seasonId);
    const [seasonPass] = seasonPassPda(owner, seasonId);
    const [auth] = authPda();
    const userWood = getAssociatedTokenAddressSync(woodMint, owner);

    const ix = await (program.methods as any)
      .claimSeasonReward(level, premiumTrack)
      .accounts({
        config,
        authority: AUTHORITY_PUBKEY,
        materialMints,
        season,
        seasonPass,
        woodMint,
        userWood,
        auth,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const sig = await authorityOnly([ix]);
    res.json({ sig });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default r;
