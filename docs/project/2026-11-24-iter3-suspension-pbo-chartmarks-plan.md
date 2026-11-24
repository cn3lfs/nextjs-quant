# 下一大迭代（Iteration 3）主实施计划：零 `.env` 打包与底座硬化、停牌证据计分、同族 CSCV PBO、自定义分仓与 K 线买卖点主图闭环

日期：2026-11-24  
基线提交：`master@0d11b5c6`（Iteration 2 Wave 0–3 已提交并完成 `release\win-unpacked\GuanlanQuant.exe` 打包，实证见 [时间留出与四策略组合实证报告](../research-backtest/2026-11-24-holdout-and-multibook.md)）  
调研来源：三路并行只读多 Agent 摸底（`codex-sol` 底座运行时与打包 + `codex-astra` 量化研究与实证核验 + `claude-deepseek` 七工作区产品闭环）  
状态：**已定稿，待下个会话按 Wave 0 → Wave 3 执行**

---

## 1. 阶段目标与已锁定决策

本阶段围绕「**打包零 `.env` 与底座/门禁硬化 → 停牌认证计分、同族 CSCV PBO 与组合归因深化 → 回测买卖点上主图、自定义 2–6 分仓与跨工作区完整闭环**」推进，已锁定以下五项核心决策：

1. **原生缠论两步走（已定稿）**：Wave 1 先完成 v2 上 `CH14+ZD` 的「初始 ZD 无效拒单 vs 提前止损」分解及单一预登记 `ZD − k×ATR` 缓冲消融；同步实现 v3 投影（`CH04` 二三买重合、`CH07` 区间套、`CH12` `0/1100` 高级背驰段内低级买点）并在两股固定窗口做逐前缀对拍与冷/暖耗时实测，实测可控后再决定后续扩池。
2. **归档库只读管理边界（已定稿）**：本轮仅实现归档 Markdown 导出（复用 `report.ts`）、全量 JSON 导出（暴露 `allCells`）与「用相同参数复跑」（未记录旧字段明示「未记录，需重填」）；**本轮不做任何归档删除或回收目录操作**，保留零不可逆副作用边界。
3. **正式包第一档瘦身与安全发布（已定稿）**：阻断 Next.js 复制的 152 B `.env` 进入 `.next/standalone` 与正式包 `resources/server`；`pack-desktop.ps1` 改旧包同卷暂存、移动失败自动恢复；裁剪 hashed `better-sqlite3` 非 Windows x64 prebuild 与源码（约省 24 MiB）；Electron locales 暂保持不动。
4. **`core-30-v1` 分层池边界（已定稿）**：基于只读 `E:/new_tdx64` 本地 30 个一级行业 + 不晚于开发段起点的 `GP16` 市值确定性抽样冻结 `core-30-v1`（保留 `core-12` 原样回归并公布重叠数与幸存者偏差披露）；先限 CLI 具名池（`--pool core-30-v1`），UI 手选与批量带入继续维持 12 股上限。
5. **SQLite 全程零迁移（已定稿，保持 `user_version = 23`）**：Lab 新归档写轻量 `summary.json` sidecar 供列表免读完整详情，`archive-history` 常规分页跳过非必须全表总数，`pendingOutcomes` 改为基于现有 `watch_events_bar` 索引的有界游标批次；不升 v24。

---

## 2. 多 Agent Wave 实施蓝图

编排规范遵循全局 `multi-agent-commander` 与本仓 `.agents/fleet.profile.json`：当前会话作为指挥官；核心引擎/并发/契约派 `codex-astra`（`gpt-6.2-astra:high`）；日常并行与测试派 `codex-sol`（`gpt-6.2-sol:high`）与 `claude-deepseek`（本机默认模型与思考强度，禁传 `--model`/`--effort`、禁设 `ANTHROPIC_MODEL`、显式 `--permission-mode bypassPermissions`）；每波自动链式 `codex-sol-review`（`gpt-6.2-sol:high` 只读评审）。默认降级严格限定 GPT ↔ Claude，不自动消耗 Gemini 额度。

### Wave 0 · 底座硬化：零 `.env` 打包与回滚、门禁去重、CZSC 跨进程取消、SQLite 零迁移提速与桌面生命周期冒烟

**目标**：堵住 `.env` 打包泄露与替换无回滚缺陷；打通门禁单次构建复用与 7 子包 `fsModuleCache`；闭合 CZSC 跨进程 250ms 取消窗口与服务 `code 0` 意外退出缺口；零迁移压降 SQLite / Lab 归档列表热点；补齐桌面托盘/重启/包内原生冒烟。

| Task ID | 引擎 | 职责与改造要点 | 独占文件边界 (`owns[]`) |
| :--- | :--- | :--- | :--- |
| `w0-gate-pack` | `codex-sol` | 1. **零 `.env` 打包与回滚**：在 `electron-builder.yml`、`scripts/prepare-desktop.mjs`、`scripts/pack-desktop.ps1` 阻断 `.env*` 进入 standalone/正式包并加暂存校验；`pack-desktop.ps1` 旧包同卷暂存、移动失败自动恢复；裁剪非 Windows x64 `better-sqlite3` prebuild/源码（约 -24 MiB）。<br/>2. **门禁去重与子包提速**：修复 `vitest.config.ts:3` 无扩展名导入警告；为 7 个 `packages/*/vitest.config.ts` 开启 `fsModuleCache: true`；`scripts/lib/local-check.mjs` 在 `check` 内复用本轮已成功的 `packages:build` / `runtime:build`（保留独立 `pnpm test`/`typecheck` 自备依赖）；`scripts/build-runtime.mjs` 增内容指纹跳过未变动的 Koffi/DLL 复制与 esbuild；`playwright.config.ts` 消除 `chart-shared-drawings.spec.ts` 在 `p1` 与 `workbench` 的重复归属。 | `package.json`<br/>`tsconfig.json`<br/>`vitest.config.ts`<br/>`packages/*/vitest.config.ts`<br/>`playwright.config.ts`<br/>`next.config.js`<br/>`electron-builder.yml`<br/>`scripts/check.mjs`<br/>`scripts/lib/local-check.mjs`<br/>`scripts/lib/test-projects.ts`<br/>`scripts/build-runtime.mjs`<br/>`scripts/prepare-desktop.mjs`<br/>`scripts/pack-desktop.ps1`<br/>`tests/desktop-build/standalone-trace.test.ts`<br/>`tests/engineering-validation/local-check.test.ts` |
| `w0-worker-db-hardening` | `codex-astra` | 1. **CZSC 跨进程取消 + 遥测与恢复**：`src/server/db/jobs.ts` 增按主键轻量状态查询（不解析整条 JSON）；`czsc.ts:146` 与 `jobs.ts:296` 在真正出队、`child.send` 前复查持久化 `running` 状态，确保跨进程取消 0 新增 DLL 调用；`czsc.ts` 增单次 IPC 超时保护、子进程空闲 TTL 与排队/DLL 耗时/RSS 遥测；将 `strategy-center-native.ts:124` 的前缀进度限频接通到 `grouped-run.ts`；在 `runtime.ts` 启动恢复中核对 FS rename 后 SQLite commit 前硬退出留下的孤儿归档。<br/>2. **SQLite 零迁移提速（保持 `user_version = 23`）**：Lab 新归档同事务写入轻量 `summary.json` sidecar 供 `listDiagnoseArchives` 免读完整详情（旧归档回退兼容）；`archive-history.ts` 常规分页跳过非必须全表总数；`alert-repository.ts:400` / `outcomes.ts` 将 `pendingOutcomes` 改为基于现有 `watch_events_bar` 索引的有界游标批次。 | `src/server/db/jobs.ts`<br/>`src/server/jobs/jobs.ts`<br/>`src/server/jobs/worker.ts`<br/>`src/server/strategies/chan/czsc.ts`<br/>`src/server/strategies/strategy-center-native.ts`<br/>`src/server/research/diagnose/grouped-run.ts`<br/>`src/server/research/diagnose/archive.ts`<br/>`src/server/api/routers/strategy-lab.ts`<br/>`src/server/runtime.ts`<br/>`src/server/db/archive-history.ts`<br/>`src/server/db/alert-repository.ts`<br/>`src/server/alerts/outcomes.ts`<br/>`tests/research-backtest/diagnose/worker-isolation.test.ts`<br/>`tests/engineering-validation/sqlite-hotspot-zero-migration.test.ts` |
| `w0-desktop-lifecycle` | `codex-sol` | `dependsOn: ["w0-gate-pack", "w0-worker-db-hardening"]`：修复 `electron/main.ts:412` 服务 `running` 态意外以 `code 0` 退出不切失败页缺陷；扩展 `scripts/desktop-smoke.mjs` 增加 `--lifecycle-smoke`（隔离 profile 覆盖关窗进托盘/恢复/意外退出重启/重启后任务恢复与零残留子进程）及 `--diagnose-smoke --packaged` 补齐包内 CZSC v22 真实代理探测与 THSDK 默认禁用拒绝路径。 | `electron/**`<br/>`src/app/api/shutdown/route.ts`<br/>`scripts/desktop-smoke.mjs`<br/>`scripts/lib/desktop-smoke-result.mjs`<br/>`tests/desktop-build/desktop-startup.test.ts`<br/>`tests/desktop-build/desktop-smoke-result.test.ts` |
| `w0-review` | `codex-sol-review` | `dependsOn: ["w0-desktop-lifecycle"]`，审计 `.env` 零渗漏、打包回滚、跨进程取消 0 新增 DLL 调用、SQLite `user_version = 23` 零迁移、`src/server/mcp.ts` 未触碰。 | 只读 (`--uncommitted`) |

**Wave 0 验收门槛**：
- `.next/standalone` 与 `release\win-unpacked\resources\server` 均 **0 `.env*` 文件**，`pack-desktop.ps1` 故障注入可恢复旧包。
- 确定性双连接测试验证跨进程取消排队 CZSC 请求时第二次 DLL 调用数 = **0**；硬退出孤儿归档可被启动恢复识别。
- `pnpm check` 内部 `packages:build` / `runtime:build` 仅执行一次，7 子包 Vitest 开启 `fsModuleCache: true`，无 Vite 无扩展名配置告警。

---

### Wave 1 · 量化核心：停牌证据计分、同族 CSCV PBO、`core-30-v1` 分层池、剔除划转分仓归因与缠论消融/v3 探针

**目标**：让 `sh688981` 等有交易所/GP29 证据的合法停牌日能正常计分（同时保持真实缺数整段失效含 Calmar）；跑通 CH14 同族多候选 CSCV `PBO(Sharpe)`；冻结可重建 `core-30-v1` 分层池；修复内部现金划转对分仓收益/相关性的污染并输出交易级归因；完成 `CH14+ZD` 拒单/止损分解、`ZD − k×ATR` 缓冲消融及缠论 v3（`CH04`/`CH07`/`CH12`）两股固定窗口对拍。

| Task ID | 引擎 | 职责与改造要点 | 独占文件边界 (`owns[]`) |
| :--- | :--- | :--- | :--- |
| `w1-suspension-scoring` | `codex-astra` | **最高优先**：<br/>1. 新增 `session-evidence.ts`：复用 `tstdx` `financial-series.ts` 解析 `GP29`（停牌交易日数，带文件哈希、字节偏移、`effectiveDate`、`knownAt`）及显式停牌公告事实；严格区分「事后认证的历史合法停牌日（仅当与开市日历、连续缺槽、复牌 bar 三重一致，且绝不回改历史排名/挂单/成交，复牌前截断前缀仍为 `unknown`）」与「真实缺 bar / 损坏 / 冲突 / 缺失 PIT（继续严格 fail-closed 置 `null`）」。<br/>2. 扩展 `quant-backtest` `types.ts` / `close-signals.ts`：区分 `suspended` 与 `unknown` 计数（分别披露证券停牌日数与组合受影响日数，不把 4 分仓×6 天虚报为 24 天）；停牌日已有持仓沿用最近真实估值、公司行动照常、无信号/不触发保护/不成交，复牌日一次计入真实跳变。<br/>3. 更新 `lifecycle-score.ts`：允许已认证停牌日继续计分，真实 `unknown` 仍将整段指标（含 Calmar，修补旧评分透传漏口）置为 `null`。 | `src/server/research/diagnose/session-evidence.ts`（新）<br/>`packages/quant-backtest/src/portfolio/types.ts`<br/>`packages/quant-backtest/src/portfolio/close-signals.ts`<br/>`src/server/research/lifecycle-score.ts`<br/>`tests/research-backtest/diagnose/suspension-scoring.test.ts`（新） |
| `w1-family-pbo-universe` | `codex-astra` | 1. **同族多候选 CSCV PBO**：扩展 `time-holdout.ts` / `validation-method.ts` / `validation-suite.ts` 接受同族候选数组与共同开发段日轴（保留单候选兼容），PBO 严格仅用切点前、同期、完整的 base OOS 日收益（成本/延迟腿与 `hold` 不计独立试验）；显式输出原始候选数、排除原因、聚类成员、$N_{\mathrm{eff}}$、并清晰标注 `PBO(Sharpe)` 与滚动选优口径差异；修改留出段价格不得改变开发段 PBO/DSR/$N_{\mathrm{eff}}$。<br/>2. **本地具名分层池 `core-30-v1`**：新建 `universe-strata.ts` + 扩展 `universe-presets.ts`，基于 `E:/new_tdx64` `.day` × `tdxhy.cfg`/`tdxzs3.cfg`（30 个本地一级行业）+ 不晚于开发段起点的 `GP16` 总市值，按固定种子与代码哈希确定性抽样冻结 30 股（不读策略成绩、不悄悄删晚上市股，保留 `core-12` 原样回归并公布重叠数与幸存者偏差披露）。 | `src/server/research/diagnose/time-holdout.ts`<br/>`src/server/research/validation-method.ts`<br/>`packages/quant-backtest/src/validation-suite.ts`<br/>`src/server/research/diagnose/universe-presets.ts`<br/>`src/server/research/diagnose/universe-strata.ts`（新）<br/>`tests/research-backtest/diagnose/family-cscv-pbo.test.ts`（新）<br/>`tests/research-backtest/diagnose/universe-strata.test.ts`（新） |
| `w1-attribution-chan` | `codex-sol` | 1. **剔除划转的分仓投资收益与交易级归因**：更新 `sleeve-attribution.ts` 并新增 `sleeve-trades.ts`，按 $r_{s,t}=(E_{s,t}-F_{s,t})/E_{s,t-1}-1$ 计算剔除内部现金划转的真实分仓日收益与相关性（同时保留账本可加总峰谷回撤贡献 + 剔除划转交易损益贡献）；复用 `quant-performance/src/trades.ts` 输出完整轮次胜率、盈亏比、利润因子、持有期分位数、现金率、单边换手与四项成本分解；在单变量对照下验证月末闲置现金等权归位、60 日因果风险平价（零方差/缺观测保持上次政策，严禁给空仓无限加权）及周频 20/50 日 RPS 中频分仓对照。<br/>2. **缠论两步走**：(a) 拆解 v2 `CH14` vs `CH14+ZD` 的「共同入场提前止损」与「初始 ZD 无效拒单」归因，新增单一预登记 `research-chan-hold-cash-zd-atr`（同尺度信号日前缀 `ZD − k×ATR`）；(b) 实现 v3 投影（`CH04` 二三买重合、`CH07` 区间套、`CH12` `0/1100` 高级背驰段内低级买点），新缓存键含投影版本与级别集合（保留 v1/v2 兼容），先通过两股固定窗口逐前缀对拍与追加未来 bar 不变性测试。 | `src/server/research/diagnose/sleeve-attribution.ts`<br/>`src/server/research/diagnose/sleeve-trades.ts`（新）<br/>`src/server/research/diagnose/chan-native.ts`<br/>`packages/trading-strategies/src/native-study.ts`<br/>`packages/trading-strategies/src/research/chan/research-chan-native.ts`<br/>`tests/research-backtest/diagnose/sleeve-transfer-attribution.test.ts`（新）<br/>`tests/research-backtest/diagnose/chan-v3-projection.test.ts`（新） |
| `w1-wire-cli` | `codex-astra` | `dependsOn: ["w1-suspension-scoring", "w1-family-pbo-universe", "w1-attribution-chan"]`：串行集成 `prepare-request.ts`、`cell.ts`、`run.ts`、`report.ts`、`strategy-specs.ts`、`types.ts`、`scripts/backtest-diagnose.ts`，接线停牌证据加载、`--family` 多候选留出（如 `ch14-exits`）、`--pool core-30-v1`、剔除划转归因报告段、`research-chan-hold-cash-zd-atr` 及 v3 缠论 key（`research-chan-ch04`/`ch07`/`ch12`）。 | `src/server/research/diagnose/types.ts`<br/>`src/server/research/diagnose/strategy-specs.ts`<br/>`src/server/research/diagnose/prepare-request.ts`<br/>`src/server/research/diagnose/cell.ts`<br/>`src/server/research/diagnose/run.ts`<br/>`src/server/research/diagnose/report.ts`<br/>`scripts/backtest-diagnose.ts`<br/>`tests/research-backtest/diagnose/iter3-integration.test.ts`（新） |
| `w1-review` | `codex-sol-review` | `dependsOn: ["w1-wire-cli"]`，重点审计 GP29 事后认证绝不泄漏进历史交易决策、真实缺数仍整段置 `null`（含 Calmar）、CSCV PBO 零留出泄漏、纯划转零行情投资收益为 0、v3 投影因果性与旧策略零篡改。 | 只读 (`--uncommitted`) |

**Wave 1 验收门槛**：
- `sh688981` 6 日停牌正例可产出有限 940 日留出三腿正式指标且 6 日零成交；任删 1 个正常交易日或注入 GP29 冲突/缺失 PIT 仍严格置 `null`（含 Calmar）。
- 手算可验证的 252 组合 CSCV 矩阵 100% 精确对拍；改动留出段价格后开发段 PBO/$N_{\mathrm{eff}}$/DSR 逐项不变。
- 纯现金划转零行情用例两分仓投资收益均为 `0`、组合现金守恒；`core-30-v1` 同快照确定性可重建；v3 两股逐前缀对拍 0 漂移且同键暖跑 **0 新增 DLL build**。

---

### Wave 2 · 产品闭环：回测买卖点上 K 线主图、自定义 2–6 分仓组合、归档导出/复跑、自选/池批量带入与 RPS 全状态还原

**目标**：打通诊断/回测 → K 线主图复盘的最大交互断点；支持 2–6 策略自定义分仓；补齐归档 Markdown/JSON 导出、一键同参数复跑与今日驾驶舱折叠入口；完成自选/股票池批量带入与 RPS 页码/列完整 URL 还原及全链路 Playwright 守护。

| Task ID | 引擎 | 职责与改造要点 | 独占文件边界 (`owns[]`) |
| :--- | :--- | :--- | :--- |
| `w2-contracts` | `codex-astra` | **Stage 1（先锁契约）**：<br/>1. `diagnose-contract.ts`：`book` 升级为可辨识联合 `{ preset: "core-4" } \| { sleeves: [{ id, strategyKey, share }] }`（2–6 腿、`|Σshare - 1| <= 1e-9`、稳定 `custom-<8hash>` 目录 ID）；`summary` 增可选 `run` 块（保留旧档零破坏解析）；`handoffSource` 增 `"watchlist" \| "pool"`；新增停牌/家族 PBO/剔除划转归因可选 schema。<br/>2. 后端只读导出与全量详情：`strategy-lab.ts` / `archive.ts` / `grouped-run.ts` 暴露 `strategyLabDiagnoseExport`（复用 `report.ts` Markdown 生成 + 全量 `allCells` JSON），支持自定义 `book.sleeves` 运行并写入 `summary.run`。 | `src/lib/research/diagnose-contract.ts`<br/>`src/server/research/diagnose/archive.ts`<br/>`src/server/research/diagnose/grouped-run.ts`<br/>`src/server/api/routers/strategy-lab.ts`<br/>`tests/research-backtest/diagnose/service-parity.test.ts` |
| `w2-chart-marks` | `claude-deepseek` | **Stage 2 轨道 A（纯客户端图表闭环 + RPS 还原）**（`dependsOn: ["w2-contracts"]`）：<br/>1. 新增纯函数 `src/lib/chart/chart-trade-marks.ts`（`tradeMarks(scenario, symbol)` 仅日线生效、买 `arrowUp`/卖 `arrowDown`/`trigger==="stop"` 标「止损」，缺日丢弃并披露计数，绝不画伪造止损价格线）。<br/>2. `MarketChart` / `market-chart-base.ts` / `chart-workspace.tsx` 增第 4 个标注开关「回测买卖点」与 `data-testid="chart-trade-marks"` 状态行；支持一次性 `at=<date>` 视口定位（不污染 `rememberChartRange`），在 `market-session.ts` 透传 `at/diagnose/cell/scenario`。<br/>3. `evidence-samples.tsx` 与 `portfolio-result-view.tsx` 成交行新增「看K线」（优先 `useOpenChart()` 原地切图保活归档状态）。<br/>4. `stock-rps-ranking.tsx` 在 URL 中持久化 `rpsCols` 与 `page`（复原时强制包含主周期与排序列，并用 `useAccumulatedPages` 起始页避免逐页回放）。<br/>5. 新增 `tests/e2e/chart-trade-marks.spec.ts` 并补 1 条 RPS URL 刷新还原用例。 | `src/lib/chart/chart-trade-marks.ts`（新）<br/>`src/lib/chart/chart-data.ts`<br/>`src/lib/stores/market-session.ts`<br/>`src/components/market/market-chart-base.ts`<br/>`src/components/market/charts/market-chart.tsx`<br/>`src/components/market/chart-workspace.tsx`<br/>`src/components/market/open-chart.tsx`<br/>`src/components/market/stock-rps-ranking.tsx`<br/>`src/components/research/diagnose/evidence-samples.tsx`<br/>`src/components/portfolio/portfolio-result-view.tsx`<br/>`tests/e2e/chart-trade-marks.spec.ts`（新）<br/>`tests/workbench/chart-trade-marks.test.ts`（新） |
| `w2-lab-custom-batch` | `codex-sol` | **Stage 2 轨道 B（自定义组合 UI + 归档导出复跑 + 自选/池带入 + E2E）**（`dependsOn: ["w2-contracts"]`）：<br/>1. `diagnose-workspace-panel.tsx` / `diagnose-detail-view.tsx` / `time-holdout-card.tsx` / `sleeve-attribution-card.tsx`：新增「自定义组合（2–6 策略）」编辑器与权重和实时校验（本地 localStorage 保存 3–5 套预设，不扩 DB schema）；归档详情支持一键导出 Markdown / 全量 JSON（复用 `useArchiveDownload`）与「用相同参数复跑」（旧归档缺失字段明示「未记录，需重填」）；展示停牌日数、家族 `PBO(Sharpe)` 及剔除划转交易归因。<br/>2. `today-workspace.tsx` 新增**默认折叠**的独立 lazy 查询「最近诊断归档」卡片（严禁并入 30s 轮询主查询）。<br/>3. `screen-candidate-navigation.ts` / `watchlist-view.tsx` / `market-pool-browser.tsx` 复用 `useCandidateBatchSelection` 实现自选股与股票池「批量带入组合诊断 (n/12)」。<br/>4. 扩展 `tests/e2e/lab-diagnose.spec.ts` 补齐自定义组合校验、导出/复跑、`/accounts` 月度复盘 → 组合诊断、单标脏草稿二次确认与混合 URL 保活 E2E。 | `src/components/research/diagnose/diagnose-workspace-panel.tsx`<br/>`src/components/research/diagnose/diagnose-detail-view.tsx`<br/>`src/components/research/diagnose/time-holdout-card.tsx`<br/>`src/components/research/diagnose/sleeve-attribution-card.tsx`<br/>`src/components/research/diagnose/format.ts`<br/>`src/components/workbench/today-workspace.tsx`<br/>`src/lib/screening/screen-candidate-navigation.ts`<br/>`src/components/market/watchlist-view.tsx`<br/>`src/components/market/market-pool-browser.tsx`<br/>`tests/workbench/scan-to-lab-handoff.test.ts`<br/>`tests/e2e/lab-diagnose.spec.ts` |
| `w2-review` | `codex-sol-review` | `dependsOn: ["w2-chart-marks", "w2-lab-custom-batch"]`，审查图表标记仅日线/不写持久化视图、自定义组合与旧档零破坏兼容、`todayWorkspace` 轮询零拖慢、无未授权删除/登记/晋级/下单、`src/server/mcp.ts` 零触碰。 | 只读 (`--uncommitted`) |

**Wave 2 验收门槛**：
- 诊断归档成交行点击「看K线」自动定位成交日并展示「回测买卖点」标记与状态行；切非日线周期自动隐藏；关闭开关消失；返回归档保活无丢失。
- 自定义 2–6 分仓组合可完整运行、归档落盘并一键复跑；旧归档（无 `run` 块）列表/详情/对比 100% 兼容。
- 自选股/股票池 1–12 股批量带入与 RPS 页码/可见列刷新还原全部通过 Playwright E2E；新增 E2E 全绿且不破坏既有视觉基线。

---

### Wave 3 · 真实矩阵实证、全量门禁与打包收尾

1. **只读 `E:/new_tdx64` 真实矩阵实证（隔离 `QUANT_DATA_DIR`，落盘 `docs/research-backtest/2026-11-XX-iter3-suspension-pbo-strata.md`）**：
   - `core-12 × core-4`（带 GP29 停牌认证）：验证 940 日留出三腿正式指标可计分且 6 日停牌零成交、剔除划转分仓交易归因与月末现金归位/60 日风险平价单变量对照。
   - `core-12` CH14 退出家族多候选留出矩阵（276 个开发段滚动 OOS 日）：实测 `PBO(Sharpe)`、$N_{\mathrm{eff}}$、DSR 及 `CH14+ZD` 拒单/止损分解 + `ZD − k×ATR` 缓冲消融。
   - `core-30-v1` 确定性分层池重建与覆盖率/信号漏斗实测（含 SEPA A/B 对照）+ 缠论 v3 两股固定窗口对拍与冷/暖耗时审计；核验 0 残留 `czsc-worker`。
2. **全量工程门禁与独立包验收**：
   - 执行 `pnpm check`（6/6 全绿，复核门禁去重 + 7 子包 `fsModuleCache` 提速）、`pnpm exec playwright test --project workbench tests/e2e/lab-diagnose.spec.ts tests/e2e/chart-trade-marks.spec.ts`、`pnpm desktop:pack`（复核 0 Turbopack 告警、0 `.env` 文件、体积回落 ≥24 MiB）及 `--diagnose-smoke --packaged`、`--lifecycle-smoke --packaged`。
3. **文档与临时产物清理**：
   - 更新 `docs/next-plan.md`；用 `fleet clean --apply` 清理全部 `.test-data/fleet/` 与任务临时目录；汇报完整证据并等待授权提交/推送。

---

## 3. 全程硬约束（不可违背）

- **只读与库隔离**：`E:/new_tdx64` 与外部 Blocks 严格只读；任何触达 SQLite 的命令/测试一律使用 `.test-data/` 下的隔离 `QUANT_DATA_DIR`，绝不打开默认生产库、绝不删库或降 `user_version`（保持 `v23` 零迁移）。
- **单宿主唯一串行 CZSC**：所有 `CZSC64.dll` 调用必须经主线程唯一 `projectCzsc` 队列，严禁工作线程本地 fork 或并行 DLL 池。
- **停牌与研究诚实红线**：严禁凭缺口夹在两根 K 线之间或零量推定历史停牌，严禁前填 OHLCV 或平摊复牌跳变；不将已看过的 2023–2026 历史留出宣称为新鲜 OOS；不修改既有策略阈值，不按留出表现调参或重抽股票。
- **受保护资产与零未授权副作用**：绝不修改 `src/server/mcp.ts` 及用户维护 UI 文案；不自动登记/晋级/改提醒模式、不真实下单、不外发通知、不实现未授权归档删除；提交、推送、正式打包均须明确授权。
- **多 Agent 纪律**：并发写任务 `owns[]` 严格互斥；`claude-deepseek` 不传 `--model`/`--effort`、不设 `ANTHROPIC_MODEL`、显式 `--permission-mode bypassPermissions`；Codex 三引擎显式 `high` 强度；默认降级限定 GPT ↔ Claude，保留 Gemini 额度。
