# 下一大迭代主实施计划：计算隔离、样本外验证、四策略组合闭环与工作台 E2E 守护

日期：2026-11-23  
基线提交：`master@abecc47d`（前阶段 Wave 0–3 已提交并完成 `release\win-unpacked\GuanlanQuant.exe` 打包，实证见 [Wave 1–3 真实数据验证矩阵](../research-backtest/2026-11-23-wave1-theories-matrix.md)）  
调研来源：三路并行只读多 Agent 摸底（`codex-sol` 底座运行时 + `codex-astra` 投资理论与组合研究 + `claude-deepseek` 七工作区产品闭环）  
状态：**已定稿，待下个会话按 Wave 0 → Wave 3 执行**

---

## 1. 阶段目标与已锁定决策

本阶段围绕「**运行时彻底隔离 → 样本外与四策略组合闭环 → 七工作区交接与 E2E 守护**」推进，已锁定以下五项核心决策：

1. **数据库零迁移原则（保持 `user_version = 23`）**：全量能力（Worker 暂存发布、任务摘要写回 `jobs.result`、时间留出归档、双归档对比与批量带入）均不升 schema；Wave 0 对 `pendingOutcomes` / `archive-history` 仅做只读采样，仅当 `EXPLAIN QUERY PLAN` 实证必须建索引时再单独请示。
2. **单宿主串行 CZSC 架构锁**：成组诊断迁入 `runWorker`（`worker_threads` 2 槽池）后，严禁工作线程自行 `fork("runtime/czsc-worker.cjs")`；改为「Worker 发 IPC 消息 → API 主线程经唯一 `projectCzsc` 队列串行转发 → Worker 侧 `isMainThread` 运行时断言」，确保图表与多路诊断共享唯一 DLL 子进程。
3. **原生缠论本轮范围（已定稿）**：仅纳入**零新增 DLL build** 的 `research-chan-hold-cash-zd-stop`（`CH14` + 所属中枢 `ZD` 结构止损，复用现有 v2 共享投影缓存）；需要 v3 投影重捕的 `CH04` 二三买重合与双配置 `CH07/CH12` 留至后续阶段。
4. **时间留出切点与诚实口径（已定稿）**：默认 `holdoutStart = 2023-01-01`（Dev 含 2021–2022 切换，Holdout 覆盖 `2023-01-01 ~ 2026-11-20` 近四年，CLI/UI 可覆写）；因已查阅过 `core-12` 截至 `2026-11-20` 的漏斗，本次留出段显式标注为「**历史留出复核（Historical Holdout Review）**」，新变体不宣称新鲜样本外收益。
5. **跨工作区闭环范围（已定稿）**：Wave 2 纳入 `/accounts` 月度复盘 → 组合诊断预填（去重截断 12 股、非破坏性带入）；暂缓 `/intel` 主题跳转与「诊断直接自动计入 `eligible` 晋级」（保持工程健康与研究有效性分离、严禁自动登记/晋级或改动 `alerts.mode`）。

---

## 2. 多 Agent Wave 实施蓝图

编排规范遵循全局 `multi-agent-commander` 与本仓 `.agents/fleet.profile.json`：当前会话作为指挥官；核心引擎/并发/契约派 `codex-astra`（`gpt-6.2-astra:high`）；日常并行与测试派 `codex-sol`（`gpt-6.2-sol:high`）与 `claude-deepseek`（本机默认模型，禁传 `--model`/`--effort`、禁设 `ANTHROPIC_MODEL`、显式 `--permission-mode bypassPermissions`）；每波自动链式 `codex-sol-review`（`gpt-6.2-sol:high` 只读评审）。默认降级严格限定 GPT ↔ Claude，不自动消耗 Gemini 额度。

### Wave 0 · 底座加固：Turbopack 消警、Worker 队列隔离、任务证据与 Vitest 提速

**目标**：消除 `pnpm build` 的 8 条 Turbopack 动态追踪告警及 `.next/standalone` 中 40.5 MiB 旧 `release/` DLL 误收；将成组诊断迁入 `runWorker` 计算池并接入 `taskEvidence` / `/system/tasks`；开启 Vitest 5 `fsModuleCache` 压降门禁耗时。

| Task ID | 引擎 | 职责与改造要点 | 独占文件边界 (`owns[]`) |
| :--- | :--- | :--- | :--- |
| `w0-turbopack-gate` | `codex-sol` | 1. 在 `cli-archive.ts`（第 57–230、397–425 行等）与 `archive-fs.ts` 的运行期动态路径参数处加 `/*turbopackIgnore: true*/`，保留全部路径穿越/符号链接/读取上限校验；新增 `standalone-trace.test.ts` 验证 `.next/server/instrumentation.js.nft.json` 不含旧 `release/` DLL。<br/>2. 在 `vitest.config.ts` 三项目共享配置显式开启 `fsModuleCache: true`（保持 `heavy=1`、`forks`、隔离与组序不变），记录冷/热/增量对比。<br/>3. 只读采样 `pendingOutcomes` / `archive-history` 查询计划（零迁移，保持 `user_version = 23`）。 | `src/server/research/diagnose/cli-archive.ts`<br/>`src/server/research/diagnose/archive-fs.ts`<br/>`vitest.config.ts`<br/>`tests/desktop-build/standalone-trace.test.ts` |
| `w0-diagnose-worker` | `codex-astra` | 1. `czsc.ts:89-96` 改用两条静态字面量 `runtime/` 路径读 SHA-256 消除告警；`worker()` 增加 `isMainThread` 断言禁止工作线程本地 fork。<br/>2. 在 `jobs.ts` ↔ `worker.ts` 建 `czsc-project` / `czsc-identity` 主线程代理通道，`strategyLabDiagnoseRun` 改走 `runWorker({ type: "lab-diagnose", input, stagingDir }, job.id)`；Worker 写暂存目录并返回轻量摘要回执，主线程在写锁内核对未取消后原子 rename 发布并提交 `completed`，取消/异常待线程退出后清理暂存目录；`archive.ts:220` 加 `/*turbopackIgnore: true*/` 并验证无库时不建 `quant.sqlite`。<br/>3. `task-evidence.ts:49` 与 `task-history.ts:144,165` 白名单纳入 `"lab-diagnose"`，同步 SQL 直接投影摘要，`resultLink` 指向 `/lab/backtest?archive=lab-<jobId>`。 | `src/server/strategies/chan/czsc.ts`<br/>`src/server/jobs/jobs.ts`<br/>`src/server/jobs/worker.ts`<br/>`src/server/research/diagnose/archive.ts`<br/>`src/server/research/diagnose/grouped-run.ts`<br/>`src/server/api/routers/strategy-lab.ts`<br/>`src/server/db/task-evidence.ts`<br/>`src/server/db/task-history.ts`<br/>`tests/research-backtest/diagnose/worker-isolation.test.ts`<br/>`tests/engineering-validation/task-evidence-diagnose.test.ts` |
| `w0-review` | `codex-sol-review` | `dependsOn: ["w0-turbopack-gate", "w0-diagnose-worker"]`，重点审计单宿主 CZSC 串行代理、取消与发布锁竞态、Turbopack 消警与独立包运行期解析、`user_version = 23` 与 `mcp.ts` 未触碰。 | 只读 (`--uncommitted`) |

**Wave 0 验收门槛**：
- `pnpm build` 动态追踪告警归零（0 条），`instrumentation.js.nft.json` 不再包含 `release/` 下 13 个历史 DLL（`.next/standalone` 体积回落 ~40 MiB）。
- 两项成组诊断并发运行且叠加图表缠论请求时，整机仅存在 **1 个** `czsc-worker.cjs` 进程；排队取消、原生请求在途取消与发布竞态均零可见归档且暂存目录已清理；`/system/tasks` 可见 `lab-diagnose` 摘要与深链。
- `fsModuleCache: true` 下热跑根 Vitest 耗时显著下降且 0 隔离回归。

---

### Wave 1 · 样本外时间留出验证 + 四策略账户约束组合 + 具名理论对照

**目标**：修补 `validation-suite.ts` 两处已查实缺陷并将时间留出验证组接入共享诊断；落地跨分仓 10 持仓上限、共享容量池与四策略真实组合；零篡改原规则落地 SEPA A/B、威科夫退出闭环/99→0 拆解及 `CH14 + ZD` 结构止损。

| Task ID | 引擎 | 职责与改造要点 | 独占文件边界 (`owns[]`) |
| :--- | :--- | :--- | :--- |
| `w1-validation-portfolio` | `codex-astra` | 1. **修复 `validation-suite.ts` 两处缺陷**：在 `trading-strategy-core/src/costs.ts` 提取统一 `scaleResearchCosts` 同时翻倍 `sellTaxSchedule.multiplier` 与 `transferSchedule.multiplier`（核验与 `double-cost` 逐分一致）；滚动 OOS 窗严格止于 `holdoutStart` 之前，双成本腿固定从 `base` 派生。<br/>2. **时间留出验证组（`time-holdout.ts`）**：单次冻结输入，输出 Dev 滚动窗 + Holdout（默认 `2023-01-01`）三腿指标、`validationRowReasons`、`assessValidationCandidates`（DSR ≥ 0.95 / PBO / 有效试验数）与历史留出复核声明；在 `portfolio/state.ts:54` 增加显式 `collectDailyDecisionCounts` 开关。<br/>3. **跨分仓 10 持仓上限 + 共享容量 + N 分仓归因**：`quant-backtest` 新增可选 `accountMaxUniqueSymbols`（10）与 `accountMaxSymbolWeight`（10%），同日同票多分仓共享 `bar.amount * maxParticipation` 容量池；`sleeve-attribution.ts` 输出 $\binom{N}{2}$ 对相关性（≥20 重叠日且方差非零）与按组合峰谷日期分解的有符号最大回撤贡献（加总恒等于组合回撤）。 | `packages/trading-strategy-core/src/costs.ts`<br/>`packages/quant-backtest/src/validation-suite.ts`<br/>`packages/quant-backtest/src/portfolio/types.ts`<br/>`packages/quant-backtest/src/portfolio/order-execution.ts`<br/>`packages/quant-backtest/src/portfolio/state.ts`<br/>`packages/quant-backtest/tests/validation-suite.test.ts`<br/>`packages/quant-backtest/tests/account-portfolio-cap.test.ts`<br/>`src/server/research/diagnose/time-holdout.ts`<br/>`src/server/research/diagnose/sleeve-attribution.ts`<br/>`tests/research-backtest/diagnose/time-holdout.test.ts`<br/>`tests/research-backtest/diagnose/multi-sleeve-portfolio.test.ts` |
| `w1-theory-ablation` | `codex-sol` | 1. **SEPA 具名 A/B（原 `research-sepa-pit` 不动）**：新增 `research-sepa-vcp-close-price`（`theory-vcp-close` 入场 + `maxBars: 6`）与 `research-sepa-vcp-close-pit`（唯一增量 strict-PIT SEPA `FN230/232/281`，另供 `research-sepa-vcp-close-pit-strict-finance`），证明 B 严格为 A 子集。<br/>2. **威科夫退出闭环 + 99→0 拆解**：接入 `wy-ut-exit-daily`（全平）、`wy-sow-lpsy-daily`（减剩余 50% 且重试防重复减半）、`wy-ice-exit-daily`（全平）；`wyckoff-funnel.ts` 将 `wy-trend-pullback-daily` 次日拆为四条件独立计数与交集，并增具名敏感性变体 `wy-trend-pullback-confirm-vol10-diagnostic`（1.0×，原策略一字不改）。<br/>3. **原生缠论 `CH14 + ZD` 结构止损**：新增 `research-chan-hold-cash-zd-stop`，把 v2 `center.ZD` 冻结为因果 `external.levels` 接 `exit.stop.kind="structure"`，匹配缓存 **0 新增 DLL build**。 | `packages/trading-strategies/src/study-catalog.ts`<br/>`packages/trading-strategies/src/study-rules.ts`<br/>`src/server/research/diagnose/growth-pit.ts`<br/>`src/server/research/diagnose/wyckoff-funnel.ts`<br/>`src/server/research/diagnose/chan-native.ts`<br/>`tests/research-backtest/diagnose/sepa-vcp-close-ab.test.ts`<br/>`tests/research-backtest/diagnose/wyckoff-exit-closure.test.ts`<br/>`tests/research-backtest/diagnose/chan-zd-stop.test.ts` |
| `w1-wire-diagnose` | `codex-astra` | `dependsOn: ["w1-validation-portfolio", "w1-theory-ablation"]`，扩展 `prepare-request.ts` 支持多策略组合（同票共存 `external.chan` + 多套 `external.signals` + `external.levels`，披露按 `(strategyKey, symbol)` 隔离），接线 `--book core-4`（`CH14` + `research-canslim-pit-ma50` + `theory-vcp-close` + `classic-ibs`，各 25%、10 持仓上限、0.5% 共享容量）、`--holdout-start` 及全部新具名 key。 | `src/server/research/diagnose/types.ts`<br/>`src/server/research/diagnose/strategy-specs.ts`<br/>`src/server/research/diagnose/prepare-request.ts`<br/>`src/server/research/diagnose/cell.ts`<br/>`src/server/research/diagnose/run.ts`<br/>`src/server/research/diagnose/report.ts`<br/>`scripts/backtest-diagnose.ts`<br/>`tests/research-backtest/diagnose/strategy-capability.test.ts` |
| `w1-review` | `codex-sol-review` | `dependsOn: ["w1-wire-diagnose"]`，重点审计 Dev/Holdout 严格零重叠、`transferSchedule` 翻倍一致性、跨分仓 10 持仓与共享容量扣减、LPSY 重试防重复减半、原策略零篡改与 `ZD` 结构止损因果性。 | 只读 (`--uncommitted`) |

**Wave 1 验收门槛**：
- Dev 滚动窗与 `holdoutStart` 零重叠，`suite.doubledCost` 与 `double-cost` 同日同金额费用零差额。
- 账户约束单测通过「已持 9 只两新票争第 10 席」与「两分仓同日买同票共享 0.5% 容量」；四分仓峰谷回撤贡献之和恒等于组合回撤。
- `research-sepa-vcp-close-pit` 严格为 `price` 子集；LPSY 50% 减仓遇 T+1/跌停重试不重复减半；`research-chan-hold-cash-zd-stop` 暖缓存 0 新增 DLL build。

---

### Wave 2 · 工作台闭环、批量组合带入与 Playwright / 桌面端 E2E 守护

**目标**：补齐 `/lab/backtest` 深链、双归档并排对比与时间留出/四分仓视图；落地 `/scan` 三视图批量组合带入与 `/accounts` 月度复盘预填；建立 6 条 Playwright E2E 与确定性桌面诊断冒烟。

| Task ID | 引擎 | 职责与改造要点 | 独占文件边界 (`owns[]`) |
| :--- | :--- | :--- | :--- |
| `w2-ui-contracts` | `codex-astra` | **Stage 1（先锁契约）**：<br/>1. 扩展 `ScanToLabHandoffSchema`（保留单标 `symbol`，新增 `symbols` 1..12 去重 + `scope: "portfolio-diagnose"` + `handoffSource` 增 `"account-review"`）。<br/>2. 扩展 `labDiagnoseRunInputSchema` 与 `DiagnoseArchiveDetail` 支持 `includeHoldout`、`holdoutStart`、`bookPreset: "core-4"`、`timeHoldout`、`sleeveAttribution`。<br/>3. 在 `strategyLabRouter` 新增 `strategyLabDiagnoseCompare`（双归档并排只读查询，复核路径隔离与完成态闸门）。 | `src/lib/research/diagnose-contract.ts`<br/>`src/server/research/diagnose/archive.ts`<br/>`src/server/research/diagnose/grouped-run.ts`<br/>`src/server/api/routers/strategy-lab.ts`<br/>`tests/research-backtest/diagnose/service-parity.test.ts` |
| `w2-lab-views` | `claude-deepseek` | **Stage 2 轨道 A**（`dependsOn: ["w2-ui-contracts"]`）：<br/>1. `LabBacktest` 解析 `?archive=` 深链初始化 `ArchiveBrowser`；`RunForm` 完成后渲染「查看归档 / 在任务中心查看 / 复制归档链接」；`TaskEvidence` 展示 `lab-diagnose` 摘要与直达链接。<br/>2. `ArchiveBrowser` 支持双归档勾选并排对比；`DiagnoseDetailView` 新增「时间留出验证卡（Dev/Holdout/Double-Cost/DSR/PBO）」与「四分仓归因与 6 对相关性矩阵」。<br/>3. `ScanHandoffBanner` & `RunForm` 支持 `portfolio-diagnose`（多标的直达诊断表单，零覆盖保活草稿）；`MonthlyReview` 增加「用当月标的跑组合诊断」（去重截断 12 只）。 | `src/components/research/diagnose/**`<br/>`src/components/research/lab-backtest.tsx`<br/>`src/components/workbench/task-evidence.tsx`<br/>`src/components/accounts/monthly-review.tsx` |
| `w2-scan-batch-e2e` | `codex-sol` | **Stage 2 轨道 B**（`dependsOn: ["w2-ui-contracts"]`）：<br/>1. `/scan` 三视图（`ScreenView`、`PatternScreenPanel`、`StockRpsRanking`）在已确认行闸门内新增勾选列与 `批量带入组合诊断 (n/12)` 按钮（翻页/改条件清空，超 12 禁用提示，RPS 保留完整 `returnTo`）。<br/>2. 新增 `tests/e2e/lab-diagnose.spec.ts`（6 条：正常归档 / `zero-signal` / `blocked` / `missing-files` / 保活草稿零覆盖往返 / 批量 13 股截断去重，基于 `$QUANT_DATA_DIR/diagnose-archives` 秒级磁盘 fixture）。<br/>3. 增强 `scripts/desktop-smoke.mjs` 增加 `--diagnose-smoke` 确定性打包诊断冒烟（自带最小合成 fixture、显式轮询终态替代固定 3s 等待，覆盖无 DB 只读不建库）。 | `src/lib/screening/screen-candidate-navigation.ts`<br/>`src/components/workbench/screen-view.tsx`<br/>`src/components/screening/pattern-screen-panel.tsx`<br/>`src/components/market/stock-rps-ranking.tsx`<br/>`tests/workbench/scan-to-lab-handoff.test.ts`<br/>`tests/e2e/lab-diagnose.spec.ts`<br/>`scripts/desktop-smoke.mjs` |
| `w2-review` | `codex-sol-review` | `dependsOn: ["w2-lab-views", "w2-scan-batch-e2e"]`，审查批量勾选批次一致性、保活草稿零覆盖、深链与双归档对比安全、不自动登记/晋级或改 `alerts.mode`、`mcp.ts` 与用户文案零触碰。 | 只读 (`--uncommitted`) |

**Wave 2 验收门槛**：
- `tests/e2e/lab-diagnose.spec.ts` 6/6 全绿；`/scan` 三视图批量勾选 1–12 股一键直达 `/lab/backtest` 诊断表单且已编辑保活草稿零丢失。
- `/system/tasks` 显示 `lab-diagnose` 结构化摘要，点击直达 `/lab/backtest?archive=lab-<jobId>`；两份归档可并排对比。
- `/accounts` 月度复盘预填组合诊断正常流转，无任何自动登记/晋级/下单副作用。

---

### Wave 3 · 真实矩阵复验、全量门禁与打包收尾

1. **真实数据实证（只读 `E:/new_tdx64`，隔离 `QUANT_DATA_DIR`）**：
   - 运行 `core-12` 时间留出验证（Dev vs `2023-01-01` Holdout + `double-cost` + DSR/PBO）、`--book core-4` 四策略 10 持仓组合、`research-sepa-vcp-close-price/pit` A/B、威科夫退出闭环与 99→0 逐条件统计、`research-chan-hold-cash-zd-stop`（0 新增 DLL build、0 残留 `czsc-worker`），落盘研究记录至 `docs/research-backtest/2026-11-XX-holdout-and-multibook.md`。
2. **完整工程门禁与打包核验**：
   - 执行 `pnpm check`（验证 `fsModuleCache: true` 提速与 6/6 全绿）、`pnpm exec playwright test tests/e2e/lab-diagnose.spec.ts`、`pnpm desktop:pack`（复核 **0 Turbopack 动态追踪告警**、`.next/standalone` 移除 40.5 MiB 误收 DLL）及隔离 `--diagnose-smoke`。
3. **文档与临时产物清理**：
   - 更新 `docs/next-plan.md`；用 `fleet clean --apply` 清理全部 `.test-data/fleet/` 与任务临时目录；汇报完整证据并等待授权提交/推送。

---

## 3. 全程硬约束（不可违背）

- **只读与库隔离**：`E:/new_tdx64` 与外部 Blocks 严格只读；任何触达 SQLite 的命令/测试一律使用 `.test-data/` 下的隔离 `QUANT_DATA_DIR`，绝不打开默认生产库、绝不删库或降 `user_version`（保持 `v23` 零迁移）。
- **单宿主唯一串行 CZSC**：所有 `CZSC64.dll` 调用必须经主线程唯一 `projectCzsc` 队列，严禁工作线程本地 fork 或改为 TS 近似。
- **零规则篡改与诚实口径**：不修改既有 `research-sepa-pit` / `wy-*-daily` 阈值；新对照均用独立具名 key；工程健康、历史留出复核与新鲜样本外前向证据严格分离。
- **受保护资产与零未授权副作用**：绝不修改 `src/server/mcp.ts` 及用户维护 UI 文案；不自动登记/晋级/改提醒模式、不真实下单、不外发通知、不打印凭证；提交、推送、正式打包均须明确授权。
- **多 Agent 纪律**：并发写任务 `owns[]` 严格互斥；`claude-deepseek` 不传 `--model`/`--effort`、不设 `ANTHROPIC_MODEL`、显式 `--permission-mode bypassPermissions`；Codex 三引擎显式 `high` 强度；默认降级限定 GPT ↔ Claude，保留 Gemini 额度。
