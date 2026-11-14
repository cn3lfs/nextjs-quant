# 观澜 — Diagnosis and Optimization Plan (2026-11-13)

## 定稿摘要与当前进度（2026-11-13）

执行状态：派单 B 已收口页面模型与共享行情归属，交管理者验收/提交；后续依据见 [当前计划](next-plan.md)，本轮不自动推进下一批。

**方案已定稿，产品选择已确认；P0 代码与隔离应用验收已完成，暂停前推进 P1/P2 界面与状态拆分，P3 已开始读取契约整理，P4 构建缓存、隔离门禁、运行错误诊断与类型感知 lint 已验收，其余工作仍待推进。** §1–§3 是原诊断快照，执行以本摘要、§6 和 §12 的最新决定为准。

| 顺序 | 最终交付内容                                                        | 当前状态                                                                                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 清理 | 删除项目不用的历史结果/证据/日志，保留数据源及现行依赖              | 已清理 3,176 个文件，约 2.11 GiB；用户另执行脚本清除 4 个临时工具文件，目录已复核不存在                                                                                                                                                                                |
| P0 | 恢复公式选股、双突破；删除旧入口/API/执行及兼容分支；三个调度器暂停 | 已完成代码与隔离应用验收：280 个 API 显式声明能力；旧执行、结果兼容、自动快评与冲突的旧策略目录退役；worker/服务/下载跟进遵守暂停；活动任务完整分页恢复，不补跑。逐项证据见交付说明，不代表全路由视觉或桌面交付完成 |
| P1   | 整理首页、行情、证券池/RPS、筛选流程；统一状态、单位和浅色视觉验收  | 进行中：统一财务百分比/倍数展示，区分 RPS 读取中、读取失败与空闲；证券池迁至 `/stock-pool` 并以 URL 保留筛选/分页，RPS 迁入发现。RPS 等待/故障、财务子视图、窄屏列表收起及财务缺目录状态已通过应用验收；图表工具区、导航及行情上方信息区已整理；固定 1440×900 应用用例首屏可见图表至少 540px 通过，周期/F8/共享画线与隐藏弹层回归通过；首页/盘中暂停文案与首页读取失败/空态已修正；现行24入口双尺寸初始状态已检查；证券池/RPS批次缺失提示已收拢，保留个股原因/缓存/身份及导出，周期切换不暂用旧数值，6项定向应用验收通过；策略中心按本地历史日历默认日期、名称/代码搜索与输入校验已通过 6 项定向应用验收；档案/台账提示与现行研究指南已通过 7 项定向应用验收；完整状态/交互/缩放待推进         |
| P2 | 拆分全局状态、明确页面状态生命周期、拆分图表职责 | 进行中：行情选择/快照独立；筛选、首页、设置和研究各自拥有查询/操作，面板仅接收所需字段。筛选控件与研究草稿使用独立会话状态；浏览器验证编辑不重渲染外壳、隐藏输入变化/失效不请求、缓存淘汰后恢复。图表已拆为实例、画线事件、结构/价格/指标层及图例；首页/任务中心迁入常规路由，URL 保存排名/筛选，任务草稿/游标与取消状态独立；普通路由不占面板缓存。名称目录已改为消费页面订阅；任务/通知摘要已归侧栏，筛选自行订阅任务缓存，更新不重渲染外壳，失焦停止轮询，快速完成扫描正确刷新覆盖。前批12项页面与4项流程验收保留；设置/覆盖、自选和模型选择已归可见页面，新增故障恢复与自选跨页同步后12项核心流程通过，B-page-model 将保留范围收敛为行情/筛选/回测，其他页面交给常规路由；行情选择归 market-session/URL，加载归行情页，外壳不订阅行情；其余细粒度状态与全站视觉仍待推进 |
| P3   | 仓储/分页契约、外部路径配置；按实测决定是否迁移热表                 | 进行中：通用 list 显式限量、稳定 ID 分页和同事务批量读取；渠道/监控/公式完整目录与研究使用统计已迁移。CLS/Python 配置与只读检查已实现；通达信空配置保护与 Blocks 设置入口已整理，移除工作流硬编码兜底；任务概览已移入类型仓储，侧栏使用全量计数，最新完成扫描不受最近 80 条限制；其余类型仓储、大结果摘要待推进；未改 schema                                                                                                                                                                                                                 |
| P4   | 统一构建入口、工程检查与错误诊断                                    | 六包按 workspace 依赖图构建，输入/输出内容校验实现未变包跳过；隔离检查门禁与可选 pre-push 已提供，前批完整门禁曾通过、hook 未安装。限额错误记录与任务中心最近错误已接入并验收；类型感知 Promise/未使用变量与静态 ESM 导入边界已启用，修复导出清理与调度拒绝处理；140 项格式差异已收敛并接入门禁首步；固定动态依赖、模块/包循环已接入门禁并拆除两处服务层循环；修正浏览器检查零用例成功问题；66 个测试支持文件已按职责归位并更新引用；主 E2E 已改为独立服务和全规模合成负载，既有预算保持；前批两项全量选股失败已修复，6,154 只全量选股两项回归与现行回测通过，服务日志无锁异常；任务页请求时渲染已验收，两轮独立首访 115.9/157.6ms，均低于 300ms；Zod 安装冲突与并行技能文件格式仍阻挡完整门禁                                                                                                                                         |
| P5   | 当前计划/交付/架构说明精简，WDZ 迁出并更新消费者                    | 当前计划和 AGENTS 目标已同步，交付收敛为单一说明；架构已更新页面模型、能力策略、六包依赖与 CZSC v22，其余旧文档待核对。WDZ 脚本和消费者已准备，2,319 文件预演通过；实际迁出待用户执行                                                                                                                               |

执行记录集中于[当前优化交付](deliveries/2026-11-13-optimization.md)，接续任务见[当前计划](next-plan.md)。B 批完整 pnpm run test 已退出 0：主工程 6,299 项、包级 194 项通过，27 项既有跳过；typecheck、lint、format:check 与生产构建通过。管理者修复 Zod 安装后原冲突未复现；新增暴露的来源目录 URL 夹具已修复并重跑全套，不登记失败豁免。页面模型、隐藏请求、候选/证券池往返与 URL 恢复的当前证据见交付说明；临时夹具删除被自动审批拒绝，保留默认预演脚本。66 个测试支持文件归位及固定输入校验已完成。本批修复复盘隐藏标签取数和隐藏详情 Escape 监听；主 E2E 使用 6,154 只合成证券、2,222/9,418 笔成交独立造数，前批完整规模 15 项通过、2 项选股失败；两项选股阻塞现已修复并复验通过。完整快照在 worker 分批保存，主进程确认每批进度后才继续；同规模主线程最大心跳间隔由约 19,649ms 降至 70.4ms，6,154 个快照/12,628,008 根 K 线完整核对，日志无锁异常。任务页改为按请求渲染筛选表单，两轮独立首访中位数 115.9/157.6ms，原始 HTML 与返回/刷新回归通过，该预算缺口已关闭；不缩小证券池或放宽阈值掩盖失败。前批 49 项定向测试、包级 194 项、依赖扫描、lint、独立生产构建与资源准备，以及 3 项真实 worker 应用流程证据保留。24 个现行入口在 1440/1024px 的初始状态、首页故障恢复与离线边界共 50 项应用检查通过；打板情绪跨日默认日期修复后，宽窄屏及跨日 3 项定向复验通过。前批固定行情用例首屏图表可见高度 60%、五套图表专项及导航/弹层检查保留。证券池/RPS重复说明已修正，另通过6项定向应用检查；策略中心历史日期与证券搜索已修正，另通过 6 项定向应用验收；档案/台账提示与研究指南已修正，7 项定向应用验收通过；有数据状态、完整标签/弹窗、键盘与缩放验收仍未完成。未安装 hook、正式打包或真实渠道/账户联调。P1–P5 恢复后按完整范围继续推进。

P3 本批补充任务摘要与公式结果页投影：摘要明确字段，候选/隔离/错误各最多 50 行，搜索与排序先于取页，完整导出保持全量。名称目录一次展开并关联，避免反复遍历 JSON；不修改 schema。摘要和首屏改善了 JS 解析量及本机耗时，搜索排序耗时增加，详细测量与验收边界见交付说明；其他大结果和导出读取仍待推进。

历史文件清理与 WDZ 迁出由用户手动执行，脚本入口及范围见交付说明；WDZ 的默认预演通过不等于实际迁出完成。数据源、现行输入、业务数据库和正式包不做顺手删除。

Scope: architecture, UI, functionality, engineering and documentation of the whole repository.
This document records the optimization plan and the user decisions in §6 and §12. P0 code and isolated application acceptance are complete; P1–P5 remain in progress. WDZ relocation awaits the user; schema migration is conditional on a demonstrated need. Historical artifact cleanup is complete within the reviewed scope; see the status table above. Existing explicitly authorized product scope remains valid; commits, packaging and production database operations remain separate.

补全说明（2026-11-12 本地复核，保留原文件名）：§1 的运行结果是原诊断记录，本轮未重跑；本轮只读核对当前代码、项目约束与交付文档，修正判断并补充 §7–§12。数量和耗时是原诊断快照，不作为当前基线或排期承诺。随后用户明确：恢复公式与双突破，旧功能直接由新流程替代且不保留兼容，三调度器暂停，WDZ 迁出；以下执行章节已同步，不再保留这些事项的二选一。

## 1. How this was checked

| Check                                                                                                                                                      | Result                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `tsc --noEmit` on the current working tree (68 uncommitted files included)                                                                                 | Passes                                                                      |
| `eslint src`                                                                                                                                               | Passes, but the config enables a single rule (`react-hooks/rules-of-hooks`) |
| Isolated dev server (`QUANT_DATA_DIR` under `.test-data/`, port 3917), pages `/`, `/market`, `/screen`, `/strategies` at 1440 px, `/strategies` at 1024 px | Viewed and screenshotted; server stopped and data removed afterwards        |
| Direct calls to seven tRPC operations on that server                                                                                                       | All seven returned `412 PRECONDITION_FAILED` (see F1)                       |
| Static survey of `src`, `packages`, `tests`, `scripts`, `docs`                                                                                             | Counts quoted below                                                         |

Not run: `pnpm test`, `pnpm build`, the desktop package, any real data source, notification, or trading call. Pages other than the four distinct routes above were read in code only. The isolated database was empty, so findings about populated tables and charts with real RPS data are limited.

Size for orientation: `src` ≈ 42k lines, `packages` ≈ 59k, `tests` ≈ 53k, 24 route entries, 13 tRPC routers, 67 scripts, 2,898 tracked files under `docs`.

## 2. Summary

The original checks establish compilation and limited lint success, not functional correctness or a current full-suite pass. The main issues identified in this survey are:

1. **The product contradicts itself.** Twelve operations are rejected by the server as deprecated, and three schedulers are switched off by a hard-coded flag, while their pages, buttons and status cards are still in the UI. The flagship chart page shows a red error by default because of this.
2. **The front end has two page models and one global state hook.** Seventeen routes return `null` and are rendered by a client-side panel cache driven by a single hook holding about 35 state fields and 15 queries.
3. **Persistence is one JSON table used through raw SQL.** 74 record kinds share `records`; 63 files write their own `prepare(...)` statements.
4. **Pages are overloaded and status language is inconsistent.** `/market` is roughly ten viewport-heights long; "not yet computed" is shown as "失败".
5. **Engineering guardrails rely on discipline.** No CI or hooks, a one-rule lint, an unformatted baseline, and a five-times-duplicated build chain.
6. **Documentation has stopped being a map.** `next-plan.md` is a reverse-chronological log, `architecture.md` is stale, and the stated project goal no longer matches what the code allows.

Recommended order: fix item 1 first (it is cheap and removes visible breakage), then items 4 and 2 together page by page, then 3 and 5 as background work.

## 3. Findings

### 3.1 Functionality and product consistency

**F1. Deprecated operations are still wired into the UI (highest priority).**
`src/lib/backtest/strategy-lifecycle.ts` lists twelve operation names; `publicProcedure` in `src/server/api/trpc.ts` rejects them by name. Called directly, `formulaScreen`, `screen`, `intradayRun`, `strategyResearchCreate`, `walkForward`, `chanAnalyze` and `backtest` all returned "该策略已弃用". The UI still calls them from:

| Operation                                                               | UI caller                                                      |
| ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| `screen`, `backtest`                                                    | `workbench/use-workbench-state.ts`                             |
| `formulaScreen`                                                         | `screening/formula-screen.tsx` (the default tab of 条件选股)   |
| `intradayRun`                                                           | `intraday/intraday-controls.tsx`, `intraday-history-panel.tsx` |
| `strategyResearchCreate`                                                | `research/strategy-research-controls.tsx`                      |
| `walkForward`                                                           | `backtest/walk-forward-panel.tsx`                              |
| `chanAnalyze`, `canslimAnalyze`, `wyckoffAnalyze`, `fundamentalAnalyze` | the four panels under `components/research/`                   |

Visible consequences: `/market` opens with "双突破计算失败：该策略已弃用…" because the 双突破 overlay is checked by default; 条件选股 lets you write, check and save a formula and then fails at "全市场执行公式".

This also conflicts with later work. The 2026-11-08 RPS delivery extended formula screening, and the working tree has uncommitted changes to `tdx-formula.ts` and `formula-screen.tsx`, for an operation the server refuses to run. The 2026-11-07 decision said data capabilities such as RPS were not meant to be retired with the old trading strategies; formula screening looks like it was caught by the gate unintentionally.

**F2. Three schedulers are permanently off, but the UI presents them as configurable.**
`legacyAutomaticStrategiesEnabled = false` gates `scheduleSignalLedger`, `scheduleIntraday` and the whole monitor tick in `src/server/runtime.ts`. The home page still says "盘中预选未启用 … 启用后在 11:20 / 14:40 各运行一次" with a 去设置 button, and shows a 今日信号 table. 信号与通知, 信号台账 and 盘中预选 remain in the navigation with no indication that nothing new will arrive.

**F3. The stated goal and the code disagree.**
`AGENTS.md` describes the product as browsing, RPS, 双突破/缠论选股, sample research and pre-market review. The code has retired 双突破, 缠论 analysis, sample research and intraday selection. Meanwhile 策略中心 lists "双突破直接确认" and "缠论三买" as "规则已实现". There are three status vocabularies in play (lifecycle `active/deprecated`, catalog "规则已实现/研究方法/缺少输入", and per-page "已弃用" labels) with no single table tying them together.

**F4. Scope has grown beyond the declared focus.**
Older roadmap sections say to focus on A-shares and not schedule other markets. The newer 2026-11-11/12 entries explicitly authorize crypto simulation and account history, and take precedence. Since those older sections the app gained crypto auto-trading on three exchanges' simulated accounts (a 10-second tick inside the same server process, `crypto-trading/adapter.ts` at 1,287 lines) and a futures page. The planning problem is reconciling documented scope and regression coverage, not treating authorized crypto work as scope creep. Preserve its current behavior; new expansion is outside this optimization proposal. Futures needs a separate current-state inventory.

**F5. Machine-specific paths are compiled into the code.**
`E:\new_tdx64` and `E:/pythonPrj/cls_news_collector/cls_news.db` as defaults in `lib/domain.ts`; `C:\Python312\python.exe` and the same database path hard-coded (not read from settings) in `server/news/cls-news-workflow.ts`; `D:\wsWDZ\Blocks` as a fallback in `jobs/workflow-runner.ts`. On any other machine, or after a reinstall, the CLS workflow fails with "新闻技能脚本启动失败" and no hint about the path.

**F6. Smaller functional issues seen in the UI.**

- 策略中心 defaults the experiment end date to the literal `2026-11-06` and takes the security as free text, while `/market` has a proper security search.
- Background failures are discarded: `void tick().catch(() => {})` for the scheduler, outbox and crypto ticks, about 30 empty catch handlers, and only 12 `console.*` calls in `src`. A failing scheduler leaves no trace the user can find.

### 3.2 UI and interaction

**U1. `/market` carries four jobs on one page.**
Top to bottom: watchlist, chart toolbar with 20-plus indicator toggles, the chart (about 300 px tall), a nine-tab local financial workbench, a second fundamentals grid, collapsible statements, an index browser, a survivorship-bias audit notice, and a 5,225-row stock pool table. The chart, the reason for the page, is about a tenth of the scroll height.

**U2. Status semantics do not match the state.**

- Fresh install: "RPS 尚未计算" carries a red **失败** tag; the stock pool shows a red alert "RPS计算失败：向前RPS仅接受今天15:05后…" for what is a precondition, not a failure.
- The same sentence, "未扫描到日线；尚无当前数据源的RPS，请先计算", is repeated on every one of the 5,225 rows instead of once above the table.
- The home page shows three primary buttons of equal weight (看排名, 去扫描, 去扫描), against the DESIGN.md rule of one most-prominent action.

**U3. Numbers are formatted inconsistently, sometimes ambiguously.**
On one page, 资产负债率 appears as "0.119 比例" and again as "11.90%". 营业收入累计同比 shows "1.9595 %", which could be read as 1.96% or 195.95%. Volume shows "4177984.00 股". There is no shared formatter per quantity type.

**U4. Caveats are body text.**
Almost every panel carries one to three sentences of methodology disclaimer in normal-weight text ("高 RPS 是候选过滤，不是买入指令", "历史导入与回测不会发送通知", the long 年化 explanation). They are correct, but they outweigh the data visually and repeat across pages.

**U5. Navigation.**

- The sidebar is an accordion with only the active group open, so 18 of the 21 listed pages are hidden behind collapsed headers while two-thirds of the sidebar is empty.
- At 1024 px it collapses to icons with no labels, mixing group and page icons in one column; 今日, 今日总览, 研究 and 策略中心 all use the same compass icon.
- Group membership is uneven: 研究 holds six pages including 新闻/主题, while RPS 管理 sits under 系统 although it is a daily tool.
- 策略中心 shows 91 strategies as one flat scrolling list, with category labels mixing Chinese and raw keys (`wyckoff`, `chan`, `value`, `industry-chain`).

**U6. The style system is three layers deep.**
`globals.css` is 1,508 lines of unlayered legacy classes on top of Tailwind 4 utilities and shadcn components. Tokens are centralized well (no raw hex in components), but the accent ramp kept its dark-theme names with light values (`--nc-accent-100` is white, `--nc-accent-900` is the palest blue), `@custom-variant dark` and a "加深背景" chart toggle are leftovers, and breakpoints are 600, 900, 1024, 1100 and 1239 px in different places. The light redesign was delivered with syntax checks only; it has not had a visual or behavioural acceptance pass.

### 3.3 Architecture

**A1. Two page models.**
Seventeen routes have a `page.tsx` that returns `null`; `Workbench` in the root layout renders them from a `PanelCache` keyed by pathname (up to six kept mounted). Seven routes (策略中心, 信号台账, 持仓, 交割单, 报告详情, 研究数据指南, `ui-gallery`) are ordinary Next.js pages with their own `loading`/`error`/`actions`. A new page has to choose a model, and the two differ in data fetching, error handling and state lifetime. 174 of 245 component files are client components, so the server-component model is mostly unused.

**A2. One hook owns the app's client state.**
`useWorkbenchState` (412 lines) declares about 35 `useState` fields and 15 queries and mutations for screening, backtest, analysis and chart loading. It runs in the root layout on every route, including routes that use none of it, and is passed down as `state`; `TodayOverview` takes the entire object. Any field change re-renders the shell and every mounted panel. Its own comment says it is kept as one unconditional hook to preserve lifetimes, which is the constraint to remove.

**A3. The database is a document store queried by hand.**
`db/schema.ts` is seven lines: one `records(id, kind, payload, updated_at)` table. 74 distinct kinds are written into it. Hot paths are served by partial expression indexes over `json_extract(...)`, with comments noting the index expressions must be kept in sync by hand with query files. There are 261 `json_extract` uses and 63 files outside `db/` issuing raw `prepare(...)`; Drizzle is imported in two files. One documented consequence already occurred: the generic `list(kind)` silently caps at 200 rows and the monitor loop missed subscriptions until it was rewritten. Job results are stored inside the job payload (a comment records 57 MB after a few hundred runs).

**A4. Very large units.**
`market/chart.tsx` 2,202 lines with 14 effects; `backtest/research-portfolio.ts` 2,117; `research-management-fields.tsx` 1,630; `canslim/research-growth-intraday.ts` 1,371; `crypto-trading/adapter.ts` 1,287; `tstdx/financial-data/catalog-source.ts` 3,229; `trading-strategies/.../growth-factor-engine.ts` 2,221. `runtime.ts` holds the whole monitor decision loop (about 230 lines, five levels deep) inside the scheduler entry point.

**A5. Package boundaries have two leaks.**

- `quant-backtest`, described as the pure engine, contains `csi800-study.ts` (837 lines) and `csi800-exposure.ts`, which are specific research experiments.
- `trading-strategy-core` (indicators) depends on `tstdx` (TDX file parsing), so the indicator core cannot be used without the data-source package.

**A6. Process model is implicit.**
Fifteen modules keep singletons on `globalThis`; workers are created in at least eight places with three mechanisms (`worker_threads`, `fork`, `spawn`), each with its own lifecycle and error handling.

### 3.4 Engineering

**E1. No automated gate.** There is no `.github`, no git hook. `pnpm check` exists but nothing runs it. The docs record a standing baseline of about 105 files failing `format:check` and 28 skipped tests.

**E2. Build chain duplicated.** The six-package build sequence is spelled out in `build`, `dev`, `typecheck`, `runtime:build` and `test`. Adding a package means editing five lines, and every `typecheck` rebuilds every package.

**E3. Test suite shape.** About 12,000 tests is a real asset. Weak spots: at least 15 test files assert on source text (`readFileSync("src/…")` then `toContain("aria-pressed={entry === id}")`), which fail on harmless refactors and pass on broken behaviour; 70 loose seed/perf/fixture scripts sit in the `tests/` root; browser harnesses already have `scripts/run-browser-harness.mjs` (`pnpm test:browser`) and page E2E has `pnpm e2e`; audit their coverage and performance budgets rather than introducing another runner.

**E4. Working tree hygiene.** 68 uncommitted files spanning at least three tasks, including the RPS module work dated 2026-11-08 (a deleted engine file, an untracked adapter, an untracked delivery note). `.next` is 4.0 GB, `release` 538 MB. `dual_ma_strategy.py` sits tracked in the repository root; an untracked `__pycache__` sits under `docs/`.

### 3.5 Documentation

- `next-plan.md` is titled a plan but is a newest-first log of 30-odd finished deliveries; the current work item cannot be found without reading it all. It links 13 delivery records under `C:/Users/jm/Documents/Codex/…`, outside the repository.
- `roadmap.md` calls itself the single source of scope and opens with 50 lines of dated changelog.
- `architecture.md` still lists a "历史冻结记录" section and cites `czsc-api-v4`; the roadmap says API v22.
- `docs/` tracks 2,898 files (28 MB), of which 2,363 are a raw WDZ block-definition snapshot. That is input data, not documentation.

## 4. Plan

Effort: S ≈ up to a day, M ≈ two to four days, L ≈ a week or more. Each phase is independently shippable.

### Phase 0 — Make the product tell the truth (S–M)

The user has settled the capability choices. Restore formula screening and the breakout chart; remove legacy workflows and use current replacements without compatibility shims. Keep the three automatic schedulers paused.

| Capability                                                       | Decided treatment                                                                                      | Boundary                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formula screening (`formulaScreen`)                              | Restore                                                                                                | Verify validation, saved formula, task execution, results and export; `screen` is a separate old operation.                                                                                                                                                                                                                       |
| 双突破 chart overlay (`breakout`)                                | Restore read-only computation                                                                          | Preserve snapshot/period semantics; no notification or trading side effects.                                                                                                                                                                                                                                                      |
| 缠论 chart structure (`czsc`, `czscSchema`)                      | Preserve                                                                                               | Already outside the deprecated operation set; regression-test API v22.                                                                                                                                                                                                                                                            |
| Old screening/backtest/sample research/walk-forward/LLM analysis | Remove old UI, API and compatibility paths; use the current screening, strategy and backtest workflows | Unused historical outputs/evidence are removed; retain source data and inputs still required by current functionality/tests. Do not keep old pages as a read-only compatibility product. No proven walk-forward equivalent exists: remove the old entry, do not claim replacement coverage or build a new engine just to fill it. |
| Intraday selection, signal monitor, signal ledger scheduling     | Pause                                                                                                  | No re-enabling, catch-up runs, notification or subscription rewrite. Present paused state honestly.                                                                                                                                                                                                                               |

Work:

1. Make currently supported capabilities explicit across the server, navigation and pages; distinguish executable functionality from data prerequisites and temporary pause.
2. Remove obsolete routes, controls, API declarations, dead callers and task entry points once their consumers are mapped; no redirects or adapter endpoints solely for old compatibility. Shared calculations used by new workflows remain.
3. Restore `formulaScreen` and `breakout` through their complete task/query paths; cover query, mutation and scheduler entry points, not just buttons.
4. Test the current entry paths and verify removed APIs cannot launch work. Remove unused historical outputs after reference and source-data checks; retain the inputs needed by current functionality/tests.
5. Synchronize product scope and catalog execution badges with the new workflow; implementation status and data-evidence status remain separate.

Done when: fresh-install navigation opens current workflows without predictable deprecated-action failures; restored formula/chart paths work; old entries and compatibility handlers are absent; paused schedulers produce no new work.

### Phase 1 — UI clarity on the daily path (M)

Order by daily use: `/`, `/market`, `/screen`, `/rps`.

1. **Split `/market`**: chart workspace with the watchlist as the page; financials as a tab or drawer of the selected security; the stock pool as its own route (it already has URL parameters). Target: chart at least 60% of the first viewport at 1440×900.
2. **Status vocabulary**: one mapping used everywhere, `未开始 / 等待前置条件 / 进行中 / 完成 / 失败 / 已停用`. "Not computed" and "precondition not met" are never red. Table-wide conditions appear once above the table.
3. **Formatters**: one module for percent, ratio, money, volume and price, each with a fixed precision and unit; remove ad-hoc formatting from the financial panels. Only dimensionless fractions with a percentage contract display as percentages; valuation multiples and risk/reward ratios remain multiples. Source units must be verified before conversion (§9).
4. **Caveats**: move methodology text into a per-panel "口径说明" popover; keep at most one line visible where the caveat changes how a number should be read.
5. **Navigation**: keep daily-use entries visible and make all other entries discoverable; verify actual height, zoom and keyboard access before choosing default expansion, move RPS 管理 to 发现, give group headers no icon at collapsed width or distinct ones, add tooltips at 1024 px, and group 策略中心 by category with localized labels.
6. **Light theme acceptance**: a Playwright pass that screenshots every route at 1440 and 1024 on the seeded fixture database, reviewed once and kept as the visual baseline. Remove the dark-theme leftovers and settle on three breakpoints.

Done when: the screenshots are reviewed and stored as baselines; the formatter module has unit tests; empty or unmet-precondition states are not labeled 失败; actual failed requests remain visible.

### Phase 2 — Front-end structure (M–L, incremental)

1. **Break up `useWorkbenchState`** into per-domain stores or hooks (chart selection, screening session, backtest session, shell: toasts and job badges). Zustand is already a dependency. Each panel subscribes only to what it renders; the shell no longer re-renders on a screening page change.
2. **One page model.** Keep the panel cache, since preserving chart and draft state is a real requirement, but make it explicit: every route registers its panel in one registry and `page.tsx` files stop being decoys, or move the keep-alive need to the two or three pages that have it and let the rest be normal routes. I recommend the second: only `/market`, `/screen` and `/backtest` are candidates for explicit state retention, subject to measured lifecycle and draft requirements (§9); this does not require keeping all three page DOM trees mounted.
3. **Split `chart.tsx`** along its existing seams: chart instance lifecycle, indicator panes, overlays (CZSC, breakout, drawings), legend. No behaviour change; the existing chart tests are the safety net.

Done when: profiler and request traces show no unnecessary cross-domain work from screening pagination; no component receives the whole state object, and the navigation/state-retention scenarios in §9 pass.

### Phase 3 — Data layer (L, isolated work packages)

1. **Repository per kind.** Introduce typed accessors (`jobs`, `monitors`, `signals`, `deliveries`, `settings`, …) and move raw SQL behind them, starting with the five kinds that have expression indexes. Lint-forbid `prepare(` outside `server/db` and the repositories once migrated.
2. **Promote hot kinds to real tables** in new migrations (jobs with a separate results table first, then signals and deliveries), copying data forward; `records` remains for low-volume configuration. Each migration makes older executables unable to open the database, so batch them into one release.
3. **Replace implicit truncation** with explicit paged reads and bounded full iteration. Requiring a limit alone does not prevent a caller from treating one page as the whole set; define cursor/order semantics and audit all callers (§10).
4. **Settings for external paths**: Python executable, CLS database, block directory, with a diagnostics row in 数据与连接 for each. No machine path in source.
5. **Decide on Drizzle**: either use it for the new tables or remove it and `drizzle-kit`; today it is carried but not used.

Done when: `grep prepare(` outside the data layer is empty for migrated kinds; a fresh machine with different drive letters passes the connection diagnostics.

### Phase 4 — Engineering guardrails (S–M)

1. **One build entry**: a `packages:build` script (or `pnpm -r --filter "./packages/*" build`) referenced by the other five; add TypeScript project references or a staleness check so `typecheck` does not rebuild unchanged packages.
2. **Local gate**: first provide a reproducible check command; an optional pre-push hook calls it. Hooks are bypassable and do not replace required full subtask tests. Decide hosted CI separately, using isolated data and no production credentials.
3. **Lint**: reconcile the stale “无 ESLint / 不引入新的 lint 工具” text in conventions first. Stage type-aware `no-floating-promises`, TypeScript unused-variable checks and import boundaries using installed tooling. `import/no-cycle` needs a plugin not currently declared; do not assume it exists or add it without documenting the need.
4. **Format baseline**: remeasure violations and distinguish line endings from content before formatting. Preserve fixture bytes and hashes; avoid a mass rewrite of concurrent edits. A separate mechanical commit is only possible after explicit commit authorization.
5. **Tests**: replace source-text assertions with rendered-output assertions as files are touched; organize loose support files by actual role: `tests/perf`, `tests/fixtures/seed`, `tests/manual`, `tests/helpers` and `tests/browser/fixtures` (66 files moved; the original 70 was a snapshot estimate); extend the existing browser runner and E2E entry with applicable budgets from `perf-budgets.json`.
6. **Observability**: a small file logger under the data directory, used by every `catch` in schedulers and workers, with a "最近错误" list in 任务中心.
7. **Coordinate the backlog**: identify owners and overlapping files before Phase 2. Do not commit, stash, revert or format another task’s changes. Pending unrelated files are not a blanket blocker; work on non-overlapping scope and request specific handoff only where necessary.

### Phase 5 — Documentation and repository shape (S)

1. `next-plan.md` becomes what its name says: current item, next two items, open decisions. Keep concise delivery summaries under `docs/deliveries/`; remove unused historical outputs and evidence under the approved cleanup scope rather than copying old external archives back into the repository. Preserve original data sources and current inputs.
2. `roadmap.md`: scope and decisions at the top, changelog removed or moved below.
3. Refresh `architecture.md` (page model, capability table, CZSC v22, package graph); remove superseded instructions and unused evidence, retaining only decisions needed to explain the current architecture and data-source references.
4. Move the WDZ block snapshot out of `docs/` to a data location (ignored directory with a hash manifest in git, or a separate data repository).
5. Package moves (`csi800-*`, `trading-strategy-core → tstdx`) belong to a separately reviewed Phase 2/3 engineering slice, not the one-day documentation estimate. Verify runtime versus type-only dependency and current experiment consumers before choosing the boundary.
6. Classify `dual_ma_strategy.py`, `__pycache__` and build artifacts by ownership, references and recoverability. Relocate or clean only authorized targets; root location or ignored status is not deletion authority.

## 5. What I would not do now

- **No rewrite of the panel cache or move to server components wholesale.** The app is a local desktop tool; client rendering is acceptable. Fix the state coupling, not the rendering model.
- **This proposal adds no new markets or strategies**; it does not revoke separately authorized work. The catalog already has 91 entries; the gap is trust in what runs, not breadth.
- **No performance work without a measurement.** The September plan measured and fixed the keep-alive and test-time problems; nothing I saw this time is a measured regression. Re-measure after Phase 2.
- **No full migration off the `records` table in one step.** Migrate by kind, hottest first.

## 6. 已确认的产品决策

2026-11-13 最新清理原则优先：项目不用的历史衍生结果、验证证据与日志直接清理；原始数据源及现行功能/测试依赖保留。以下保留数据的要求仅适用于仍使用的输入与用户业务记录，不要求留存已废弃的实验结果。

1. **恢复公式选股与双突破图表计算**，按完整调用链验证后开放。
2. **旧功能直接删除，由新流程替代，不考虑旧接口兼容**。删除旧页面、旧 API 与专用兼容分支；被新功能复用的计算模块保留。项目不再使用的历史数据与研究证据直接清理，不另建历史备份；保留数据源及现行功能/测试所需输入，不为旧数据保留整套旧功能。
3. **三个自动调度器先暂停**。本轮不恢复，不补跑、不补发消息；旧盘中手动入口也不顺带开放。
4. **数据库不预设必须迁移**。先收拢仓储契约，只有新增物理表等实际需要才设计 schema 迁移。SQLite 文件格式和应用 schema 版本分别处理，见 §10.2。
5. **WDZ 原始快照属于数据源，保留数据并迁出仓库跟踪范围**。先归档并核验，再移除已核验原始数据副本；仓库保留说明、manifest、哈希和恢复方法，不重写 Git 历史。

现有数字货币模拟交易与账户历史保持已有授权范围。具体完成状态以文首表格为准，清理完成不代表应用代码优化已完成。

## 7. 执行基线、顺序与范围（补全）

### 7.1 证据分级与已修正判断

§1–§3 保留最初诊断快照；以下按已实施代码更新，命令结果与验收对应关系见[当前交付](deliveries/2026-11-13-optimization.md)。

| 复核来源 | 当前事实 | 执行边界 |
| --- | --- | --- |
| [能力表](../src/lib/common/capabilities.ts)、[tRPC](../src/server/api/trpc.ts) | 280 个 API 显式声明能力和操作，旧名称黑名单与无消费者的旧生命周期目录已退役 | 读取/计算/配置/调度分别判定，worker 和直接服务也必须遵守暂停 |
| [选股路由](../src/server/api/routers/screening.ts) | 旧 screen API 已移除，formulaScreen 执行现行公式任务 | 不保留旧参数兼容或旧结果回退 |
| [策略路由](../src/server/api/routers/strategy.ts)、[图表](../src/components/market/chart.tsx) | 原生 CZSC 保持开放，旧 LLM 分析入口退役，双突破已恢复 | 现行计算通过隔离快照与应用流程验证，不发送通知或交易 |
| [路线图](roadmap.md)、[当前计划](next-plan.md) | 加密资产模拟交易及账户历史保持原授权范围 | 不扩展实盘、合约或外发权限 |
| [浏览器 runner](../scripts/run-browser-harness.mjs)、[P0 E2E](../playwright.p0.config.ts) | 组件浏览器测试与生产页面验收分别覆盖交互和真实 API/worker | 使用隔离数据与明确端口；测试通过不等于完整桌面或视觉验收 |
| [工程约定](conventions.md)、[package.json](../package.json) | lint 约定已校正、六包构建入口已统一 | 增量构建、检查门禁和规则扩充仍待 P4 |
| [WDZ 快照说明](data-sources/wdz-blocks/2026-11-07/README.md) | 2,319 原文件与哈希已预演，迁出待用户执行 | 保留原始数据，按 manifest 和精确目录操作，不按文件数量删除 |

“已实现规则”“当前可执行”“数据齐备”“通过真实业务验收”分别判断。策略目录的实现登记不自动授予旧 API 执行权限，暂停执行也不否定独立纯规则的存在。

### 7.2 可交付工作包与依赖

阶段编号保留，但不要求全部串行，也不把高风险数据迁移当作无验收的后台任务。实施状态以文首表格为准；下表定义各包的范围与退出条件。

| 工作包                 | 前置条件                        | 交付范围                                                                        | 验收门槛                                                            |
| ---------------------- | ------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| P0a 能力盘点与界面纠错 | 核对最新授权、重叠文件归属      | 十二操作、三调度器及新入口完整映射；删除旧入口与兼容路径；首页/图表停止无效请求 | 空库无预期内弃用报错；删除的 API 不可执行；数据源及当前所需输入不变 |
| P0b 经确认的能力恢复   | 恢复决定已确认；任务链复核      | 优先公式执行、双突破只读叠加；逐项恢复，单独交付                                | 正反例、完整任务链、数据口径与重复执行检查通过                      |
| P1 日常使用路径        | P0a；相关能力状态已确定         | 首页→行情→证券池/RPS→公式筛选；状态与单位统一                                   | 空库、fixture、错误态及 1440/1024 交互验收                          |
| P2a 状态解耦           | P1 明确页面归属；重叠改动已协调 | 先一个页面，再迁移其余页面；保留用户上下文                                      | 前进后退、刷新、任务切换、草稿、图表视图无回归                      |
| P2b 图表与包边界       | P2a 对应模块验收                | 图表职责拆分；必要时另立研究包边界子项                                          | 固定输入输出相同，原生进程串行约束不变                              |
| P3a 仓储契约与路径配置 | 先测量查询与载荷；盘点调用者    | 明确分页/遍历、事务和外部路径；可以不改 schema                                  | 超过 200 条不漏读；输入校验、路径诊断、查询结果一致                 |
| P3b 热数据迁移         | P3a；迁移设计和部署窗口确认     | 只迁移实测热点，独立版本与恢复演练                                              | 行数、ID、内容及历史报告一致；旧包拒绝高版本；恢复可验证            |
| P4 工程门禁与诊断      | 可从 P0a 同期开始               | 统一构建、失败日志、可复现检查；逐步加强 lint                                   | 干净/增量构建均可用，失败正确退出，日志脱敏且有容量上限             |
| P5 文档导航与收尾      | 随每包同步，最终集中检查        | 当前计划/历史交付分开；归属明确的产物清理                                       | 相对链接可达、历史可追溯、无擅自清理或提交                          |

原 S/M/L 是粗略工作量，不是日历承诺。Phase 0 的 1–4 天只适用于 P0a 与有限恢复；三个调度器全面恢复、历史重算、数据库迁移和研究包迁移分别估算，不塞入该上限。每包开始前记录当前差异、依赖、验证命令和具体退出条件；发现关键前置不成立时缩小该包，继续无依赖工作。

## 8. 能力契约与完整决策矩阵

### 8.1 十二操作及调度入口

以下按用户已确认的决定执行。旧功能不保留历史只读页面或兼容 API；不用的历史事实归档与证据直接清理，不保留兼容产品。现行功能仍在消费的记录先处理依赖；数据源和测试输入保留，保留记录仍按自身格式解释。

| 入口                                                                    | 已定处理                               | 验收 / 新流程                                                                        |
| ----------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `formulaScreen`                                                         | 恢复计算                               | 校验→保存→提交→任务状态→结果/导出完整闭环；公式因子与多周期 RPS 可用性按真实输入判断 |
| `screen`                                                                | 删除旧入口/API                         | 使用当前公式/因子筛选；移除旧调用者，不做旧参数转发                                  |
| `breakout`                                                              | 恢复只读图表计算                       | 行情快照、日线/图表快照分支、未完成 K 线口径验证；不创建信号通知或订单               |
| `backtest`                                                              | 删除旧 API/界面                        | 直接使用现行回测工作台与新引擎；旧结果不重新贴新模型标签                             |
| `walkForward`                                                           | 删除旧入口/API                         | 尚无已验证等价能力，不声称新回测覆盖滚动样本外验证，不为兼容另造实现                 |
| `strategyResearchCreate`、`strategyResearchRetry`                       | 删除旧新建/重试入口/API                | 新研究从现行策略中心发起；旧队列/重启不能恢复旧任务，原任务记录保留                  |
| `intradayRun`                                                           | 保持停用                               | 本轮不恢复旧手动入口，不因公式恢复联动开放                                           |
| `chanAnalyze`、`canslimAnalyze`、`wyckoffAnalyze`、`fundamentalAnalyze` | 删除旧面板/API                         | 使用现有新策略/证据流程；无等价流程则删除入口，不新建 LLM 兼容服务                   |
| signal monitor 调度                                                     | 维持当前停用，停止误导启用提示         | 恢复须验证订阅、去重、触发时间、重启与异常恢复                                       |
| signal ledger 调度                                                      | 维持当前停用，台账历史可查             | 与通知投递分开授权，确认补跑和幂等策略                                               |
| intraday 调度                                                           | 维持当前停用，取消“设置即可生效”的文案 | 手动能力先验收，再确认交易日/时区/错过时段/重复启动策略                              |

补充回归对象：`czsc`/`czscSchema` 保持现状；新策略引擎与现有模拟交易不受旧操作名误伤。恢复任一任务前搜索服务函数、worker、CLI、重试和开机恢复等调用路径，不能只删 tRPC 黑名单。

### 8.2 表的职责与服务端保护

建议以稳定 capability ID 描述现行能力：`id`、状态（active/paused）、允许操作（读取/计算/新建任务/调度）、原因码、规则版本。被删除的旧能力只进入迁移清单，不为它们保留运行时兼容注册；操作通过显式元数据或完整路由映射绑定能力，避免用末级同名字符串误伤其他模块。

运行就绪度另行求值：数据缺失、DLL 不可用、凭证未配置、非交易时段、用户未启用订阅，不得与能力停用混淆。前端只取得可公开的状态投影，不把服务端模块或凭证打进客户端。服务端是执行判定权威，导航隐藏不能代替保护。未知的新执行入口必须声明能力，否则契约测试失败。

验证至少包括：

- 十二操作的恢复/删除/暂停都有明确结果，query/mutation/scheduler 均覆盖；删除 API 的直接调用不能启动工作，保留的历史读取不被误封。
- 页面不发起已知不可用的自动请求，暂停控件说明原因；已删除功能不留下禁用按钮，旧客户端不提供兼容执行。
- `czsc` 与 `chanAnalyze`、`screen` 与 `formulaScreen`、旧回测与新引擎分别测试，防止同名规则联动开禁。
- 公式走到结果页并能重开历史任务；缺数据、非法公式、失败和取消有可观察结果。
- 调度器用假时钟和本地 stub 验证启停、幂等与重启；不通过真实通知或交易来验收 UI。

## 9. 产品流程、状态和前端验收

### 9.1 日常路径与页面职责

首页显示数据准备状态与一个首要下一步；证券池/RPS 负责找标的；行情负责看图和选中标的；财务作为该标的的子视图；筛选负责条件编辑、运行及结果；策略中心负责实现/输入/执行能力展示；现行任务中心与报告页保持直接访问；删除旧模块专用入口。

拆 `/market` 前列出当前 URL 参数和跳转来源，迁移证券、周期、数据源、复权和筛选上下文。证券池选股后进图表，返回仍保留排序/筛选/分页；不能只缩短页面却让用户重做选择。删除的旧书签可正常返回不存在；仍有效的现行链接不能落到空壳页，不增加旧路由重定向兼容。新增路线名在实施时查现有路由确定，不凭文档另造重复入口。

状态显示分两轴：能力状态（可用/暂停）和任务状态（未开始/等待条件/排队/执行中/成功/失败/已取消）。过期数据显示时间与来源，不显示为最新；部分完成标明成功和失败数量。红色用于真实错误，不因“全页不能有红色”掩盖网络、解析或任务失败。

数值格式先建字段契约：来源字段、原始单位、转换规则、展示精度、缺失语义。`0.119` 若是无量纲占比则为 `11.90%`；`1.9595` 若源字段已经是百分数则显示约 `1.96%`，若为小数收益率才是 `195.95%`，不能凭数值猜测。成交量区分股/手/张/份；金额注明元/万元/亿元；价格按品种精度；null 显示缺失原因，零值正常展示。导出保留明确单位及原始精度，排序使用数值。

### 9.2 状态归属与页面模型

服务器查询结果交给现有 query cache；可分享的选择放 URL；需要跨页保留的草稿/图表视图放具名 store；临时展开项留组件内部。避免把所有数据从一个大 hook 搬到一个大 Zustand store。持久草稿需 schema 版本和来源身份，不能跨证券/账户污染。

优先常规路由承载页面、显式保存必要状态。是否保留局部 panel cache 用真实切换成本决定；进入/离开、淘汰、重新挂载、错误恢复和任务后台运行规则必须明确。切页不取消已提交的服务端任务；非活跃页面停掉不必要轮询，返回可恢复状态。图表销毁必须释放订阅、observer 和 worker 引用；不破坏单进程串行 DLL 边界。

### 9.3 验收场景

| 场景           | 具体检查                                                                               |
| -------------- | -------------------------------------------------------------------------------------- |
| 空库首启       | 数据连接→扫描/加载→计算提示合理；无“未计算=失败”；未启用能力不自动发请求               |
| 固定合成数据   | 首页→RPS→选股→图表→财务→返回，选择与数据口径一致                                       |
| 公式闭环       | 编辑/校验/保存/执行/结果/导出；返回和刷新不丢已保存内容                                |
| 历史清理       | 不用的历史衍生结果与截图已移除，数据源/必要 fixture 不变；现行引用不悬空，旧任务不重启 |
| 故障与恢复     | 数据源缺失、DLL 加载失败、超时、服务重启、任务失败均有可定位原因                       |
| 窗口与可访问性 | 1440×900、1024×768；键盘、焦点、tooltip、缩放、弹层及窄窗口无关键操作遮挡              |
| 状态隔离       | 编辑筛选不触发无关请求；切图表证券不污染另一页面草稿；前进/后退正常                    |

图表占首屏 60% 是设计目标，不能牺牲坐标/图例/控件可读性。视觉基线仅保留稳定 fixture 的代表页面截图；全路由做可达性与关键状态检查，动态数据和光标等做遮罩。记录浏览器、DPR、字体与固定时钟，避免把每次临时截图变成长久档案。性能沿用现有预算，测相同数据/机器的首屏、交互、切页、内存及请求数；先测后定新增阈值，不以代码行数或“零 rerender”代替收益。

## 10. 数据层与迁移恢复方案

### 10.1 先建立契约，再决定物理表

先盘点 kind 的读写量、payload 大小、查询计划、慢查询与任务结果增长；原文的索引/行数统计只能帮助选候选，不能证明所有 JSON 存储都应迁移。优先 typed repository 收拢已迁移领域，保留小量配置的 records 存储，不做 74 类一次性改造。

每个仓储明确输入校验、事务归属、唯一性、排序及缺失行为。分页返回 `items`、`nextCursor`/`hasMore`；顺序有稳定唯一 tie-breaker。全量导出、监控订阅与历史重算使用有界批量迭代或冻结 ID 集，不能删除 limit 后一次载入全部。明确迭代期间并发新增/更新如何处理；验证 0、1、200、201、多页及边界更新，不漏项、不重复。列表只读摘要，任务大结果按需读取，限制单批载荷。

SQL 允许留在数据访问层，包括事务和专用查询实现；限制针对数据库连接及真实 SQL 调用，不能用 `prepare(` 文本匹配误杀其他对象。保护 MCP 文件的消费者只读盘点，需要改变其契约时先提出具体交接范围。

### 10.2 迁移门槛与恢复

**已核实的区别**：SQLite 文件格式兼容不代表旧应用理解新 schema。[当前迁移代码](../src/server/db/migrations.ts) 在 `user_version > migrations.length` 时明确抛出“数据库版本高于此应用版本，请使用较新的应用”；这里的 `user_version` 是应用维护的版本号，不是 SQLite 发布版本。仅重构仓储或新增配置字段不必当然升级 schema；确需迁移时采用新应用向前升级旧库，不维护旧 exe 兼容层，也不删除版本保护。用户对 SQLite 的判断不视为已接受生产库升级风险。

以下流程仅在实测需求证明必须修改 schema 时启用。建议多次可独立验证的迁移脚本集中在一次授权发布窗口交付；“批量发布”不意味着一条不可审查的巨型迁移，也不要求当前立即升级用户数据库。

1. 在隔离目录建立空库、旧版本 fixture 和历史大载荷样本，冻结版本、记录数、ID 集及关键内容摘要。不得复制或输出凭证；确需用户库副本时使用明确授权的脱敏方案。
2. 设计新表键、约束、索引及旧→新映射；历史事实保持原版本，无法解析的记录报告并阻断该迁移，不用默认值补造。
3. 离线迁移期间关闭相关写入进程；备份使用一致性快照或完整停机方案，不能运行中只拷贝 SQLite 主文件遗漏 WAL。记录备份位置、版本和校验信息。
4. 在事务内建表/拷贝/核对后提升 `user_version`；注入中途失败验证原库和版本完整。大数据若需分段则先明确恢复状态机和原子切换点，不静默改为部分成功。
5. 比对记录集合、业务字段、历史查询/导出、分页结果、索引计划和磁盘增长；重跑迁移不重复复制。新应用读取新表，不增加永久双写或旧接口转发层。
6. 验证旧 exe 对升级库明确拒绝，禁止降 `user_version`。升级失败恢复完整备份及匹配程序；成功升级后的新增写入不能靠覆盖旧备份安全撤销，须先隔离导出并制定恢复方案。
7. 正式执行前确认停机窗口、空间、可用备份、匹配新包和恢复负责人；无匹配包不升级用户库。打包/替换仍另需授权，应用运行中不替换 release。

外部路径配置在服务端解析和验证，说明不存在、无读取权限、解释器不可执行或格式不符等原因；环境变量/用户设置/可移植默认值的优先级明确。迁移已有有效设置，不自动扫描用户整盘。运行 Python 用可执行文件与参数数组，不拼接 shell；通达信与外部 Blocks 保持只读。日志不输出凭证。

## 11. 工程验证、诊断与交付

构建编排复用 workspace 的真实依赖图；先合并重复入口，再评估增量收益。冷构建、修改依赖包后构建、runtime worker 和桌面资源都要覆盖，不能只靠产物存在判断新旧。保留 native 编译及各包测试入口，不因统一脚本漏掉原有步骤。项目引用/缓存属于实测后的增强，不作为第一步必要条件。

错误诊断记录时间、任务/请求关联 ID、模块、阶段、错误码、重试次数及脱敏摘要；记录在当前 `QUANT_DATA_DIR` 下，轮转并限额。取消/正常关闭不当作异常；重复错误限频但保留次数和最近时间。任务中心能定位最近失败，日志写入失败不能递归报错或吞掉原故障；不得保存 key、token、认证头、webhook 或完整敏感请求体。无需给每个 catch 都写同一条日志，优先在负责恢复和用户反馈的边界记录。

| 变更类型          | 必要验证                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------- |
| 本次仅补全文档    | 内容、引用目标、Markdown 结构、diff 与修改范围检查                                          |
| 能力门禁/页面修正 | 相关 Vitest、typecheck；子任务完成 `pnpm test`；查询/突变/调度/历史读取行为检查             |
| 路由/图表/格式化  | 上述检查 + fixture 页面交互、视觉及数值测试；复用 `pnpm test:browser` / `pnpm e2e`          |
| 仓储/迁移         | 旧库升级、失败回滚、多页/并发边界与历史输出等价；不打开默认用户库                           |
| 有意义应用交付    | `pnpm build`；涉及 runtime 重建 worker；桌面交付 `pnpm desktop:prepare`，按实际环境做 smoke |
| 正式打包/发布     | 仅明确授权后执行；版本与数据库匹配，交付只使用 `release/win-unpacked`                       |

所有可能初始化数据库的命令在启动前设置隔离目录，单任务集中保存数据与日志。E2E 不盲目复用未知服务；核验进程、端口和 `QUANT_DATA_DIR`。不为验证开启真实调度、外发通知或交易所下单。区分代码测试、fixture 验收、真实数据只读核验和真实账户联调，不能用前者替代后者。既有 skip/format 基线先复测并说明归因，不把旧计数当永久豁免。

每包交付说明只保留：改了什么、验证命令及结果、未验证项、用户可见差异、数据库/包版本影响、确需保留和已清理的任务产物。失败写实际原因，不反复执行无效检查。清理结果与剩余依赖见文首状态及交付记录；本次临时工具目录已由用户执行脚本删除并复核。

## 12. 决策落实与实施顺序

| 已定事项                 | 实施结果要求                                       | 边界                                                                             |
| ------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| 恢复公式执行、双突破图表 | 完整计算链路通过并重新开放                         | 不联动通知、订单或旧选股策略                                                     |
| 旧功能由新流程替代       | 删除旧页面/面板/API/兼容调用，用户从新入口完成操作 | 清理不再使用的历史结果与证据，保留数据源；无等价能力的旧入口直接删除，不冒充覆盖 |
| 三个自动调度器暂停       | 页面显示暂停，服务不启动调度                       | 不改写订阅，不补跑、不补发                                                       |
| 数据库                   | 先做无需 schema 变化的仓储整理；按实际需要决定迁移 | SQLite 格式兼容不等于旧 exe 可理解新 schema；保留版本检查                        |
| WDZ 迁出                 | 原始快照迁出 docs/Git 当前跟踪范围                 | 原目录只读；归档核验后才移除副本，不重写历史                                     |

WDZ 迁出的具体完成条件：

1. 核对实际跟踪文件、日期快照、已有 manifest、消费者引用及修改归属；不用原调查的 2,363 总数直接作为删除清单。
2. 在仓库外的明确数据归档目录保存唯一正式归档，保留原目录结构、文件字节及来源说明；实际位置记录在交付中。原 `D:\wsWDZ\Blocks` 不移动、不修改。
3. 对照 manifest 校验全部文件数量、长度和 SHA-256；从归档恢复到任务临时目录后再次逐文件核验，确保新机器可按说明恢复。归档缺失或校验失败时停止移除源副本。
4. 仓库保留来源/使用范围说明、manifest、归档哈希、获取与恢复步骤，更新代码/测试/文档引用。需要长期保留的小型固定测试 fixture 与完整原始快照分开处理。
5. 核验绝对路径、目录链接及工作区差异，只移除已归档且归属明确的原始快照副本；不执行 `git rm --cached` 等隐含暂存操作，不改 Git 历史。清理本任务恢复验证的临时副本，保留一个正式归档。

首批实施由 **P0a + P0b** 组成：删除旧功能及兼容路径、恢复两个已确认能力、保持调度暂停；WDZ 归档迁出可作为独立交付项。数据库物理迁移不作为首批前置。功能选择已经确定，不重复索取选择；实际实施时先核对重叠修改归属及新入口覆盖，再运行规定检查。提交、正式打包及用户库升级按各自范围处理。

2026-11-13 用户追加：历史证据也不保留，清掉项目用不到的历史数据，保留数据源。历史保留条款不再作为清理阻碍；实际清理范围和结果见本次交付记录。代码恢复、旧功能删除和 WDZ 实际迁出仍是独立实施项。
