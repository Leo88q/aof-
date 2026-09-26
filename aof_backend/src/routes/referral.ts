import { BN } from "bn.js";
import { Router } from "express";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import {AUTHORITY_PUBKEY} from "../config";
import { program } from "../provider";
import {
  configPda,
  materialMintsPda,
  playerPda,
  referralLinkPda,
  referrerStatsPda,
  vaultGuardPda,
  vaultPda,
} from "../lib/pda";
import { authorityOnly, coSign, pk } from "../lib/tx";
import { requireCircuitOpen, requireWalletLimits, requireIdempotency } from "../middleware/security";
import { requireAdmin } from "../middleware/adminAuth";
import { assertNoFraudHold, sendFraudHold } from "../security/fraudHold";
import { PublicKey } from "@solana/web3.js";

const r = Router();

r.post("/bind", requireCircuitOpen, requireWalletLimits("referral_bind"), async (req, res) => {
  try {
    const referred = pk(req.body.referred);
    const referrer = pk(req.body.referrer);
    const [config] = configPda();
    const [referrerPlayer] = playerPda(referrer);
    const [referrerStats] = referrerStatsPda(referrer);
    const [referralLink] = referralLinkPda(referred);

    const ix = await (program.methods as any)
      .referralBind()
      .accounts({
        config,
        referred,
        referrer,
        referrerPlayer,
        referrerStats,
        referralLink,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = await coSign([ix], referred);
    res.json({ tx });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

r.post("/upgrade", async (req, res) => {
  try {
    const user = pk(req.body.user);
    const woodMint = pk(req.body.woodMint);
    const stoneMint = pk(req.body.stoneMint);
    const foodMint = pk(req.body.foodMint);
    const [config] = configPda();
    const [referralLink] = referralLinkPda(user);
    const userWood = getAssociatedTokenAddressSync(woodMint, user);
    const userStone = getAssociatedTokenAddressSync(stoneMint, user);
    const userFood = getAssociatedTokenAddressSync(foodMint, user);

    const ix = await (program.methods as any)
      .referralUpgrade()
      .accounts({
        config,
        user,
        referralLink,
        woodMint,
        userWood,
        stoneMint,
        userStone,
        foodMint,
        userFood,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = await coSign([ix], user);
    res.json({ tx });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// This route signs a vault transfer; only the trusted payout worker may call it.
r.post("/pay-out", requireAdmin, requireCircuitOpen, requireWalletLimits("referral_payout"), requireIdempotency, async (req, res) => {
  try {
    const referred = pk(req.body.referred);
    const mint = pk(req.body.mint);
    const userToken = pk(req.body.userToken);
    const referrerToken = pk(req.body.referrerToken);
    const amount = new BN(req.body.amount);
    const [config] = configPda();
    const [materialMints] = materialMintsPda();
    const [vault] = vaultPda();
    const [referralLink] = referralLinkPda(referred);
    // [SECURITY_CHECKLIST #48] neither party of a referral payout may be under fraud review
    const link: any = await (program.account as any)["referralLink"].fetch(referralLink);
    await assertNoFraudHold([referred.toBase58(), new PublicKey(link.referrer).toBase58()], "referral_payout");
    const vaultToken = getAssociatedTokenAddressSync(mint, vault, true);
    // [AUDIT F-01] same three brakes as `pay_out` (see tools.ts).
    const [player] = playerPda(referred);
    const [vaultGuard] = vaultGuardPda(mint);

    const ix = await (program.methods as any)
      .payOutWithReferral(amount as any)
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
        referralLink,
        referrerToken,
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

export default r;
