# quant-performance

独立的纯 TypeScript 绩效评价模块。负责日收益指标、回撤事件、年度/季度/月度分组与报告选择；不依赖回测引擎、行情服务、数据库、文件、网络、React或Next.js。没有运行时第三方依赖。

调用方拥有数据来源、权益/TWR净值生成、费用、外部现金流处理及数据完整性。模块只接收日期升序的正净值/权益，可选同日基准日收益；不参与撮合、记账或数据库写入事务。现金流账户须由调用方先单位化，不能把入金当收益。

```ts
import { evaluatePerformance, createPerformanceReport, queryPerformanceReport } from "quant-performance";
const points = [
  { date: "2025-01-02", value: 110, benchmarkReturn: 0.02 },
  { date: "2025-01-03", value: 88, benchmarkReturn: -0.03 },
  { date: "2025-01-06", value: 110, benchmarkReturn: 0.01 },
];
const overall = evaluatePerformance(100, points);
const all = createPerformanceReport(100, points);
const page = queryPerformanceReport(100, points, { frequency: "month", year: 2025, period: "2025-01" });
```

统一252日年化、2%无风险假设、样本标准差。日收盘序列必须包含首日相对期初的变动；空仓零收益保留，不把缺失补零。缺少完整基准时IR留空。短于252日不显示CAGR/Calmar；最大回撤修复为谷底→首次恢复前高的自然日，未修复为null并保留已观察天数。分期承接上一期末权益，不读取该期末之后的数据。

公开入口只有包根，不从应用或其他包深层导入。语义版本为`daily-performance-v1`与`performance-report-v1`，后续变更公式需版本化。公式与产品交互见[规格](../../docs/product/specs/backtest-evaluation.md)。

独立使用：`pnpm --filter quant-performance build`、`pnpm --filter quant-performance typecheck`、`pnpm --filter quant-performance test`。构建后可从应用目录以外通过ESM导入`dist/index.js`。持久测试在本包`tests/`，包边界及反例验证在根`tests/engineering-validation/performance-package.test.ts`。
