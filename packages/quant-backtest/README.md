# quant-backtest

0.4.0将离线日线研究扩展为39项固定规则及2项持有对照，不再限制五种。目录`studyCatalog`声明流派/完整规则，`studyWarmup`声明140/300日预热，`studyCoverageGaps`列出不能用单股日线验证的主流流派。`--suite mainstream`运行全部，`--suite classic`保留原七项。参见[扩展规格](../../docs/product/specs/mainstream-strategies-maotai.md)。纯核心不注册应用策略、IO或实盘。

独立、无 IO 的 TypeScript 现金权益回测包。当前支持五分钟双均线交叉基线和模块化技术因子组合；应用内其他历史策略统一弃用。包本身不依赖 Next.js、React、数据库、通达信目录、worker 或本项目的 `src/`。

0.3.0新增`runClassicStudy`离线日线实验：五类固定策略（双均线、通道突破、趋势回调、布林均值回归、底仓网格）及两项持有基准，复用共享指标、十进制金额和原有成交/整手原语。它独立于原五分钟`runBacktest`契约，不自动注册应用策略。主板10%限制、用户固定费用、分红隔离经济权益等假设与风险见[研究规格](../../docs/product/specs/classic-strategies-maotai.md)。取数冻结和报告由`scripts/backtest-maotai-classics.ts`及`scripts/export-classic-study.ts`负责；包内仍无IO或前端依赖。

`factorStrategySchema` 定义入场/退出的 all/any 条件，支持数值比较和上下穿；左右因子、参数及常数经过验证和默认值归一。`factorStrategySignals` 只生成信号，退出优先，缺失不触发；`runStrategyExperiment` 将可选组合策略接到同一现金权益规则上，不传 strategy 时完全沿用 `runMaBaseline`。`strategyExperimentWarmup` 声明实际预热，应用负责按交易日历验证。来源、公开库覆盖、五分钟迁移和缺失规则见[规格](../../docs/product/specs/modular-factors.md)。

## 设计参照与当前边界

采用 [Backtrader 的订单时序](https://www.backtrader.com/docu/order-creation-execution/order-creation-execution/)：本根完成之后生成的市价请求，最早在下一根开盘执行，不使用本根已过去的 open。参考 [NautilusTrader 的事件驱动回放](https://nautilustrader.io/docs/latest/concepts/backtesting/)划分策略、执行、账户和统计；借鉴 [VectorBT](https://vectorbt.dev/api/portfolio/base/)预先计算数组、按时间顺序模拟的路径。

这是职责与时序的参照，不是对应 Python API 的兼容移植，不承诺与其默认费用、成交或绩效数字完全相同。本阶段不引入插件容器、实盘接入、做空、期货保证金、多证券共享资金或原生后端。新策略必须先证明因果性，再由应用决定是否开放；传入任意外部信号数组不会自动证明不存在未来信息。

## 模块与数据流

```mermaid
flowchart LR
    App[应用数据适配与冻结] --> Feed[data-feed 校验]
    Feed --> Strategy[strategies 信号数组]
    Feed --> Engine[engine 时间推进与订单状态]
    Strategy --> Engine
    Engine --> Execution[execution 成交与数量约束]
    Execution --> Account[account 费用与持仓记账]
    Account --> Analyzer[analyzers 净值与回撤]
    Analyzer --> Result[结构化结果]
```

| 模块                     | 负责                                         | 修改规则时看这里                   |
| ------------------------ | -------------------------------------------- | ---------------------------------- |
| `model.ts`               | 输入 schema、订单、成交、信号与账户类型      | 跨边界契约、字段与单位             |
| `data-feed.ts`           | 只读、升序五分钟行情校验，预热，右端时间换算 | 时段和时间戳                       |
| `strategies/ma-cross.ts` | 仅使用完成行情产生 `-1/0/1` 信号             | 双均线参数、交叉定义               |
| `engine.ts`              | 推进时间、待执行/成交/拒绝状态、退出优先级   | 订单寿命与动作顺序                 |
| `execution.ts`           | 成交价、滑点、申报数量、约束拒绝             | 涨跌停、一字/无量过滤、整手        |
| `costs.ts`               | 固定实验费用契约                             | 佣金、最低佣金、卖出费用、滑点参数 |
| `account.ts`             | 仅成交后更新现金、股数与买入日，T+1 可卖判断 | 资金和持仓账务                     |
| `analyzers.ts`           | 逐根回撤、日末净值、相对期初资金收益         | 绩效口径                           |
| `ma-baseline.ts`         | 组合当前主板实验规则与双均线                 | 默认兼容基线入口                   |
| `strategies/factor-strategy.ts` | 参数验证、条件组合、退出优先、因果信号 | 因子条件 schema 与信号规则 |
| `strategy-experiment.ts` | 将可选因子策略接到同一回放引擎 | 应用当前实验入口与预热声明 |

指标与十进制金额继续依赖 `trading-strategy-core`，不复制 MA 或资金原语。原应用 `research-execution` / `backtest-costs` 改为兼容再导出；历史研究仍使用同一份成交/数量算法。

## 订单与账户约定

每根：执行此前待执行请求 → 读取本根已完成信号 → 登记下一根请求 → 收盘估值。只做多、不加仓；重复入场不扩大持仓。买入在下一根无法成交或资金不足时拒绝，不无限追单；退出受 T+1、停牌/一字等限制时保留，后续入场不能覆盖待退出请求。

`signalAt` 是信号确认时刻；`barEnd` 是成交所在五分钟的右端时刻；`executedAt` 是该区间开盘时刻。例如信号 11:30 后的下一根 13:05，其成交时间是 13:00；15:00 信号只能等下一交易日的首根。窗口末尾请求保留为 pending，持仓估值，不强制卖出。

佣金为 `max(成交额×费率, 最低佣金)`，卖出费用另加；按真实成交股数记账，不借款。价格与费用来自显式配置，账户用共享十进制金额工具。收益分母为期初本金，逐根最大回撤包含初始本金；日末曲线不冒充逐根回撤路径。

当前基线仅沪深主板 A 股、100 股整手、T+1。不根据代码猜历史 ST/IPO 状态、涨跌停幅度或成交容量。`execution` 接受有依据的价格限制，当前应用缺少完整历史状态，因此始终标记 `rule-check-only`。OHLCV 过滤是事后保守实验，不认证真实成交；公司行动处理和交易日历完整性由应用适配器核对，已知除权事件应拒绝。缺失事件不等于无事件。

## 使用

```ts
import { maBaselineInputSchema, runMaBaseline } from "quant-backtest";
import type { Bar } from "quant-backtest";

const input = maBaselineInputSchema.parse({
  symbol: "sh600519",
  start: "2026-10-08",
  end: "2026-10-30",
  initial: 100000,
});
// bars 由调用方提供，包含开始日期以前至少 20 根预热。
const result = runMaBaseline(input, bars as Bar[]);
```

`runBacktest(request, bars, signals, executionRules, progress?)` 是较低层入口：注入信号数组，不依赖 SMA。调用方必须提供可信、因果的策略信号和明确的约束证据；当前引擎仍只建模现金权益 T+1。它不会注册或启用应用策略。

## 构建与验证

日收盘绩效归独立包[quant-performance](../quant-performance/README.md)。回测引擎仅产出权益与交易事实，不依赖评价包、不参与评价事务；应用层可把冻结结果映射为评价输入。

仓库根先 `pnpm trading-strategy-core:build`，再：

```text
pnpm backtest-engine:build
pnpm backtest-engine:test
pnpm --filter quant-backtest typecheck
```

包内测试独立运行，覆盖信号、下一根成交、T+1、整手、最低佣金/卖出费用、现金不足、受阻请求、未来追加和非法输入。根目录 `tests/engineering-validation/backtest-package.test.ts` 另验证公共 ESM 导出可以在应用目录之外执行，并检查包内禁止应用/IO 导入；其负对照能检出错误依赖。

框架自身不创建文件、日志、数据库、任务或缓存。应用拥有原始数据读取、交易日历/公司行动核对、快照 hash、worker 取消、结果持久化、分页和删除。构建脚本把包源码、共享指标/资金原语与 lockfile 的摘要注入 worker 结果；直接从源码运行显示 `source-development`，不能冒充已冻结的构建版本。包/API 有意义的变更须更新版本及对应验证。

0.5.0新增离线中证800多证券共享资金研究，入口 runCsi800Study / csi800Weights；不是应用策略注册或实盘接口。规则、单命令运行和简化边界见 [规格](../../docs/product/specs/csi800-study.md)。

0.6.0新增经典技术＋财务分家族/分支路评分、合法外部目标、共同覆盖窗口和组合风险预算；复用单一经济收益归一化。另有只读实际仓位价格指数归因，不改变成交。规格、运行与完整边界见 [多因子研发规格](../../docs/product/specs/csi800-multifactor-research.md)和[交付](../../docs/deliveries/2026-11-08-csi800-multifactor.md)。
