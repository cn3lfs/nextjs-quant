# 模块地图

截至 2026-09-23 的模块责任、入口、主要消费者、副作用与验证索引。它补充 [系统架构图](../architecture.md)：架构图说明端到端数据流，本目录说明各模块的维护边界。代码路径、路由名和测试名以仓库当前状态为依据；静态地图不证明任意运行时路径都已覆盖。

## 依赖方向

```text
src/app ──组装──> src/components ──调用──> src/trpc
    │                                      │
    └──────────────────────────────────────┴──> src/server/api ──> server 领域服务
src/components ──纯规则/类型──> src/lib ──> packages/trading-strategy-core
src/server ──纯规则/类型──> src/lib / packages；数据适配归 data-sources，持久化归各领域 store + db
electron ──启动/停止──> standalone Node 服务 ──加载──> runtime workers
```

这是依赖方向的维护目标和已观察的主要流向，不表示每条现有导入都已通过自动边界检查。`src/server/api/root.ts` 只合并按领域拆分的 router；procedure 名称与调用类型由契约测试固定。其他边界仍须结合实际消费者核对。

## 领域清单

| 模块             | 文档                                                        | 代码面                                                                                     | 主要入口/消费者                                  | 持久状态或外部效果                                           | 代表性验证                                                                                             |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 工作台与路由     | [workbench](workbench.md)                                   | `src/app/`、`src/components/workbench/`、`overview/`、`panels/`、`research-data-guide.tsx`、`common/ui-gallery.tsx` | Next 页面、工作台布局和页面面板                  | URL 与客户端查询状态；页面本身不拥有业务数据                 | `tests/workbench/workbench-refactor.test.ts`                                                                     |
| 共享 UI          | [shared-ui](shared-ui.md)                                   | `src/components/ui/`、`src/components/common/`、`src/lib/common/`                           | 所有领域页面与组件                                | 局部交互状态，无业务持久化                                   | `tests/engineering-validation/src-organization.test.ts`、`tests/engineering-validation/t2-page-density.test.ts` |
| 行情与图表       | [market-chart](market-chart.md)                             | `src/components/market/`、`src/lib/chart/`、`src/server/market/`、`charts/`                | 行情/图表页、市场 API、图表组件                  | 只读行情源；SQLite 图表视图和受限缓存                        | `tests/market-chart/chart/q1-chart.test.ts`、`tests/market-chart/market-source-selection.test.ts`                                      |
| 选股与 RPS       | [screening-rps](screening-rps.md)                           | `src/lib/formula/`、`screening/`、`src/server/screening/`                                  | RPS、筛选页、后台 worker                         | 任务、筛选结果及 RPS SQLite 表                               | `tests/screening-rps/rps/q2a-formula.test.ts`、`tests/screening-rps/rps/q2b-screening.test.ts`、`tests/screening-rps/rps/rps-worker.test.ts`                 |
| 策略与信号       | [strategy-signals](strategy-signals.md)                     | `src/server/strategies/`、`monitoring/`、`components/signals/`、`intraday/`、策略 packages | 策略研究、监控、全市场信号台账                   | 串行 CZSC worker、订阅任务、信号与投递 outbox                | `tests/strategy-signals/methods/chan/czsc.test.ts`、`tests/strategy-signals/monitoring/m4-monitor.test.ts`、`tests/strategy-signals/signals/signal-ledger-worker.test.ts`                 |
| 研究与回测       | [research-backtest](research-backtest.md)                   | `src/lib/research/`、`backtest/`、`src/server/research/`、`backtest/`                      | 研究/回测页面、研究任务与 workers                | 研究快照、任务和报告；可能调用数据源或 LLM                   | `tests/research-backtest/research-worker.test.ts`、`tests/research-backtest/backtest/backtest-actions.test.ts`、`tests/research-backtest/backtest/daily-performance.test.ts`   |
| 组合与交易账本   | [portfolio-ledger](portfolio-ledger.md)                     | `src/lib/portfolio/`、`src/server/portfolio/`、`components/portfolio/`、账本页面           | 手工成交、交割导入、信号台账与交易复盘           | SQLite 成交、现金流、账本、分红和导入批次                    | `tests/portfolio-ledger/p1-trade-ledger.test.ts`、`tests/portfolio-ledger/trade-review-service.test.ts`、`tests/research-backtest/delivery-store.test.ts`  |
| 新闻与 CLS       | [news-cls](news-cls.md)                                     | `src/components/news/`、`src/server/news/`、`src/lib/news/`                                | 新闻/CLS 页面、定时复盘和新闻 API                | 原始/派生新闻报告、预算、调度记录；可能调用模型              | `tests/news-cls/cls-review-integration.test.ts`、`tests/news-cls/news-analysis.test.ts`、`tests/news-cls/news-scheduler.test.ts`  |
| 数据源适配       | [data-sources](data-sources.md)                             | `src/components/data-sources/`、`src/server/data-sources/`、`packages/tstdx/`、`vendor/czsc/` | 行情、研究、筛选、新闻、策略服务                 | 只读本地源；供应商网络请求；DLL 由专用队列使用               | `tests/market-chart/market-data/tdx-daily-cache.test.ts`、`tests/data-sources/data-source-acceptance.test.ts`、`tests/market-chart/market-data/tstdx-adapter.test.ts` |
| 持久化与基础设施 | [persistence-infrastructure](persistence-infrastructure.md) | `src/server/db/`、`infra/`、各域 store、`vault.ts`                                         | 所有需要持久状态的服务                           | `QUANT_DATA_DIR` 下 SQLite、DPAPI 凭证、进程内协调与通知队列 | `tests/persistence-infrastructure/core.test.ts`、`tests/persistence-infrastructure/integration.test.ts`、`tests/persistence-infrastructure/jobs.test.ts`                                |
| API 与后台运行时 | [api-runtime](api-runtime.md)                               | `src/server/api/routers/`、`root.ts`、`src/trpc/`、`src/app/api/`、jobs、runtime、workers  | 浏览器/RSC tRPC caller、健康检查、调度器         | SQLite 任务/状态、worker 子进程、通知 outbox                 | `tests/api-runtime/api-router-contract.test.ts`、`tests/engineering-validation/server-layout.test.ts`、`tests/engineering-validation/worker-pool.test.ts`        |
| 桌面与构建交付   | [desktop-build](desktop-build.md)                           | `electron/`、`desktop/`、`runtime/`、构建脚本                                              | `pnpm build`、`desktop:prepare`、Electron 主进程 | standalone/runtime 产物、子进程、用户数据目录和日志          | `tests/desktop-build/t4-desktop-guards.test.ts`、`pnpm desktop:smoke`                                                |
| 工程工具与验证   | [engineering-validation](engineering-validation.md)         | `scripts/`、`tests/`、配置、workspace packages                                             | 开发者与 CI/本地验收命令                         | 临时隔离数据；脚本可能构建或读本地数据，逐项查阅             | `tests/engineering-validation/src-organization.test.ts`、`tests/engineering-validation/server-layout.test.ts`、`pnpm test`                           |

## 维护约定

- 页面/路由文档说明入口和交互，不复制业务服务实现细节。
- 领域文档至少维护职责、入口/消费者、输入输出契约、依赖方向、持久化/外部效果、不变量/验证和代码放置规则。
- 模块内状态由模块服务/store 所有；跨域组装放明确入口。确需反向依赖或共享状态时，在对应文档写明例外和原因。
- `src/lib/` 根部只保留 `domain.ts`、`indicators.ts`、`money.ts`、`completed-bars.ts` 四个稳定共享契约/核心模块；新规则必须进入具名领域目录。
- 测试按业务模块归档到 `tests/<module>/`，跨域结构与工程检查位于 `tests/engineering-validation/`；共享 fixtures、helpers 和 setup 留在测试根目录。表中只列代表性保护用例，并非覆盖完整清单。
- 数据源、DLL、SQLite、worker、打包与 MCP 保护路径的完整约束以 [不变量](../invariants.md)、[操作说明](../operations.md) 和 [路线图](../roadmap.md) 为准。

## 盘点边界与待完成核查

- 已核实静态目录、App Router 页面、tRPC procedure 名称、主要 worker 构建入口及根级结构护栏。
- tRPC 目前有 186 个顶层 procedure，按领域位于 `src/server/api/routers/`；`root.ts` 是扁平合并组合根。`tests/api-runtime/api-router-contract.test.ts` 固定 procedure 名称和 query/mutation 类型。
- worker 构建清单以 `scripts/build-runtime.mjs` 为准；生成到 `runtime/` 的 tracked 文件并非源码归属依据。
- 此轮未声称字符串拼接路径、所有 `import()`/`require()`、第三方 Electron 行为或每个脚本的数据副作用均已穷尽。具体迁移前需对相关目标执行路径级复核。
- `src/server/mcp.ts` 和相关 UI 文案由用户维护，不在当前重构触碰范围；已有 server 分域也不重复搬迁。
