# Security runbook — запуск и эксплуатация (решения 2026-09-26)

Порядок действий владельца по итогам `SECURITY_ACTIONS_PROPOSALS_2026-09-26.md`. Шаги 1–4 выполняются **до запуска на mainnet** и в указанном порядке.

Адреса программ (из `aof_backend/src/idl/*.json`):

| Программа | ID |
|---|---|
| aof_core | `HtJg3R3Ki938QeSD98djwMgWESboDVEykuyKGtvRamEq` |
| aof_market | `4BhD6spJHdvHQ9mgyaU6AUSLU37oJbTMCDcAXyWhMRVo` |
| aof_liquidity | `Gvbo9wDEW6kCzzhjk3stEcZoVtcScbN8mGv9SNwTUJLv` |
| aof_quests | `4fNKhVw2nErWZBBw9hgWD3Metu1UKbDLdhFGWbCewdLU` |
| aof_rebirth | `4rMWC1h9mt6JTfBsUPYLMCydPED4e31cffmix5nZyuRb` |
| aof_session_keys | `6ZnnyKkv1kUE4AJqi5uwdh5ZX6VFGfbQiwhGSkfqZ9K5` |

## 1. Multisig (Squads v4)

1. Создать в Squads (app.squads.so) два multisig:
   - **Upgrade & Treasury**: 5 участников, порог **3**, time lock **48 ч** (172 800 с);
   - **Admin**: 3 участника, порог **2**, time lock **48 ч**.
2. Требования к участникам:
   - только hardware wallet (Ledger);
   - один человек — один ключ;
   - ключи хранятся на разных устройствах и в разных местах;
   - резервные seed-фразы — офлайн.
3. Записать адреса **vault #0** обоих multisig. Дальше это `<UPGRADE_VAULT>` и `<ADMIN_VAULT>`.

## 2. Роли `aof-core` — пока authority у вас

```text
migrate_config_v2()                                   # сразу после деплоя новой версии
set_roles(operator = <ключ бэкенда>, guardian = <ключ мониторинга>)
```

Бэкенду передаётся **только ключ operator** (шаг 5). Guardian может лишь ставить паузу и замораживать вывод.

## 3. Передача прав

**Upgrade authority** (для каждой из 6 программ):

```bash
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <UPGRADE_VAULT> --skip-new-upgrade-authority-signer-check
solana program show <PROGRAM_ID>   # Authority должен быть <UPGRADE_VAULT>
```

**Admin (`Config.authority`)** — двухшаговая ротация в каждой программе:
1. Текущий authority: `set_pending_authority(<ADMIN_VAULT>)`.
2. В Squads: vault-транзакция с `accept_authority` (подписант — `<ADMIN_VAULT>`), 2 из 3 подписей, исполнение после time lock.
3. Проверить событие `AuthorityChanged` и поле `authority` в конфиге.

Казна `config.treasury` задаётся при `initialize` и потом не меняется. Для mainnet укажите `<UPGRADE_VAULT>` или отдельный казначейский vault 3 из 5.

## 4. Лимиты эмиссии

```bash
npm ci                                             # корень: @solana/web3.js
node scripts/economy/propose-caps.mjs --vault <ADMIN_VAULT> --rpc <RPC_URL> \
  --dau 1000 --days 42 --safety 1.5 --other-daily 100 --out caps-plan.json
```

- Проверить таблицу. Особенно **Circuit**: сезонная награда (уровень L даёт L × 100 Circuit, до 180 600 на премиум-игрока за сезон) превышает весь майнинг этого ресурса. Это продуктовый вопрос.
- `caps-plan.json → squadsMessagesBase58`: три неподписанных сообщения по 9 инструкций `set_supply_cap`. Импортировать их в Squads как vault-транзакции Admin, подписать 2 из 3, исполнить после time lock.
- `IssuanceCap` (награды `mint_resource_once`) и `VaultGuard` (выплаты) задаются по ожидаемому объёму наград с запасом ×2 (`init_issuance_cap`, `init_vault_guard`).
- Каждый сезон пересчитывать и поднимать лимиты через тот же процесс. Мониторинг предупреждает при заполнении лимита на 80%.

## 5. Секреты

**Этап 1 (сейчас):**

```bash
install -d -m 700 secrets
(umask 077; printf '%s' '<base58 ключ operator>' > secrets/authority_secret_key)
(umask 077; openssl rand -base64 32 > secrets/session_keystore_key)
docker compose -f docker-compose.prod.yml -f docker-compose.secrets.yml up -d
```

- Убрать `AUTHORITY_SECRET_KEY` и `SESSION_KEYSTORE_KEY` из `aof_backend/.env`: в production бэкенд откажется стартовать с ключом в переменной окружения.
- Сам `.env` хранить зашифрованным (SOPS + age), в git — только зашифрованную версию.
- Режим `AUTHORITY_MODE=read-only` работает без override `docker-compose.secrets.yml`.

**Этап 2 (до mainnet): HashiCorp Vault Transit.**
- Ключ operator создаётся в Vault (`transit/keys/aof-operator`, тип `ed25519`, не экспортируемый).
- Бэкенд подписывает сообщение транзакции через `transit/sign/aof-operator` и вставляет подпись в транзакцию. Ключа в памяти процесса нет.
- Доступ к Vault — по AppRole с политикой только на `sign` этого ключа. Аудит-лог Vault включён.

## 6. Антифрод

- `FRAUD_HOLD_MIN_SEVERITY=3` (по умолчанию). При открытом fraud-кейсе с такой или большей серьёзностью бэкенд отвечает `423 FRAUD_REVIEW_HOLD` на выплаты (`/tools/pay-out`, `/referral/pay-out`), клейм наград inbox, квестов и сезона.
- Награда не теряется: после `/admin/fraud/cases/:id/resolve` запрос проходит.
- Значение `off` отключает удержание. Только в аварийной ситуации: используйте `emergency_stop` / `set_cashout_frozen`.

## 7. DNS и домен

См. чек-лист в `SECURITY_ACTIONS_PROPOSALS_2026-09-26.md`, раздел 7: DNSSEC, registrar lock, FIDO2 на всех аккаунтах, CAA, мониторинг DNS и CT.

## 8. Аварийные действия

| Ситуация | Действие | Кто |
|---|---|---|
| Утечка ключа operator | `set_roles(новый operator)`, ротация секрета | Admin multisig |
| Эксплойт с выводом средств | `emergency_stop(freeze_cashout = true)` — геймплей продолжается | guardian |
| Критическая ошибка в логике | `emergency_stop(pause_game = true)` → hotfix через upgrade | guardian → Upgrade multisig |
| Снятие заморозки | `set_cashout_frozen(false)` / `set_paused(false)` | Admin multisig |
