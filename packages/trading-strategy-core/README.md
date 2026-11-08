# trading-strategy-core

纯 TypeScript 策略基础包，承载策略服务会复用、但不需要数据库、文件系统、环境变量、Next.js、数据源或 DLL 的能力。

当前公开模块：`bars`、`completed-bars`、`indicators`、`money`、`factors`。

0.3.0在indicators新增CCI、MFI、Williams %R、Chaikin资金流、Wilder DMI/ADX、算术ATR Supertrend、SAR和因果一目云层，供已校验OHLCV的离线日线策略复用；指标用例及未来隔离见`tests/research-backtest/backtest/mainstream-strategy-study.test.ts`，具体平滑/种子及变体见[规格](../../docs/product/specs/mainstream-strategies-maotai.md)。没有改变原指标或94项因子目录。

`factors` 按趋势/动量/波动/量价/突破分模块，统一目录元数据、参数验证、lookback 与对齐序列。共94个行情模块：22个共享指标、18个常用行情因子、41个Qlib模块、13个Alpha101时序公式；另有197项本地数据条件，使用显式财报/序列/基准输入。公开来源、版本和实际缺项见[因子接口](src/factors/README.md)。

```ts
import { calculateFactor, factorCatalog } from "trading-strategy-core/factors";
const result = calculateFactor(bars, { id: "sma", parameters: { period: 20 } });
// result.values 与输入等长，缺失为 null，不修改 bars；原生周期单位为根。
```

`packages/trading-strategies` 仍是九方向代表策略目录和证据元数据包，不与本包合并；真正的运行编排继续位于 `src/server/strategies`。

## 财务计算

`trading-strategy-core/financial` 提供同口径同比、单季、TTM、三年CAGR、质量比率、时间可见性及三值条件。通达信字段、单位、原值投影与源快照类型复用 `tstdx/financial-model`；该入口没有Node依赖，计算核心不读取本地文件或数据库。应用负责准备带来源和可见日期的输入，缺失与不满足分别返回。
