# quant-performance

独立的纯 TypeScript 绩效评价模块。负责日收益指标、回撤事件、年度/季度/月度分组、交易轮次配对与评价；不依赖回测引擎、行情服务、数据库、文件、网络、React或Next.js。没有运行时第三方依赖。

调用方拥有数据来源、权益/TWR净值生成、费用、外部现金流处理及数据完整性。日频评价接收日期升序的正净值/权益，可选同日基准日收益；交易评价接收规范成交/公司行动或完整交易轮次。模块不参与撮合、记账或数据库写入事务。现金流账户须由调用方先单位化，不能把入金当收益。

```ts
import {
  evaluatePerformance,
  createPerformanceReport,
  queryPerformanceReport,
} from "quant-performance";
const points = [
  { date: "2025-01-02", value: 110, benchmarkReturn: 0.02 },
  { date: "2025-01-03", value: 88, benchmarkReturn: -0.03 },
  { date: "2025-01-06", value: 110, benchmarkReturn: 0.01 },
];
const overall = evaluatePerformance(100, points);
const all = createPerformanceReport(100, points);
const page = queryPerformanceReport(100, points, {
  frequency: "month",
  year: 2025,
  period: "2025-01",
});
```

统一252日年化、2%无风险假设、样本标准差。日收盘序列必须包含首日相对期初的变动；空仓零收益保留，不把缺失补零。缺少完整基准时IR留空。短于252日不显示CAGR/Calmar；最大回撤修复为谷底→首次恢复前高的自然日，未修复为null并保留已观察天数。分期承接上一期末权益，不读取该期末之后的数据。

公开入口只有包根，不从应用或其他包深层导入。日净值语义仍为`daily-performance-v1`，0.2.0新增`trade-performance-v1`，报告为`performance-report-v2`。公式与产品交互见[规格](../../docs/product/specs/backtest-evaluation.md)。

## 交易轮次评价

`pairPositionCycles(fills, actions?)`从只读的规范成交与公司行动重建同一股票由空仓到清仓的轮次，支持加仓、部分卖出、分红、送转和配股；同日公司行动在成交之前，同日成交保留输入顺序。不做FIFO逐买单配对，不执行交易或改变来源账户。调用方提供研究窗口内有效证据，日期均为`YYYY-MM-DD`；五分钟来源须在保留成交顺序后映射为交易日期。

`evaluateTrades(cycles)`返回已闭合/未平仓及盈亏持平计数、平均盈利额、平均亏损绝对额、盈亏比、胜率、利润因子和每轮平均净损益，金额均为模型费用与公司行动现金流后的本币金额，不是收益率。未平仓（包含已部分止盈）整轮排除；胜率分母含持平，净损益绝对值不超过1e-8视为持平。无盈利、无亏损或零样本时对应指标为`{value:null,reason}`，不输出无穷大；全部亏损时利润因子为0。

`createPerformanceReport(initial, points, cycles?)`和`queryPerformanceReport(initial, points, selection, cycles?)`增加全程`trades`。未提供交易证据为null，与提供空数组的零交易样本区分；年季月净值口径不变，交易卡片始终标为全程，不随所选年份偷偷改变配对范围。

```ts
import { pairPositionCycles, evaluateTrades } from "quant-performance";
const cycles = pairPositionCycles([
  {
    date: "2025-01-02",
    symbol: "A",
    side: "buy",
    quantity: 100,
    price: 10,
    fee: 1,
  },
  {
    date: "2025-01-03",
    symbol: "A",
    side: "sell",
    quantity: 100,
    price: 12,
    fee: 1,
  },
]);
const trades = evaluateTrades(cycles); // averageWin.value = 198; no losses => payoffRatio null.
```

独立使用：`pnpm --filter quant-performance build`、`pnpm --filter quant-performance typecheck`、`pnpm --filter quant-performance test`。构建后可从应用目录以外通过ESM导入`dist/index.js`。持久测试在本包`tests/`，包边界及反例验证在根`tests/engineering-validation/performance-package.test.ts`。
