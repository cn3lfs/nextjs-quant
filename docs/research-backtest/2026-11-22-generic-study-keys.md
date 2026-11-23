# 诊断器通用 study key（2026-11-22）

> 工程能力记录，不是策略业绩。诊断器接受更多既有研究规则，不改变规则本身。

## 变更

`scripts/lib/backtest-diagnose/strategy-specs.ts` 不再只识别 5 个 adapter + 15 个研究 ID，而是从 `trading-strategies` 导出的 `studyStrategies` 目录派生：

- 对每个 catalog ID 用 400 根确定性合成日线调用 `createExtendedStudyRule`；返回非 null 即接受为 `--strategies` key，构造抛错则不接受。结果按 ID 记忆化。
- `hold` 显式排除，仍是账本对照（`constant` 入场、预热 0）。
- 接受的 study key 使用 `studyWarmup`（多数 140，`research-growth`/`momentum250`/`skip-momentum`/`sma200` 为 300，`classic-nvi` 为 254）。
- 账户型规则（`ma`、`breakout`、`pullback`、`range`、`grid`、`hold`、`hold80`、`vol-target`、`constant-mix`、`cppi`、`dca`）仍不接受；`ma`/`breakout` 通过 `prepareStrategy` 时继续抛 `account-only execution profile`。
- `dual-ma`、`double-breakout`、`formula` 保持原定义与 250 根预热。

## 规模

| 项目                          |                                       数量 |
| ----------------------------- | -----------------------------------------: |
| catalog study 总数            |                                        105 |
| 接受为诊断 key（不含 `hold`） |                                         94 |
| 其中相对上一版新增            | 77（`turtle`/`rsi2` 原本已是 adapter key） |
| 账户型排除                    |                                         11 |

新增覆盖包括趋势/动量/反转/量价/日历类、`classic-*` 与 `theory-*`（daily/structure/advanced/range）。

## 证据

- 能力测试：`tests/research-backtest/diagnose/strategy-capability.test.ts`
  - 接受集合必须精确等于“catalog 里可构造规则且不是 hold”的集合；探测期抛错列表必须为空，否则失败而不是静默缩小集合。
  - 94 个 key × single/portfolio 均能 parse、`prepareStrategy` 不抛错。
  - 原 15 个研究 key 保留“结构化 fixture 必须产生一次真实入场”的触发测试。
- 冒烟（`sh600519`，strict，单标的）：

| key               | signals | orders | fills | 拒绝 |
| ----------------- | ------: | -----: | ----: | ---: |
| `macd`            |   4,881 |    360 |   334 |   42 |
| `kdj`             |     360 |    171 |   164 |   22 |
| `theory-stage150` |      84 |     82 |    82 |    5 |

产物：`.test-data/backtest-diagnose/2026-11-22-generic-study/smoke/run-*/`。

## 风险与边界

- 接受判定只证明“规则可构造”；若某规则只在真实数据抛错，会在该 cell 运行时暴露，不会被静默跳过。
- 预热 300 根的 key 在短历史标的上会因预热不足显式失败，不使用未来数据。
- 本变更只扩诊断入口，不改变任何策略规则、引擎默认或研究口径。
- 冒烟只覆盖 1 只标的、3 个 key；不代表全部 94 个 key 在真实数据上都会产生成交。
