/**
 * Исполнитель сделок farm-trader — ТОЛЬКО симуляция.
 *
 * [SECURITY_CHECKLIST #47/#65, decision 2026-09-26] The real mode was removed:
 * it signed with a server-held session key that the player had to approve as
 * an SPL delegate on their tool ATA, so a leaked keystore meant stolen NFTs and
 * the delegation never expired. Auto-trading may come back only on top of
 * program-level session permissions (scoped instructions, limits, expiry),
 * never through token delegation to a server key.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

export interface ExecutionParams {
  user: string;
  ruleId: string;
  action: string; // cancel | sell_into_queue | bid | buy
  mint?: string;
  price?: number;
  rarity?: number;
}

// Исполнение сделки
export async function executeTrade(params: ExecutionParams): Promise<{
  success: boolean;
  signature?: string;
  error?: string;
}> {
  // Проверка риск-лимитов по трасту
  const trust = await db.trustScore.findUnique({ where: { user: params.user } });
  const tier = trust?.tier ?? 1;
  const maxSpendPerDay = 0.5 * (tier === 1 ? 1 : tier === 2 ? 2 : tier === 3 ? 4 : tier === 4 ? 8 : 20);

  // Проверка дневного лимита трат для покупок
  if (params.action === "buy" || params.action === "bid") {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const spentToday = await db.traderExecution.aggregate({
      where: {
        user: params.user,
        action: { in: ["buy", "bid"] },
        success: true,
        ts: { gte: todayStart },
      },
      _sum: { price: true },
    });
    const totalSpent = (spentToday._sum.price || 0) + (params.price || 0);
    if (totalSpent > maxSpendPerDay) {
      return {
        success: false,
        error: `Daily spend limit exceeded: ${maxSpendPerDay} SOL`,
      };
    }
  }

  // Simulation only: record what would have been executed.
  console.log(`[farm-trader] SIMULATION: ${params.action} for ${params.user} at ${params.price}`);
  return {
    success: true,
    signature: `SIM_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  };
}

// Запись исполнения в БД
export async function recordExecution(
  params: ExecutionParams,
  result: { success: boolean; signature?: string; error?: string }
) {
  await db.traderExecution.create({
    data: {
      user: params.user,
      ruleId: params.ruleId,
      action: params.action,
      mint: params.mint,
      price: params.price,
      signature: result.signature,
      success: result.success,
      error: result.error,
    },
  });
}
