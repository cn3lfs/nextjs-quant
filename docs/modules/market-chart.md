# 行情与图表

## 职责与非职责

行情域组织证券、证券池、日历、行情来源选择和通用行情读取；图表域把行情与指标呈现为 K 线、周期聚合、策略证据、视图设置和画线。行情供应商协议归 [数据源适配](data-sources.md)，指标核心实现归 `trading-strategy-core`，不在图表组件复制。

## 入口与消费者

- UI：`src/app/market/page.tsx`、`src/components/market/`；证券与交易账本复盘也会消费行情能力。
- 应用层：`src/server/market/`、`src/server/charts/`；API procedure 有 `chartPosition`、`chartBars`、`chartView`、`saveChartView`、`tdxQuotes`、`tdxBars`、`tdxMinutes` 等，当前装配在 `src/server/api/root.ts`。
- 纯计算/契约：`src/lib/market/`、`src/lib/chart/`；主要入口包括 [chart-data.ts](../../src/lib/chart/chart-data.ts)、[chart-view.ts](../../src/lib/chart/chart-view.ts)、[chart-symbol.ts](../../src/lib/chart/chart-symbol.ts) 和 [chart-drawings.ts](../../src/lib/chart/chart-drawings.ts)。图表消费的指标实现见 `packages/trading-strategy-core/src/indicators.ts`。

## 契约与依赖

输入包括证券、周期、行情来源和可选复权/显示状态；输出保留数据日期、来源、覆盖和缺失语义。周/月图由日线聚合，不新增策略周期；主策略路径维持不复权，复权必须显式标识。SQLite `chart_views` 以证券×周期保存用户视图。

方向为 UI → API → market/chart service → data-source；纯规则依赖 `src/lib`/core，供应商适配不依赖策略或回测编排。

## 状态、副作用与验证

本地 TDX/Blocks 源只读；外部市场源按调用产生网络请求；图表设置和缓存写入应用 SQLite/进程内缓存。快照用例由 [snapshot.ts](../../src/server/market/snapshot.ts) 承担，runtime 负责调度。关键约束见 [invariants §1–2](../invariants.md#1-指标只有一个实现入口) 与 [architecture 图表/数据章节](../architecture.md)。代表测试：[q1-chart](../../tests/market-chart/chart/q1-chart.test.ts)、[chart-data](../../tests/market-chart/chart/chart-data.test.ts)、[market-source-selection](../../tests/market-chart/market-source-selection.test.ts)、[weekly-bars](../../tests/market-chart/market-data/weekly-bars.test.ts)。

## 维护指南

新增来源先加到数据源适配并定义失败/时效语义；新增展示或图表交互放对应 market/chart 层；改变周期、复权、null 或成本线语义时同步更新不变量文档和固定输入测试。
