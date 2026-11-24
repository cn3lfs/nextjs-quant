# 下一大迭代（Iteration 4）旗舰主实施计划：全市场多因子 Alpha 实验室、ETF 轮动与执行现实引擎、账户风控/实施缺口、`/lab` 研究工作室归一与全天候作战室/Bar Replay

日期：2026-11-24  
基线提交：`master@e8ef49c0`（Iteration 3 Wave 0–3 已提交并完成 `release\win-unpacked\GuanlanQuant.exe` 打包，实证见 [Iteration 3 实证报告](../research-backtest/2026-11-24-iter3-suspension-pbo-strata.md)）  
调研来源：三路并行只读旗舰架构摸底（`iter4-flagship-recon`，基于 `E:/new_tdx64` 实测 5,923 股 `.day` / 6,045 份 `.lc5` / 21 只代表 ETF / 5,631 份 GP16 / 3,311 份 GP29 / 120 个 PIT `gpcw*.dat` 与全仓架构审计）  
状态：**已定稿，待下个会话按 Wave 0 → Wave 4（两里程碑）执行**

---

## 1. 战略主轴与已锁定架构决策

本轮彻底跳出局部修补，围绕「**①盈利策略新赛道探索 → ②贴近实战检验能否真实获利 → ③补齐正常交易体系缺失拼图**」三大主轴推进四大旗舰支柱与底层结构性重构，已锁定以下三项决策：

1. **两里程碑 5 波节奏（已定稿）**：单主计划按 **Wave 0 → Wave 4** 推进，每波交付独立可用的垂直闭环并支持按里程碑阶段提交：
   - **里程碑 1（Wave 0 + Wave 1）**：全市场列式面板 `MarketPanelStore` + 多品种 ETF/风控/执行现实内核 + SQLite `v23 → v24` + 全市场多因子 Alpha 实验室与 A 股多资产/行业 ETF 轮动上线。
   - **里程碑 2（Wave 2 + Wave 3 + Wave 4）**：`/lab` 三引擎归一研究工作室 + 三账实施缺口对账 + A 股全天候作战室与次日调仓计划单 + 全来源 K 线复盘/Bar Replay 盲测 + 全量实证、门禁、E2E 与 v24 桌面正式打包。
2. **SQLite `v23 → v24` 与独立列式缓存（已定稿）**：
   - 允许在隔离应用数据目录新建只读 `E:/new_tdx64` 驱动的二进制列式面板缓存（`MarketPanelStore`，52 B/格、32 日分块，热读 0.3–2s）；
   - SQLite 安全向后兼容升至 **`user_version = 24`**，仅新增两张高内聚物理表：**`factor_composites`** 与 **`rebalance_plans`**（`replay_sessions` 与 `risk_policies` 首版复用归档与策略冻结结构），同步更新 17 个强断言 `v23` 的测试、桌面烟测及正式包版本号（遵循 [roadmap](../roadmap.md)）。
3. **默认风控、择时与零副作用红线（已定稿）**：
   - 账户级 `PortfolioRiskEngine` 首版冻结可配置显式政策：出入金调整单位净值回撤 **≥5% 仓位减半 (`reduced`) / ≥8% 暂停新开仓 (`paused`) / ≤3% 且连 3 个完整交易日恢复**、**总止损敞口上限 5%**（敏感性 4%/6%）、**单行业上限 25%**（对照 30%）、**Wilder ATR(14) 单笔风险 0.5%**（对照 1%）；
   - 市场温度计（0–100 历史曲线）首期只作**展示与仓位参考**，接入策略门控前必须先通过同池同费率「有无择时」实证对照；
   - 全程严守 `E:/new_tdx64` 只读、绝不打开默认生产库、零自动下单、零自动晋级、零归档删除、绝不触碰 `src/server/mcp.ts` 及用户维护文案。

---

## 2. 多 Agent 5-Wave 实施蓝图

编排规范遵循全局 `multi-agent-commander` 与本仓 `.agents/fleet.profile.json`：当前会话作指挥官；核心引擎/并发/契约派 `codex-astra`（`gpt-6.2-astra:high`）；日常并行与测试派 `codex-sol`（`gpt-6.2-sol:high`）与 `claude-deepseek`（本机默认模型与思考强度，禁传 `--model`/`--effort`、禁设 `ANTHROPIC_MODEL`、显式 `--permission-mode bypassPermissions`）；每波自动链式 `codex-sol-review`（`gpt-6.2-sol:high` 只读评审）。

### Wave 0 · 底座大升级：全市场列式面板 + 多品种 ETF / 账户风控 / 执行现实内核 + SQLite v24

| Task ID | 引擎 | 职责与改造要点 | 独占文件边界 (`owns[]`) |
| :--- | :--- | :--- | :--- |
| `w0-market-panel` | `codex-astra` | 建设独立只读研究读侧 `MarketPanelStore`（32 日分块列式矩阵、52 B/格基底：4 定点原价 + 原量 + 成交额 + 因果复权因子 + 换手 + GP16 市值 + 30 行业码 + GP29/状态位，另存有效位图与稀疏 PIT 财务/公司行动事件表）；支持不可变 `open(snapshotId)`、内容核验刷新与单写者原子发布；5,224×2,500 基底约 648 MiB、单 `Float32` 因子 ~50 MiB、热读 0.3–2s；受控放开本地研究读侧对场内 ETF `.day`/`.lc5` 的读取。 | `src/server/market/market-panel/**`（新）<br/>`packages/tstdx/src/local/quotes.ts`<br/>`src/server/market/bar-store/local-source.ts`<br/>`tests/market-data/market-panel.test.ts`（新） |
| `w0-etf-risk-core` | `codex-astra` | 1. **多品种按证券×交易日规则**：统一解析股票/ETF 的价格档位（0.01/0.001）、申报单位（100/科创 200+1/北交所/ETF 100 份）、费用（ETF 免印花税、2015 过户费与 2023 印花税变更）与可售周期（股票 ETF T+1、债券/黄金/合资格跨境 ETF T+0）。<br/>2. **统一账户级风控内核 `PortfolioRiskEngine`**：在 `quant-execution` 新增纯 TS `portfolio-risk.ts`（`evaluate` + `sizeEntry`）并接入 `quant-backtest`（5%/8% 回撤熔断与 3 日恢复、5% 总止损敞口、25% 行业上限、Wilder ATR(14) 0.5%/1% 定仓）。<br/>3. **Execution Reality Engine**：冻结同一目标流实测 ①**人工执行窗口**（开盘 vs 09:35–09:40 / 09:45–09:50 / 10:00–10:05 及 09:35–10:05 分批，严格校验 `.lc5` 结束时间戳与非估算量凭据）；②**ADV20 动态冲击滑点 + 高开拒追上限**；③**10 万 / 30 万 / 100 万个人本金整手拖累矩阵**；④**2015 / 2018 / 2022–24 / 2024.09 四大危机连续净值切片**。 | `packages/quant-execution/src/portfolio-risk.ts`（新）<br/>`packages/quant-execution/src/index.ts`<br/>`packages/trading-strategy-core/src/costs.ts`<br/>`packages/quant-backtest/src/portfolio/{types,state,run,equity,close-targets,market-open,order-execution}.ts`<br/>`packages/quant-backtest/src/portfolio-sizing.ts`<br/>`src/server/research/execution-reality/**`（新）<br/>`tests/research-backtest/{execution-reality,portfolio-risk-engine}.test.ts`（新） |
| `w0-sqlite-v24` | `codex-sol` | SQLite 安全向后兼容升至 `v24`：新增 `factor_composites` 与 `rebalance_plans` 物理表及类型仓储；同步更新 17 个强断言 `user_version === 23` 的测试（`strategy-migration.test.ts` 未来库改 `25`）、`scripts/desktop-smoke.mjs`、`scripts/lib/desktop-smoke-result.mjs` 及 `package.json` 桌面版本号；补充 `v23 → v24` 升级、重复打开、DDL 失败回滚与拒开 `v25` 完整测试。 | `src/server/db/{schema,migrations}.ts`<br/>`src/server/db/{factor-composite-repository,rebalance-plan-repository}.ts`（新）<br/>`package.json`<br/>`scripts/desktop-smoke.mjs`<br/>`scripts/lib/desktop-smoke-result.mjs`<br/>`tests/desktop-build/desktop-smoke-result.test.ts`<br/>17 个版本断言测试文件 |
| `w0-review` | `codex-sol-review` | `dependsOn: ["w0-market-panel", "w0-etf-risk-core", "w0-sqlite-v24"]`，审计列式面板因果前缀不变性、ETF 规则/资金守恒、风控三端同源口径、`v23 → v24` 零数据丢失与 `src/server/mcp.ts` 未触碰。 | 只读 (`--uncommitted`) |

---

### Wave 1 · 盈利策略新赛道：全市场多因子 Alpha 实验室 + A 股多资产/行业 ETF 轮动

| Task ID | 引擎 | 职责与改造要点 | 独占文件边界 (`owns[]`) |
| :--- | :--- | :--- | :--- |
| `w1-alpha-engine` | `codex-astra` | 1. 提取一次解析/检查、全市场批量执行的 TDX 公式引擎入口（保留未来函数拒绝与因果检查）。<br/>2. 修复现行 `factor-evaluation.ts` 按个股 `i+h` 取收益导致停牌错期的缺陷，改按**市场交易日历 `t+h`** 对齐。<br/>3. 落地全市场截面处理管线：上市/预热/流动性资格冻结 → MAD/分位缩尾 → Z-Score → 行业哑变量 + `log(GP16)` OLS 中性化（保留原版 / 严格中性版 / 等权合成 / 因果 ICIR 合成对照）；输出 Pearson IC & Spearman RankIC、ICIR、5/10 分组收益与多空、换手率、排名自相关、T+1/5/10/20 衰减；冻结 5 基准（主基准中证800 `sh000906` + `sh000300`/`sh000905`/`sh000852` + 同日合格池等权）。<br/>4. 一键生成冻结 `TargetSnapshot → scheduledTargets` 接入 `quant-backtest` 真实 Top-N 组合回测。 | `packages/trading-strategies/src/formula/{tdx-formula,formula-screen}.ts`<br/>`src/lib/research/{alpha-experiment,factor-evaluation}.ts`<br/>`src/server/research/alpha/**`（新）<br/>`src/server/research/factor-evaluation-job.ts`<br/>`src/server/api/routers/research.ts`<br/>`tests/research-backtest/alpha-cross-section.test.ts`（新） |
| `w1-etf-rotation` | `codex-sol` | 基于本地全覆盖至 `2026-11-23` 的 21 只代表高流动性 ETF，预登记三大策略族并输出统一 `TargetSnapshot`：①**多资产双动量**（宽基/红利/黄金/国债/纳指，绝对趋势+相对动量 Top 1–3，同指数去重，老品长历史对照）；②**行业 ETF 相对强弱轮动**（11 行业 ETF 中期动量 Top 2–3 + 退出排名缓冲）；③**股债金风险预算配置**（60/40 对照 + 月末波动率倒数加权 + 趋势降仓，独立 ETF 集中上限）。 | `packages/trading-strategies/src/etf-rotation/**`（新）<br/>`src/server/research/etf-rotation/**`（新）<br/>`tests/research-backtest/etf-rotation.test.ts`（新） |
| `w1-alpha-ui` | `claude-deepseek` | `dependsOn: ["w1-alpha-engine", "w1-etf-rotation"]`：升级 `/lab/analysis` 默认承载**多因子 Alpha 实验室**（保留原单标的 `EvidenceAnalysis` 为「证据解读」子页）：因子/公式添加与方向/权重/缩尾/中性化配置、IC/RankIC 序列与分层收益/换手/衰减图表、保存/读取 `factor_composites`、一键「转入研究工作室跑 Top-N 组合回测」。 | `src/app/lab/analysis/page.tsx`<br/>`src/components/workbench/{evidence-analysis,screen-view}.tsx`<br/>`src/components/research/factor-evaluation-panel.tsx`<br/>`src/components/research/alpha/**`（新） |
| `w1-review` | `codex-sol-review` | `dependsOn: ["w1-alpha-ui"]`，审计 `t+h` 日历对齐、ICIR 仅用成熟标签、ETF 无溢价/未来海外收盘泄漏、公式转组合次日合法开盘撮合。 | 只读 (`--uncommitted`) |

> **里程碑 1 验收点（可选阶段提交）**：完成 Wave 0 + Wave 1 后，即可独立运行全市场面板冷/热测速、多因子 Alpha 实验室与 3 大 ETF 轮动策略族 + 9 格执行现实回测。

---

### Wave 2 · `/lab` 策略研发工作室大重构 + 三账实施缺口与风控仪表盘

| Task ID | 引擎 | 职责与改造要点 | 独占文件边界 (`owns[]`) |
| :--- | :--- | :--- | :--- |
| `w2-studio-shortfall-core` | `codex-astra` | 1. **统一研究工作室后端 (`studio/`)**：冻结 `ResearchDraft → StudioResult` 契约，统一适配 6 模板（单策略 / 多分仓 2–6 / ETF 轮动 / 因子与公式组合 / 退出家族 / 5m SMA 基线），保留历史 `jobId`/`archiveId` 与新归档完整成交 sidecar；新增 **2D 参数稳健性网格**（开发段滚动 OOS + 强绑定 CSCV `PBO(Sharpe)` / `DSR 0.95` / $N_{\mathrm{eff}}$）与 **逐笔 MAE/MFE + Top-5 非重叠水下回撤**。<br/>2. **三账实施缺口与纪律偏差引擎**：冻结「策略理论账 → 可执行基线账 → 实际账（交割单/纸面成交）」，按 Perold 口径对同一份额只归因一次（信号至到达延迟 + 到达后滑点 + 漏单机会成本 + 行为偏差 + 费用差 = 精确期末净值差）；接通 `accountPortfolioRisk` 账户风控读接口。 | `src/lib/research/{lab-backtest,diagnose-contract,studio-result}.ts`<br/>`packages/quant-performance/src/performance.ts`<br/>`src/server/research/studio/**`（新）<br/>`src/server/api/routers/{strategy-lab,portfolio-review,accounts}.ts`<br/>`src/server/research/lab-backtest.ts`<br/>`src/server/research/diagnose/{prepare-request,grouped-run,archive,archive-fs}.ts`<br/>`src/lib/portfolio/implementation-shortfall.ts`（新）<br/>`src/server/portfolio/{implementation-shortfall-service,portfolio-risk-service}.ts`（新）<br/>`tests/research-backtest/{studio-parameter-grid,implementation-shortfall}.test.ts`（新） |
| `w2-studio-ui` | `claude-deepseek` | `dependsOn: ["w2-studio-shortfall-core"]`：把 `/lab/backtest` 当前三套割裂入口整合为统一 **「编排 / 结果 / 归档」** 研究工作室：五步可视化编排（内置可搜索分组策略选择器、具名池含 `core-30-v1`/ETF 池、`bookControl`、同族 PBO 互斥防护，JSON 退入只读抽屉）；100% 兼容旧 URL（`?archive=`、`?mode=object`、`?preset=`、`?strategy=&version=`、`?handoff=1`，增 `?run=`/`?alpha=`）；结果区落地 **9 格执行现实对照卡**、**2D 参数稳健性高原热力图**、**逐笔 MAE/MFE 与 Top-5 回撤表**、**全维度双归档对比与检索排序**（零删除）。 | `src/components/backtest/{backtest-page,ma-baseline-panel,factor-strategy-editor}.tsx`<br/>`src/components/research/lab-backtest.tsx`<br/>`src/components/workbench/{backtest-view.tsx,navigation.ts}`<br/>`src/components/research/diagnose/{diagnose-workspace-panel,diagnose-detail-view,diagnose-compare-panel,execution-scenario-card,time-holdout-card,evidence-samples,scan-handoff-banner}.tsx`<br/>`src/lib/research/studio-entry.ts`（新）<br/>`src/components/research/studio/**`（新） |
| `w2-shortfall-risk-ui` | `codex-sol` | `dependsOn: ["w2-studio-shortfall-core"]`：在 `/accounts` 落地 **账户级风控仪表盘**（回撤熔断档位、总止损敞口、行业集中度、ATR 定仓试算）与 **实盘/纸面实施缺口与纪律偏差面板**；迁移受工作室重构影响的既有 E2E spec 并新增 `tests/e2e/alpha-studio.spec.ts`。 | `src/lib/portfolio/account-workspace.ts`<br/>`src/components/portfolio/{account-review-settings,trade-review-results}.tsx`<br/>`src/components/portfolio/{account-risk-panel,implementation-shortfall-panel}.tsx`（新）<br/>`tests/e2e/{lab-diagnose,research-flow,r3c-workspaces,p0-workflow,p1-acceptance,execution-quality}.spec.ts`<br/>`tests/e2e/alpha-studio.spec.ts`（新） |
| `w2-review` | `codex-sol-review` | `dependsOn: ["w2-studio-ui", "w2-shortfall-risk-ui"]`，审计旧 URL/旧归档 100% 兼容、实施缺口零重复归因精确对平、2D 网格零过拟合背书、`src/server/mcp.ts` 未触碰。 | 只读 (`--uncommitted`) |

---

### Wave 3 · A 股全天候作战室 + 全来源 K 线交易复盘与严格因果 Bar Replay

| Task ID | 引擎 | 职责与改造要点 | 独占文件边界 (`owns[]`) |
| :--- | :--- | :--- | :--- |
| `w3-command-backend` | `codex-sol` | 1. **0–100 历史市场温度计与择时状态机**：五维 `25/25/20/20/10`（宽度 / `收盘>SMA20>SMA60` / 连板高度与家数 / 全市场成交额 / 宽基 ETF 5 日净申赎），252 日（≥120 有效点）因果分位 + 滞回 `≤35 防守 / ≥65 进攻`（双日确认回归，缺失断线，全程纯只读不联网写缓存）。<br/>2. **30 行业 RRG 轮动引擎**：周收盘相对沪深 300 计算 `RS-Ratio (X)` / `RS-Momentum (Y)` 近 8 周四象限轨迹与多周期 RPS。<br/>3. **持仓/自选/候选精准匹配财联社快讯 (`workspaceNews`)**：独立 60–120s 轮询，完全隔离 `todayWorkspace` 30s 主查询。<br/>4. **收盘 → 次日可执行 `RebalanceTicket` 服务**：对比 `TargetSnapshot` 与真实/纸面持仓生成先卖后买整手调仓单（含 ATR 止损、`maxBuyPrice` 拒追价、停牌/涨跌停、`conditional` 卖后买标志、v24 `rebalance_plans` 确认/复检/过期回执，**零自动下单**）。 | `src/server/market/{market-temperature,market-temperature-inputs,industry-rotation}.ts`（新）<br/>`src/server/market/{market-breadth,limit-sentiment,etf-net-subscriptions}.ts`<br/>`src/server/news/intel-service.ts`<br/>`src/server/db/news-workspace-query.ts`<br/>`src/server/api/routers/{market,news,portfolio}.ts`<br/>`src/lib/portfolio/rebalance-ticket.ts`（新）<br/>`src/server/portfolio/rebalance-ticket-service.ts`（新）<br/>`src/server/paper/rebalance-targets.ts`（新）<br/>`tests/workbench/{market-temperature-rrg,rebalance-ticket}.test.ts`（新） |
| `w3-command-ui` | `claude-deepseek` | `dependsOn: ["w3-command-backend"]`：升级 `/` 全天候作战室：落地 0–100 温度计历史曲线与状态徽章、30 行业 RRG 交互四象限（点击行业下钻 RPS 龙头与估值）、持仓/自选/候选快讯栏、次日可执行调仓计划单面板（人工确认与盘前只读复检，零自动下单）。 | `src/components/overview/{today-overview,today-workspace}.tsx`<br/>`src/components/overview/{market-temperature,industry-rotation,workspace-news,rebalance-ticket-panel}.tsx`（新） |
| `w3-chart-review-replay` | `codex-astra` | 1. **全来源 K 线交易复盘 (`TradeReviewRef`)**：统一接入 Lab 工作室 / 因子 Top-N / ETF 轮动 / 纸面账户 / `/accounts` 实盘交割单，主图渲染买卖点 + **持仓盈亏区间盒** + **MAE/MFE 极值标尺** + 前后笔步进（`[` / `]`）+ 点击回跳证据/原批次；`/accounts` 成交与交割单补齐「看K线」。<br/>2. **严格因果 Bar Replay 逐根训练**：独立挂载 `MarketChart`（`viewportPolicy="ephemeral"` 绝不污染普通图 `rememberChartRange`），服务端按所选历史日截断未来行情，支持空格播放/暂停/步进/倍速、可见前缀因果指标 + 按需主线程唯一串行 CZSC、盲测手工模拟买卖，结束后揭晓理论信号并给出**时机 F1、规则纪律分、收益/回撤差与漏做明细**。 | `src/lib/chart/{trade-review-ref,bar-replay}.ts`（新）<br/>`src/lib/chart/chart-trade-marks.ts`<br/>`src/lib/stores/market-session.ts`<br/>`src/server/charts/{chart-trade-review,bar-replay-session}.ts`（新）<br/>`src/server/api/routers/bar-replay.ts`（新）<br/>`src/server/api/root.ts`<br/>`src/components/market/{chart-workspace,open-chart,market-route-selection,market-chart-base,market-chart-instance,market-chart-state,chart-hotkeys}.ts(x)`<br/>`src/components/market/charts/{market-chart,trade-review-panel,trade-review-overlay,bar-replay-panel}.tsx`<br/>`src/components/portfolio/{portfolio-result-view,paper-accounts-panel}.tsx`<br/>`src/components/portfolio/account-workspace/trade-sources.tsx`<br/>`src/components/financial/financial-replay-panel.tsx`<br/>`tests/market-chart/chart/bar-replay-causality.test.ts`（新）<br/>`tests/e2e/{bar-replay,chart-trade-marks}.spec.ts`<br/>`tests/workbench/chart-trade-marks.test.ts` |
| `w3-review` | `codex-sol-review` | `dependsOn: ["w3-command-ui", "w3-chart-review-replay"]`，审计 Bar Replay 双夹具前缀零泄漏、CZSC 主线程唯一串行队列、作战室零联网写副作用且零拖慢主轮询、调仓单零自动下单与 `src/server/mcp.ts` 未触碰。 | 只读 (`--uncommitted`) |

---

### Wave 4 · 全市场真实数据实证、全量门禁、E2E 与 v24 桌面正式打包交付

1. **只读 `E:/new_tdx64` 全市场实证矩阵（隔离 `QUANT_DATA_DIR`，落盘 `docs/research-backtest/2026-11-XX-iter4-flagship-empirical.md`）**：
   - **`MarketPanelStore` 实测**：5,923 股 + 21 ETF 冷建/热读耗时、RSS 与 `tstdx/local` 原字段逐笔 0 误差对拍、因果复权前缀不变性。
   - **ETF 轮动 × 9 格执行现实 × 4 危机切片 × 账户风控消融**：3 大 ETF 策略族 × `10万 / 30万 / 100万 × 开盘 / 09:35 / 09:45` × 4 危机切片 × `PortfolioRiskEngine` ON/OFF 配对对照。
   - **全市场多因子 Alpha + 一键 Top-N 组合回测**：价量/动量/波动/换手/PIT 复合因子全市场 RankIC / ICIR / 10 分组收益与衰减 + Top-10 真实撮合回测（对拍中证800/300/500/1000 与等权池，诚实披露存续样本偏差与 GP16/行业边界）。
   - **作战室 + 实施缺口 + Bar Replay 验真**：0–100 温度计历史节点、30 行业 RRG 8 周轨迹、三账实施缺口 215 元手算精确对平、Bar Replay 双夹具未来截断零泄漏证明、0 残留 `czsc-worker`。
2. **全量工程门禁、Playwright E2E 与 v24 正式打包**：
   - `pnpm check` 6/6 全绿（根测试 + 7 包 + `v23 → v24` 迁移与原子回滚测试全绿）；
   - Playwright E2E（全部用 `--project=<name>`）：`alpha-studio.spec.ts`、`bar-replay.spec.ts`、`lab-diagnose.spec.ts`、`chart-trade-marks.spec.ts` 及迁移后的既有核心 suite 全绿；
   - `pnpm desktop:pack`（0 Turbopack 告警、`.next/standalone` 与包内 `resources/server` 均 **0 `.env*`**）+ `node scripts/desktop-smoke.mjs --diagnose-smoke --packaged` & `--lifecycle-smoke --packaged`（核验 `schemaVersion: 24`、`v23 → v24` 升级、`czsc.apiVersion: 22`、`thsdk.rejected: true`、0 残留进程）。
3. **收尾与授权**：更新 `docs/next-plan.md` 与 `docs/roadmap.md`，用 `fleet clean --apply` 清理全部临时产物，核验 `src/server/mcp.ts` 零改动与 `git diff --check`，汇报完整实证后等待提交授权。

---

## 3. 全程硬约束（不可违背）

- **只读源与库隔离**：`E:/new_tdx64` 与外部 Blocks 严格只读；任何触达 SQLite 的命令/测试一律使用 `.test-data/` 隔离 `QUANT_DATA_DIR`，绝不打开默认生产库、绝不删库或降 `user_version`。
- **单宿主唯一串行 CZSC**：所有 `CZSC64.dll` 调用（含 Bar Replay 按需缠论）必须经主线程唯一 `projectCzsc` 队列。
- **研究诚实与因果红线**：所有数据关联满足 `availableAt <= 决策截止`；严禁未来行情/成分/修订财务回填；Bar Replay 未来截断零泄漏；不以回测收益、PBO=0 或单一成功样例宣称实盘稳赚。
- **零未授权副作用与资产保护**：绝不修改 `src/server/mcp.ts` 及用户维护文案；调仓计划单仅人工确认、严禁自动下单；零自动晋级、零外发通知、零归档删除；提交、推送与正式发布分别取得授权。
- **多 Agent 纪律**：并发写任务 `owns[]` 严格互斥；`claude-deepseek` 不传 `--model`/`--effort`、不设 `ANTHROPIC_MODEL`、显式 `--permission-mode bypassPermissions`；Codex 三引擎显式 `high` 强度；默认降级限定 GPT ↔ Claude，不自动消耗 Gemini 额度。
