# 模块地图

截至 2026-11-25 的模块责任、入口、主要消费者、副作用与验证索引，以 `master@d73c2534`（`v0.3.0 / SQLite v25`）为基线。端到端数据流见[系统架构图](../architecture.md)，下一轮接缝收口见 [Iteration 5 实施计划](../project/2026-11-25-iter5-v040-plan.md)。

## 依赖方向

```text
src/app ──组装──> src/components ──调用──> src/trpc
    │                                      │
    └──────────────────────────────────────┴──> src/server/api ──> server 领域服务
src/components ──纯规则/类型──> src/lib ──> packages/trading-strategy-core
src/server ──纯规则/类型──> src/lib / packages；数据适配归 data-sources，持久化归db 类型仓储
electron ──启动/停止──> standalone Node 服务 ──加载──> runtime workers
```

这是依赖方向的维护目标和已观察的主要流向，不表示每条现有导入都已通过自动边界检查。`src/server/api/root.ts` 只合并按领域拆分的 router；域 router 是 procedure 的注册来源，契约测试验证平面装配、调用类型和能力声明。其他边界仍须结合实际消费者核对。

## 领域清单

2026-11-08新增独立绩效评价模块：[quant-performance](../../packages/quant-performance/README.md)负责指标、回撤和年季月报告；`src/server/performance`负责冻结输入适配，`src/components/performance`负责纯展示。回测、评价包互不依赖，评价在账户/撮合事务外只读派生。公共接口、无副作用和独立验收见包说明及[规格](../product/specs/backtest-evaluation.md)。

| 模块             | 文档                                                        | 代码面                                                                                                              | 主要入口/消费者                                  | 持久状态或外部效果                                           | 代表性验证                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作台与路由     | [workbench](workbench.md)                                   | `src/app/`、`src/components/workbench/`、`overview/`、`panels/`、`research-data-guide.tsx`、`common/ui-gallery.tsx` | Next 页面、工作台布局和页面面板                  | URL 与客户端查询状态；页面本身不拥有业务数据                 | `tests/workbench/workbench-refactor.test.ts`                                                                                                                                           |
| 共享 UI          | [shared-ui](shared-ui.md)                                   | `src/components/ui/`、`src/components/common/`、`src/lib/common/`                                                   | 所有领域页面与组件                               | 局部交互状态，无业务持久化                                   | `tests/engineering-validation/dependency-check.test.ts`、`tests/browser/market-toolbar-browser.mjs`                                                                                    |
| 行情与图表       | [market-chart](market-chart.md)                             | `src/components/market/`、`src/lib/chart/`、`src/server/market/`、`charts/`                                         | 行情/图表页、市场 API、图表组件                  | 只读行情源；SQLite 图表视图和受限缓存                        | `tests/market-chart/chart/q1-chart.test.ts`、`tests/market-chart/market-source-selection.test.ts`                                                                                      |
| 选股与 RPS       | [screening-rps](screening-rps.md)                           | `packages/trading-strategies/src/formula/`、`screening/`、`src/server/screening/`                                   | RPS、筛选页、后台 worker                         | 任务、筛选结果及 RPS SQLite 表                               | `tests/screening-rps/rps/q2a-formula.test.ts`、`tests/screening-rps/rps/q2b-screening.test.ts`、`tests/screening-rps/rps/rps-worker.test.ts`                                           |
| 策略与信号       | [strategy-signals](strategy-signals.md)                     | `src/server/strategies/`、`monitoring/`、`components/signals/`、`intraday/`、策略 packages                          | 策略研究、监控、全市场信号台账                   | 串行 CZSC worker、订阅任务、信号与投递 outbox                | `tests/strategy-signals/methods/chan/czsc.test.ts`、`tests/strategy-signals/monitoring/m4-monitor.test.ts`、`tests/strategy-signals/signals/signal-ledger-worker.test.ts`              |
| 研究与回测       | [research-backtest](research-backtest.md)                   | `src/lib/research/`、`backtest/`、`src/server/research/`、`backtest/`                                               | 研究/回测页面、研究任务与 workers                | 研究快照、任务和报告；可能调用数据源或 LLM                   | `tests/research-backtest/backtest/ma-baseline-work.test.ts`、`tests/research-backtest/backtest/backtest-actions.test.ts`、`tests/research-backtest/backtest/daily-performance.test.ts` |
| 组合与交易账本   | [portfolio-ledger](portfolio-ledger.md)                     | `src/lib/portfolio/`、`src/server/portfolio/`、`components/portfolio/`、账本页面                                    | 手工成交、交割导入、信号台账与交易复盘           | SQLite 成交、现金流、账本、分红和导入批次                    | `tests/portfolio-ledger/p1-trade-ledger.test.ts`、`tests/portfolio-ledger/trade-review-service.test.ts`、`tests/research-backtest/delivery-store.test.ts`                              |
| 新闻与 CLS       | [news-cls](news-cls.md)                                     | `src/components/news/`、`src/server/news/`、`src/lib/news/`                                                         | 新闻/CLS 页面、定时复盘和新闻 API                | 原始/派生新闻报告、预算、调度记录；可能调用模型              | `tests/news-cls/cls-review-integration.test.ts`、`tests/news-cls/news-analysis.test.ts`、`tests/news-cls/news-scheduler.test.ts`                                                       |
| 数据源适配       | [data-sources](data-sources.md)                             | `src/components/data-sources/`、`src/server/data-sources/`、`packages/tstdx/`、`vendor/czsc/`、`vendor/thsdk/`                       | 行情、研究、筛选、新闻、策略服务                 | 只读本地源；供应商网络请求；DLL 由专用队列使用               | `tests/market-chart/market-data/tdx-daily-cache.test.ts`、`tests/data-sources/data-source-acceptance.test.ts`、`tests/market-chart/market-data/tstdx-adapter.test.ts`、`tests/desktop-build/thsdk-package.test.ts`                  |
| 持久化与基础设施 | [persistence-infrastructure](persistence-infrastructure.md) | `src/server/db/`、`infra/`、`vault.ts`                                                                              | 所有需要持久状态的服务                           | `QUANT_DATA_DIR` 下 SQLite、DPAPI 凭证、进程内协调与通知队列 | `tests/persistence-infrastructure/core.test.ts`、`tests/persistence-infrastructure/integration.test.ts`、`tests/persistence-infrastructure/jobs.test.ts`                               |
| API 与后台运行时 | [api-runtime](api-runtime.md)                               | `src/server/api/routers/`、`root.ts`、`src/trpc/`、`src/app/api/`、jobs、runtime、workers                           | 浏览器/RSC tRPC caller、健康检查、调度器         | SQLite 任务/状态、worker 子进程、通知 outbox                 | `tests/api-runtime/api-router-contract.test.ts`、`tests/api-runtime/runtime-error-boundaries.test.ts`、`tests/engineering-validation/worker-pool.test.ts`                              |
| 桌面与构建交付   | [desktop-build](desktop-build.md)                           | `electron/`、`desktop/`、`runtime/`、构建脚本                                                                       | `pnpm build`、`desktop:prepare`、Electron 主进程 | standalone/runtime 产物、子进程、用户数据目录和日志          | `tests/desktop-build/t4-desktop-guards.test.ts`、`pnpm desktop:smoke`                                                                                                                  |
| 工程工具与验证   | [engineering-validation](engineering-validation.md)         | `scripts/`、`tests/`、配置、workspace packages                                                                      | 开发者与 CI/本地验收命令                         | 临时隔离数据；脚本可能构建或读本地数据，逐项查阅             | `tests/engineering-validation/dependency-check.test.ts`、`tests/engineering-validation/sqlite-repository-boundary.test.ts`、`pnpm test`                                                             |

## v0.3.0 跨模块入口与测试归属

| 能力 | 主要所有者与边界 | 入口与代表性验证 |
| --- | --- | --- |
| 统一策略流水线 | [流水线仓储](../../src/server/db/pipeline-repository.ts) 持有部署、运行、意图、审计与候选池。策略域 [调度器](../../src/server/pipeline/pipeline-scheduler.ts) 编排候选与信号，执行域 [执行器](../../src/server/execution/pipeline-executor.ts) 推进意图，[场所路由](../../src/server/execution/venue-router.ts) 装配本地、同花顺和数字货币适配。 | 策略运行台 `/?tab=pipeline` 与 [pipeline router](../../src/server/api/routers/pipeline.ts)。[调度回归](../../tests/pipeline/pipeline-scheduler.test.ts)、[执行幂等](../../tests/pipeline/execution-idempotency.test.ts)、[运行台流程](../../tests/pipeline/pipeline-ui-flow.test.ts)。 |
| 四通道平行账户 | 组合与交易账本域。[平行账户容器](../../src/components/portfolio/parallel-accounts-hub.tsx) 组装本地模拟、同花顺模拟、同花顺实盘只读桥接、期货模拟。各通道分别由本地账本、模拟场所、DPAPI 凭证约束下的只读服务和期货轻账本持有事实。 | `/accounts?tab=paper`。[同花顺平行账户](../../tests/portfolio-ledger/ths-parallel-accounts.test.ts)、[本地模拟引擎](../../tests/portfolio-ledger/sim-account-engine.test.ts)、[期货模拟服务](../../tests/portfolio-ledger/futures-sim-service.test.ts)。 |
| 三市场看盘下单 | 行情与图表域拥有 [ChartSimOrderDialog](../../src/components/market/chart-sim-order-dialog.tsx) 和两步预览确认。组合域接收 A 股本地／同花顺模拟、数字货币 USDT 现货模拟、期货双向保证金开平仓的提交。 | 三市场看盘工具栏。[下单规格](../market-chart/2026-11-25-chart-direct-sim-order-spec.md)、[弹窗回归](../../tests/market-chart/chart-sim-order-dialog.test.ts)。 |
| CLS WebView | 新闻域拥有 [搜索 URL](../../src/lib/news/cls-search-url.ts) 与 [图表新闻面板](../../src/components/news/intel-annotations.tsx)，图表传递标的上下文，Electron 宿主校验 WebView 的域名和隔离设置。浏览器提供降级入口。 | A 股看盘「图表新闻事件」。[新闻面板回归](../../tests/market-chart/news/cls-webview-panel.test.ts)、[桌面启动](../../tests/desktop-build/desktop-startup.test.ts)。 |
| 申万板块估值 | 财务数据域 [申万估值适配](../../src/server/financial/sw-sector-valuation.ts) 读取 `westock-data` 的一、二级行业估值，管理批次与缓存。行情域 [估值视图](../../src/components/market/sector-valuation-view.tsx) 展示 PE-TTM、PB-LF、股息率和分位。 | `/scan?tab=valuation`。[估值适配回归](../../tests/market-chart/sw-sector-valuation.test.ts)、[估值浏览器场景](../../tests/browser/sector-valuation-browser.mjs)。 |
| 冻结市场面板 | 行情域 [MarketPanelStore](../../src/server/market/market-panel/index.ts) 拥有只读列式快照及写入发布约束，[市场面板任务服务](../../src/server/market/market-panel-job.ts) 提交与查询构建，通用 worker 执行 `market-panel-build`。 | `marketPanelStatus` / `marketPanelBuild` 接入今日市场温度和 30 行业轮动卡片，快照亦供 Alpha 研究。[快照构建与一致性](../../tests/market-data/market-panel.test.ts)、[温度与行业轮动](../../tests/workbench/market-temperature-rrg.test.ts)。 |

## 维护约定

- 页面/路由文档说明入口和交互，不复制业务服务实现细节。
- 领域文档至少维护职责、入口/消费者、输入输出契约、依赖方向、持久化/外部效果、不变量/验证和代码放置规则。
- 模块内状态由模块服务/store 所有；跨域组装放明确入口。确需反向依赖或共享状态时，在对应文档写明例外和原因。
- `src/lib/` 根部当前有 `domain.ts`、`indicators.ts`、`money.ts`、`completed-bars.ts` 等稳定共享契约与核心模块；有明确职责、被多个领域消费的契约可以新增，纯领域规则放具名目录。
- 测试按业务模块归档到 `tests/<module>/`，跨域结构与工程检查位于 `tests/engineering-validation/`；共享输入、造数、辅助、测量和人工脚本分别放 fixtures、fixtures/seed、helpers、perf、manual，根部只保留全局 setup 与说明。表中只列代表性保护用例，并非覆盖完整清单。
- 模块内的交付、核对、任务书和复盘按 `docs/<模块>/YYYY-MM-DD-<主题>.md` 直接存放，结项后留在原位；跨模块记录放 `docs/project/`，不设月份层或历史归档树。
- 数据源、DLL、SQLite、worker、打包与 MCP 保护路径的完整约束以 [不变量](../invariants.md)、[操作说明](../operations.md) 和 [路线图](../roadmap.md) 为准。

## 盘点边界与待完成核查

- 已核实静态目录、App Router 页面、tRPC procedure 名称、主要 worker 构建入口及根级结构护栏。
- tRPC procedure 按领域位于 `src/server/api/routers/`；`root.ts` 是扁平合并组合根。`tests/api-runtime/api-router-contract.test.ts` 验证域 router 的平面装配、跨域重名和关键 wire path 及 query/mutation 类型。
- worker 构建清单以 `scripts/build-runtime.mjs` 为准；生成到 `runtime/` 的 tracked 文件并非源码归属依据。
- 此轮未声称字符串拼接路径、所有 `import()`/`require()`、第三方 Electron 行为或每个脚本的数据副作用均已穷尽。具体迁移前需对相关目标执行路径级复核。
- `src/server/mcp.ts` 和相关 UI 文案由用户维护，未经明确交接不修改、不回退、不纳入提交。

## 数字货币自动交易

`src/server/crypto-trading` 独立拥有模拟交易账户、订单意图、成交和持仓投影。`trading-strategies/crypto-dual-ma` 为纯信号；交易所实现统一 SpotAdapter。入口为 `/crypto` 与 `cryptoTradingRouter`，后台由 runtime 10秒调度，账户隔离为平台+环境。规格与恢复见[现货模拟交易架构](../product/specs/crypto-auto-trading.md)。旧手动交易API已退休，历史记录不改写。

数字货币账户只读模型见[账户持仓与成交](../product/specs/crypto-account-history.md)：`crypto-trading/account-service.ts` 与 `db/account-store.ts` 负责平台余额快照、独立账户成交副本与SQL分页，按账户/凭证版本隔离，不参与策略持仓投影或下单。
