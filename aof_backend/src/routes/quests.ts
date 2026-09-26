import { Router } from "express";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import {AUTHORITY_PUBKEY} from "../config";
import { questsProgram } from "../provider";
import {
  questConfigPda,
  questsProgramDataPda,
  questTemplatePda,
  questProgressPda,
} from "../lib/pda";
import { authorityOnly, coSign, pk } from "../lib/tx";
import { requireCircuitOpen, requireWalletLimits, requireIdempotency } from "../middleware/security";
import { requireAdmin } from "../middleware/adminAuth";
import { requireNoFraudHold } from "../security/fraudHold";

const r = Router();

// Инициализация конфигурации заданий
r.post("/config/init", requireAdmin, async (req, res) => {
  try {
    const mascotMint = pk(req.body.mascotMint || req.body.potatoMint);
    const treasuryMascot = pk(req.body.treasuryMascot || req.body.treasuryPotato);

    const [questConfig] = questConfigPda();
    const [programData] = questsProgramDataPda();

    const ix = await (questsProgram.methods as any)
      .initQuestConfig(mascotMint, treasuryMascot)
      .accounts({
        questConfig,
        authority: AUTHORITY_PUBKEY,
        programData,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const sig = await authorityOnly([ix]);
    res.json({ sig });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Создание шаблона квеста
r.post("/quest/init", requireAdmin, async (req, res) => {
  try {
    const questId = Number(req.body.questId);
    const rewardPotato = new BN(req.body.rewardPotato);

    const [questConfig] = questConfigPda();
    const [questTemplate] = questTemplatePda(questId);

    const ix = await (questsProgram.methods as any)
      .questInit(questId, rewardPotato)
      .accounts({
        questConfig,
        questTemplate,
        authority: AUTHORITY_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const sig = await authorityOnly([ix]);
    res.json({ sig });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Клейм награды за выполненный квест
r.post("/quest/claim", requireCircuitOpen, requireWalletLimits("quests_claim"), requireNoFraudHold("user", "quest_claim"), requireIdempotency, async (req, res) => {
  try {
    const user = pk(req.body.user);
    const questId = Number(req.body.questId);

    const [questConfig] = questConfigPda();
    const [questTemplate] = questTemplatePda(questId);
    const [questProgress] = questProgressPda(user, questId);

    // Читаем конфиг чтобы взять адреса казны и минта
    const config: any = await (questsProgram.account as any)["questConfig"].fetch(questConfig);
    const userMascot = getAssociatedTokenAddressSync(config.mascotMint, user);

    const ix = await (questsProgram.methods as any)
      .questClaimReward(questId)
      .accounts({
        questConfig,
        questTemplate,
        questProgress,
        user,
        authority: AUTHORITY_PUBKEY,
        treasuryMascot: config.treasuryMascot,
        userMascot,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const tx = await coSign([ix], user);
    res.json({ tx });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Disabled until the contract verifies achievement criteria instead of accepting
// an arbitrary self-attested id. The on-chain instruction is fail-closed too.
r.post("/achievement/unlock", requireCircuitOpen, requireWalletLimits("quests_achievement"), (_req, res) => {
  res.status(503).json({
    error: "ACHIEVEMENT_UNLOCK_DISABLED_UNTIL_CRITERIA_VERIFIED",
  });
});

/*
r.post("/achievement/unlock", requireCircuitOpen, requireWalletLimits("quests_achievement"), async (req, res) => {
  try {
    const user = pk(req.body.user);
    const achievementId = Number(req.body.achievementId);

    const [questConfig] = questConfigPda();
    const [achievementRecord] = achievementRecordPda(user, achievementId);

    const ix = await (questsProgram.methods as any)
      .achievementUnlock(achievementId)
      .accounts({
        questConfig,
        achievementRecord,
        user,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx = await coSign([ix], user);
    res.json({ tx });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
*/

// Daily quests, progress and achievement state are not currently indexed from
// the quests program. Do not return template/demo rows with zero progress as
// if they were live user state.
r.get("/daily/:user", (_req, res) => {
  res.status(503).json({
    error: "QUEST_PROGRESS_UNAVAILABLE_UNTIL_CANONICAL_INDEXING_IS_DEPLOYED",
  });
});

// Active quests and achievements require the same canonical progress index.
r.get("/list/:user", (_req, res) => {
  res.status(503).json({
    error: "QUEST_PROGRESS_UNAVAILABLE_UNTIL_CANONICAL_INDEXING_IS_DEPLOYED",
  });
});

r.get("/achievements/:user", (_req, res) => {
  res.status(503).json({
    error: "ACHIEVEMENT_STATE_UNAVAILABLE_UNTIL_CANONICAL_INDEXING_IS_DEPLOYED",
  });
});

export default r;
