# trading-strategies

独立的纯策略模块。统一维护公开策略分类、数据依赖、日线规则、横截面排序、配置与既有策略计算；行情 IO、数据库、DLL、撮合与绩效评价不进入本包。

## 统一接口

`unifiedStrategyCatalog` 包含91项：56项纯行情日线、1项原生结构日线、25项目标权重预设、3项研究和6项输入/模型缺口。`getStrategyDefinition`读取定义，`checkStrategyAvailability`检查能力前置条件，不把工程已实现当作可信业绩。既有九方向代表的历史证据索引独立保留。

`evaluateStrategy`接收`strategyId`和截至`asOf`的已完成行情或候选因子。信号输出`signal`，横截面输出`weights`；原始账户型日线策略输出`order`，要求显式传入`account`状态。它不改变持仓或现金。完整日线回放由`quant-backtest.runClassicStudy`调用`createStudyDecision`执行。

横截面输入为`{symbol,availableAt,values}`，未到可见时间及缺因子样本排除，不补零；按固定因子方向排序、并列按证券代码，默认前10只等权。`strategyCandidateFactors`明确因子单位、窗口、跳过窗口和基准；财务因子由应用按当时可见报告计算。等权和反波动配置使用全部有效候选，反波动配置不是含协方差的风险平价。

既有`factorStrategy*`、`maBaselineSignals`、中证800因子、评分、调仓计划、风险规则及权重计算均从本包直接导入。`quant-backtest`仅承担回放与账户执行，不保留上述旧路径转发。

## 分类与研究方法

`strategyCategories` 维护15个稳定分类，`StrategyDefinition.category` 为唯一分类标识，原 `family` 是方法家族。`strategyMethodClassification` 将695条旧方法区分为规则、风控政策、研究分析与数据工具，不由登记状态推断能否执行。

`./research/*` 是按波段、量价、成长、威科夫、缠论、技术与中性事实契约分域的公开纯计算入口。应用直接导入包内实现；原算法路径删除，不保留转发。研究任务、证据读取、原生DLL与执行账本继续由应用负责。

新增经典规则的固定源码、许可、公式、改编和初始化差异见 [来源清单](../../docs/data-sources/classic-strategies/README.md)。`studyWarmup` 是回放预热（新增规则最少140根），不是指标第一根有效样本数。

## 历史代表证据

| 方向         | 代表                     | 当前状态                         |
| ------------ | ------------------------ | -------------------------------- |
| 双突破       | `sw-double-prior20`      | B3 完成归档，标签为样本不足      |
| 技术指标共振 | `sw-confluence`          | B3 完成归档，标签为样本不足      |
| 量价         | `vp-up-expanded-confirm` | B3 完成归档，标签为样本不足      |
| Wyckoff      | `wy-sos-daily`           | B4 部分归档，当前观察无事件      |
| 缠论         | `chan-third-native`      | B4 部分归档，czsc 基线未独立验证 |
| 成长股       | `canslim-high-98`        | 已实现，未真实回测               |
| 价值         | `FA08`                   | 工程版本，S7 未开始              |
| 情绪         | `MS04`                   | 工程版本，S7 未开始              |
| 产业链       | `IC04`                   | 工程版本，S7 未开始              |

完整方法仍在工作台的 method-map 和源代码中保留，用于溯源、审计和后续研究；本包的“代表”不是删除其他研究方法，也不是性能排名。`FA08`、`MS04`、`IC04` 是 method ID，不冒充 preset；缠论和 Wyckoff 代表当前只达到 raw-only 证据级别。

## 开发

```powershell
pnpm --filter trading-strategies test
pnpm --filter trading-strategies typecheck
pnpm --filter trading-strategies build
```

固定输入测试和历史回测统计都是程序/研究证据，不是盈利证明。A 股交易规则、复权、证券池时点和缺失数据边界以工作台文档为准。

公开标识：`id` 是稳定代表 ID，`methodId` 是方法，`presetId` 是可选参数预设。无预设保持缺失；未回测条目不允许 evidence，已观察条目的 evidence.readiness 必须匹配。

工作台通过 workspace 依赖接入研究页的“九方向代表策略”。选择代表只填写已有研究预设；无 preset 的三个方法仅作参考。根 `dev`、`build`、`typecheck`、`test` 均先构建本包，根 `test` 也显式运行包内测试。

共享指标及财务原语位于 `trading-strategy-core`。本包不反向依赖 `src` 或回测包；运行编排继续由应用服务负责。历史代表条目仅为原始证据索引，不表示统一执行规则已恢复启用。


## 2026-11-11 可执行目录与职责

统一目录现有91项（57日线、25目标权重预设、3研究、6输入/模型缺口），与原九方向历史证据索引分开维护。六个既有代表已进入统一回放，其历史证据级别保持原样；RPS七周期是同一家族预设，不计作七种独立alpha。财务4项与协方差风险平价来源见[前批交付](../../docs/deliveries/2026-11-11-strategy-module-boundaries.md)，成长/年度财务、组合/公式、盘中/周线政策和原生逐日执行见[本批交付](../../docs/deliveries/2026-11-11-strategy-factor-native.md)。

research子路径维护策略政策、形态、筛选与中性事实契约；原始供应商列解析、数据读取、证据hash与任务留应用。费用/数量报价由执行器注入，成交原语复用quant-backtest，回放与持仓账本由实际执行层维护。累计128条完整旧路径映射见[迁移台账](../../docs/strategy-module-migration.json)；另有部分文件仅拆策略语义，不登记整文件搬迁。包只依赖中性FormulaRuntime，应用唯一实现执行既有DSL；原生观察由应用逐收盘固定前缀生成，包消费冻结结构并决定信号。
