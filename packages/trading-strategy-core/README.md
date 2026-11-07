# trading-strategy-core

纯 TypeScript 策略基础包，承载策略服务会复用、但不需要数据库、文件系统、环境变量、Next.js、数据源或 DLL 的能力。

当前公开模块：`bars`、`completed-bars`、`indicators`、`money`、`factors`。

`factors` 按趋势/动量/波动/量价/突破分模块，统一目录元数据、参数验证、lookback 与对齐序列。共 76 个原生模块：22 个共享技术指标、41 个 Qlib Alpha158 模块、13 个 Alpha101 时序公式。公开来源、版本和实际缺项见[因子接口](src/factors/README.md)。

```ts
import { calculateFactor, factorCatalog } from "trading-strategy-core/factors";
const result = calculateFactor(bars, { id: "sma", parameters: { period: 20 } });
// result.values 与输入等长，缺失为 null，不修改 bars；原生周期单位为根。
```

`packages/trading-strategies` 仍是九方向代表策略目录和证据元数据包，不与本包合并；真正的运行编排继续位于 `src/server/strategies`。


## 财务计算

`trading-strategy-core/financial` 提供同口径同比、单季、TTM、三年CAGR、质量比率、时间可见性及三值条件。通达信字段、单位、原值投影与源快照类型复用 `tstdx/financial-model`；该入口没有Node依赖，计算核心不读取本地文件或数据库。应用负责准备带来源和可见日期的输入，缺失与不满足分别返回。
