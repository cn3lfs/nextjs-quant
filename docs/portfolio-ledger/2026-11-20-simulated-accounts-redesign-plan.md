# 多账户本地模拟交易重构方案（已确认决策版）

**日期**　2026-11-20  
**状态**　架构规划完成，用户已拍板 4 项核心决策，待排期进入实施 Wave  
**说明**　由只读架构 Agent（`codex-astra`）基于仓库源码核对产出，并已按用户最终决策更新决策区。

## 用户已确认的 4 项最终决策

| 决策项                     | 用户最终决定                                                                                                                                                   |
| :------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 历史写死模拟账户        | **去掉写死的 5 个 `r2a-*` 自动模拟账户代码**（测试除外），仅支持用户手动创建；通过预演清单确认后彻底清理旧历史模拟账户（保留真实交割、真实手工账本与凭证）。   |
| 2. 模拟成交模式            | 先建立并选定某个模拟账户，再支持**直接选户手动成交**，以及**按交易计划手动成交 / 自动模拟成交**（严格绑定所选账户并执行对应市场规则）。                        |
| 3. 模拟账户生命周期与 CRUD | 清掉旧户，支持用户完整**创建 / 改名 / 充值（入金与出金）/ 删除 / 查看账户独立持仓、资金流水与交易明细**，优先显示中文名。                                      |
| 4. 默认账户                | 首次进入且尚无模拟账户时，**默认提供一个 100 万 CNY 的中文名 A 股模拟账户**（如「A股默认模拟账户」），可随时改名、充值、删除或新增其他 A 股/数字货币模拟账户。 |

---

## 1. 现状诊断与痛点

| 对象             | 当前行为与影响                                                                                                                                                                                                               | 源码依据                                                                                                                                                                      |
| :--------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paper_accounts` | 存储策略前推账户。模型包含市场、币种、本金、冻结候选、镜像和推进版本，没有用户账户名称。`paper_state` 保存执行检查点，`paper_facts` 已按账户记录订单、成交、持仓和权益。手工交易若直接插入这些表，会与策略重放产生两套事实。 | `src/server/db/migrations.ts:142`、`:146`、`:148`；`src/server/paper/model.ts:49`、`:93`；`src/server/paper/advance.ts:735`、`:768`                                           |
| 本地模拟盘界面   | `tab=paper` 挂载 `PaperAccountsPanel`。卡片去掉 `paper:` 后直接显示 ID，设置和前推状态也直接显示 ID。                                                                                                                        | `src/components/portfolio/account-workspace.tsx:17`；`src/components/portfolio/paper-accounts-panel.tsx:227`、`:264`；`src/components/portfolio/paper-settings-panel.tsx:158` |
| `trade_mock`     | 当前迁移没有名为 `trade_mock` 的表，该功能是**同花顺外部模拟盘**（经 `records` 保存配置/预览、DPAPI 保存账户身份）。                                                                                                         | `src/server/db/migrations.ts:53`；`src/server/portfolio/mock/mock-trading-service.ts:15`；`src/components/portfolio/trade-mock-panel.tsx:286`                                 |
| `trade_ledger`   | 真实手工补录使用无 `account_id` 的既有账本。绝不能把旧手工记录混入或回填给模拟账户。                                                                                                                                         | `src/server/db/migrations.ts:76`；`src/server/db/trade-ledger-store.ts:19`；`src/app/accounts/actions.ts:21`                                                                  |
| 券商交割与现金   | `import_batches`、`trade_fills`、`cash_flows` 以券商账户归属，继续与模拟域完全隔离。                                                                                                                                         | `src/server/db/migrations.ts:90`、`:95`、`:101`；`src/server/api/routers/portfolio-ledger.ts:63`                                                                              |

### 五个旧写死候选账户如何复现（复活路径）

1. Node 运行时 `startRuntime()` 启动即执行并每 60 秒触发 `paper-tick` → `executePaperTick()`（`src/server/runtime.ts:29`、`:61`、`:79`、`:90`；`src/server/jobs/worker.ts:112`）。
2. `executePaperTick()` 每次都先调用 `registerPaperCandidates()`（`src/server/paper/service.ts:15`），以 `src/server/data/paper-candidates.json` 的 5 个冻结候选重建 `paper_accounts`。
3. 设置页“登记”、手动“推进”、切换分组（`regroupEmptyAccounts()`）及 `scripts/register-paper-candidates.ts` 也会重新创建这 5 个账户。

必须先移除上述自动播种路径，再经 `--dry-run` 预演并清理旧户，否则重启后旧户会再次复活。

---

## 2. 目标领域模型与隔离边界

| 账户域                   | 身份与事实所有者                                                                                                                                                        | 允许的写入                                                                                                                                                |
| :----------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用户本地模拟 `local-sim` | `sim_accounts.id`（不可变 UUID）、中文 `name`、固定 `market`（`cn-equity`/`crypto`）、`currency`（`CNY`/`USDT`）、`initial_capital_atoms`、`status`、`revision`、时间戳 | 开户（首次自动提供 100 万 CNY 默认户，支持手动新增）、改名、充值/出金、按账户手工模拟成交、按交易计划绑定账户手动/自动模拟成交、删除（软/硬删按确认策略） |
| 真实账户 `real`          | 券商交割单、券商现金流、真实手工账本                                                                                                                                    | 现有真实导入、补录与对账，绝不混入模拟资金或模拟成交                                                                                                      |
| 外部模拟场所             | 同花顺模拟、币安/OKX/Bybit 模拟场所                                                                                                                                     | 各自独立场所预览/确认或已授权机器人                                                                                                                       |

**分户隔离原则**：每个本地模拟账户的**可用资金、资金流水、持仓与可卖量、订单与成交明细、分页与导出**均强制绑定 `accountId`。CNY（A 股）与 USDT（数字货币）严格分账。

---

## 3. SQLite v21 迁移设计

在 `src/server/db/migrations.ts` 追加 v21（`STRICT` 表 + 外键 `ON DELETE RESTRICT`；绝不降低 `user_version`）：

- `sim_accounts`：`id, name, kind, market, currency, initial_capital_atoms, status, revision, created_at, updated_at, archived_at, is_default`
- `sim_orders`：`(account_id, id)` 复合主键，含 `client_request_id` 幂等键、`plan_id?`（可选关联交易计划）、`execution_mode`（`manual` / `plan-manual` / `plan-auto`）、`symbol, side, quantity_atoms, price_atoms, trade_date, confirmed_at, rules_json`
- `sim_fills`：`(account_id, id)` 复合主键，复合 FK `(account_id, order_id) -> sim_orders`，记录成交价、数量、成交额、佣金、印花税、滑点与 `trade_date`
- `sim_cash_flows`：`(account_id, id)` 复合主键，复合 FK `(account_id, fill_id) -> sim_fills`，类型包含 `opening` / `deposit` / `withdrawal` / `settlement`
- `paper_cleanup_receipts`：记录旧历史模拟账户清理的 `manifest_hash`、前后计数与备份摘要

**单位与精度**：CNY 按分（整数）、USDT 按 `10⁻⁸`（整数定点数 / `BigInt`），API 用十进制字符串传输。现金 = 本户流水之和；持仓 = 本户成交按单调次序重放（避免独立可编辑余额/持仓表产生双份真相）。

---

## 4. 下单选账户、计划成交与业务规则

1. **所有模拟下单入口必选账户**：
   - 全局入口打开下单表单时，按标的自动过滤出市场/币种兼容的活跃模拟账户；从具体账户卡片发起时带入该账户，最终确认按钮明确显示「确认买入/卖出到〈中文账户名〉」。
   - 切换账户/标的/方向/数量/价格时清空旧预览，绝不静默回落到不兼容账户。
2. **交易计划绑定模拟账户（手动/自动模拟成交）**：
   - 交易计划可显式关联目标模拟账户，并设置执行方式：**手动确认模拟成交**（到价提醒后人工点击成交）或**自动模拟成交**（仅对本地模拟账户生效，满足触发条件且资金/可卖量校验通过时在 `BEGIN IMMEDIATE` 事务中按冻结规则记入该模拟账户，**绝不触碰真实券商下单**）。
3. **撮合与守恒口径**：
   - A 股：100 股整手、严格 T+1（当日买入当日可卖量为 0，下一交易日解锁）、佣金 3 bp（最低 5 元）+ 卖出印花税 5 bp + 滑点 5 bp。
   - 数字货币现货：支持 BTCUSDT/ETHUSDT，T+0，校验 tick/step 与最小名义金额，无卖空/杠杆。
   - 账户守恒：现金不得为负，卖出不得超过本户可卖量，两窗口并发抢余额时仅一笔成功。

---

## 5. 历史模拟账户清理方案

1. **切断复活路径**：移除 `executePaperTick()` 中的自动 `registerPaperCandidates()`，停用 UI/CLI 无参批量播种，仅保留测试夹具显式调用。
2. **安全可审计清理脚本（`scripts/legacy-paper-cleanup.ts`）**：
   - 默认 `--dry-run`（独立只读 SQLite 连接），逐户列出精确 `account_id`、`paper_state`/`paper_facts` 行数、关联记录以及受保护真实账本摘要。
   - 经用户核对确认后，执行 `--apply purge`（前先创建并验证完整一致备份）彻底删除历史 `r2a-*` 模拟账户记录并写入 `paper_cleanup_receipts`。
   - **`--apply purge` 必须携带 `--manifest-hash <sha256>`**：该哈希来自用户已复核的那次 `--dry-run` 输出的清单（对规范化后的清单内容取 SHA-256，含库文件标识、账户 `account_id` 集合与各表行数）。`--apply purge` 在删除任何数据前重新生成实时清单并比对哈希；目标账户集合发生任何漂移（新增/消失账户、行数变化、库文件或路径不同）、哈希缺失或格式非法时一律拒绝执行并以非零码退出，不提供 `--force`/跳过开关。
   - 严禁触碰 `import_batches`、`trade_fills`、`cash_flows`、`trade_ledger`、DPAPI 凭证与新 `sim_*` 表。

---

## 6. 界面架构（`持仓复盘 / 本地模拟盘`）

- 顶部账户列表卡片（中文名、市场/币种、可用资金、持仓市值、总权益）+「新建模拟账户」按钮。
- 首次进入且本地模拟账户为空时，自动初始化 1 个 **100 万 CNY** 的「A股默认模拟账户」（用户可改名、充值/出金、删除或新增更多 A 股/数字货币模拟账户）。
- 单户详情工作区：
  - 账户操作栏：**模拟下单（买入/卖出）**、**充值/出金**、**重命名**、**删除账户**（二次确认，提示将清除该模拟户数据且不影响其他账户与真实账本）。
  - 三个独立页签：**持仓**（总量、可卖量、成本、市值、快捷卖出）、**资金流水**（期初、出入金、成交净结算）、**交易明细**（订单、成交价、费用、来源标注手动/计划手动/计划自动）。
- 统一持仓与今日页同步增加 `local-sim` 来源筛选，与真实账户保持严格边界。

---

## 7. 分阶段多 Agent 实施计划（后续 Wave 5）

| 阶段 / Agent                | 职责与文件边界                                                                                                      | 关键验收                                                                                       |
| :-------------------------- | :------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------- |
| **5A · `codex-astra`**      | SQLite v21 迁移、`sim-accounts` 领域引擎、100 万默认户初始化、幂等与 T+1/整手/费率校验、`sim-account-repository.ts` | 同标的双户隔离、并发抢余额、手算例、v20→v21 隔离库迁移测试                                     |
| **5B · `claude-deepseek`**  | 切断 `paper-candidates.json` 自动播种、`scripts/legacy-paper-cleanup.ts`（`--dry-run` + `--apply purge`）与清理测试 | 重启/tick 不复活、受保护真实数据摘要零变化、混合账户安全阻断                                   |
| **5C · `codex-astra`**      | `src/server/api/routers/sim-accounts.ts`、计划绑定模拟账户手动/自动模拟成交、`account-workspace` 统一读模型接入     | 权限契约测试、计划手动/自动模拟成交不触发任何真实下单                                          |
| **5D · `agy-hydrogen`**     | `sim-accounts-panel.tsx`、`sim-order-form.tsx`（含选户下单与充值/改名/删除）、统一持仓与今日页适配                  | E2E 全链路：默认 100 万户 → 新建第二户 → 选户买入 → 验证两户持仓/资金/明细完全独立 → 充值/删除 |
| **5E · `codex-sol-review`** | 全量只读缺陷审计                                                                                                    | 跨户串账、精度溢出、并发竞态、旧数据保护全面核验                                               |
