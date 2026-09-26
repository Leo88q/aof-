/**
 * Farm-Trader Worker: слушает цены и исполняет правила пользователей.
 * Запуск: npx ts-node services/farm-trader/index.ts
 * Интервал проверки: каждые 5 секунд.
 */
import { PrismaClient } from "@prisma/client";
import { getCurrentPrice, checkRule } from "./ruleEngine";
import { executeTrade, recordExecution } from "./executor";
import { getUserToolForRarity } from "./inventory";

const db = new PrismaClient();
const CHECK_INTERVAL_MS = 5000;

// Последние цены для детекции изменений (предотвращение повторных исполнений)
const lastTriggered: Map<string, number> = new Map();

async function checkAllRules() {
  // Загружаем все активные правила (батчем, не по одному)
  const rules = await db.traderRule.findMany({
    where: { active: true, paused: false },
  });

  if (rules.length === 0) return;

  // Группируем правила по редкости для батч-обработки
  const rulesByRarity = new Map<number, any[]>();
  for (const rule of rules) {
    if (!rule.rarity) continue;
    if (!rulesByRarity.has(rule.rarity)) {
      rulesByRarity.set(rule.rarity, []);
    }
    rulesByRarity.get(rule.rarity)!.push(rule);
  }

  // Для каждой редкости проверяем все правила разом
  for (const [rarity, rarityRules] of rulesByRarity) {
    const price = await getCurrentPrice(rarity);
    if (!price) continue;

    for (const rule of rarityRules) {
      // Проверка что правило уже не срабатывало на этой цене
      const ruleKey = `${rule.id}:${price.priceMascot}`;
      if (lastTriggered.has(ruleKey)) continue;

      if (checkRule(rule, price)) {
        console.log(
          `[farm-trader] Правило ${rule.type} сработало для ${rule.user}: ` +
          `price=${price.priceMascot.toFixed(6)}, threshold=${rule.threshold}`
        );

        // Исполняем в зависимости от типа правила
        let action = "notification";
        if (rule.type === "smart_sell") {
          action = "sell_into_queue";
        } else if (rule.type === "smart_buy") {
          action = "buy";
        }

        // [ФИКС] Передаём редкость — нужна для сборки ончейн инструкции
        const params: any = {
          user: rule.user,
          ruleId: rule.id,
          action,
          rarity,
          price: rule.currency === "sol" ? price.priceSol : price.priceMascot,
        };

        // [ФИКС] Для авто-продажи резолвим минт инструмента из инвентаря юзера
        if (action === "sell_into_queue") {
          const tool = await getUserToolForRarity(rule.user, rarity);
          if (!tool) {
            console.log(
              `[farm-trader] ${rule.user}: нет инструмента редкости ${rarity}, пропуск`
            );
            lastTriggered.set(ruleKey, Date.now());
            continue;
          }
          params.mint = tool.mint;
        }

        const result = await executeTrade(params);
        await recordExecution(params, result);

        lastTriggered.set(ruleKey, Date.now());

        if (result.success) {
          console.log(`[farm-trader] ✅ ${action} исполнен: ${result.signature}`);
        } else {
          console.log(`[farm-trader] ❌ ${action} не исполнен: ${result.error}`);
        }
      }
    }
  }

  // Очистка старых записей (старше часа)
  const cutoff = Date.now() - 3600000;
  for (const [key, ts] of lastTriggered) {
    if (ts < cutoff) lastTriggered.delete(key);
  }
}

async function main() {
  console.log("[farm-trader] Запуск воркера авто-торговли");
  console.log(`[farm-trader] Интервал проверки: ${CHECK_INTERVAL_MS}ms`);
  console.log("[farm-trader] Режим: только симуляция (реальный режим удалён — см. executor.ts)");

  // Периодическая проверка правил
  setInterval(() => {
    checkAllRules().catch((e) => {
      console.error("[farm-trader] Ошибка цикла:", e.message);
    });
  }, CHECK_INTERVAL_MS);
}

main().catch(console.error);
