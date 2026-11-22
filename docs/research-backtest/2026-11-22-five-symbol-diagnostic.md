# 五标的回测诊断结果（2026-11-22 批次）

> 流程诊断，不是策略业绩；不做收益排名，不做策略间收益比较，不构成任何可交易结论。
>
> 日历外 bar 修正与 `sz000001` 补跑见[补充记录](2026-11-22-calendar-correction.md)。

本批按[诊断协议](2026-11-22-backtest-protocol.md)检查数据、信号、订单、成交、费用、公司行动与账本能否逐项对上。样本与运行形态见[五标的选样](2026-11-22-five-symbol-selection.md)。所有计数来自各单元的 `summary.json` / `diagnostics.json`，跨单元汇总引 `aggregate.json`。

## 运行范围与口径

| 项目 | 取值 |
| --- | --- |
| 单元 | 36（per-symbol 30 + portfolio 6） |
| 状态 | ok 30 / blocked 6 / failed 0 |
| 单标的 | 5 标的 ×（5 信号策略 + `hold` 对照） |
| 组合 | 5 标的共享资金 × 6 策略/对照 |
| 行情根 | `E:\new_tdx64`，只读 |
| 数据截止 | 2026-11-20 |
| 初始资金 | 1,000,000 |
| 费用 | `base` 情景 |
| 风险/仓位 | `riskPerTrade 0.02`；单标的 `maxPositions 1`，组合 `maxPositions 5` |
| 信号价 | 逐 bar 因果 GBBQ 因子，首根原价固定锚；`hold` 不强制因果价 |
| 单标的窗口 | 各自首根日线 + 策略预热（dual-ma / double-breakout / formula 250 根；turtle / rsi2 300 根；hold 0 根） |
| 组合窗口 | 2018-06-11 ~ 2026-11-20（最晚上市标的的首根日线） |

计数口径：`signals` 是窗口内 `entry` 或 `exit` 为真的逐日观察数；`orders` 是实际生成订单数；`fills` 是成交数；`rejections` 是拒绝**尝试**数，单笔订单可重试，因此可大于最终未成交订单数；`closedTrades` 是平仓成交数。`signals` 与 `orders` 口径不同，不能直接相减当作“丢弃信号”。`hold` 是常量入场对照，其 `signals` 等于逐日 bar 数，不是规则信号数。

## 单标的矩阵

单元格格式：`状态 signals/orders/fills/rejections/closedTrades`。`blocked` 单元没有有效计数，错误见下节。

| 策略 | sh600519 | sz000001 | sh601318 | sz000333 | sz300750 |
| --- | --- | --- | --- | --- | --- |
| dual-ma | ok 339/314/291/43/145 | blocked | ok 267/257/248/17/124 | ok 177/165/153/21/76 | ok 113/104/96/12/48 |
| turtle | ok 898/180/169/27/84 | blocked | ok 662/129/127/10/63 | ok 389/99/97/9/48 | ok 272/54/50/5/25 |
| rsi2 | ok 4435/356/344/30/172 | blocked | ok 3621/215/208/10/104 | ok 2120/186/182/15/91 | ok 1349/99/96/3/48 |
| double-breakout | ok 50/34/34/2/17 | blocked | ok 46/41/40/4/20 | ok 26/24/24/3/12 | ok 18/17/16/1/8 |
| formula | ok 2958/219/207/26/103 | blocked | ok 2469/158/157/8/78 | ok 1412/111/109/6/54 | ok 933/55/52/3/26 |
| hold | ok 6047/1/1/0/0 | blocked | ok 4729/1/1/0/0 | ok 3138/1/1/0/0 | ok 2050/8/1/7/0 |

## 组合

| 策略 | 状态 | bars/warmup | signals | orders | fills | rejections | closedTrades | 主要拒绝原因 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| dual-ma | ok | 24460/14250 | 644 | 609 | 579 | 55 | 288 | 滑点成交价超出可观察价格范围×54；开盘跌停，无法证明卖出成交×1 |
| turtle | ok | 24460/14250 | 1545 | 316 | 306 | 25 | 151 | 滑点成交价超出可观察价格范围×24；开盘跌停，无法证明卖出成交×1 |
| rsi2 | ok | 24460/14250 | 7945 | 516 | 506 | 27 | 253 | 滑点成交价超出可观察价格范围×27 |
| double-breakout | ok | 24460/14250 | 92 | 72 | 70 | 6 | 35 | 滑点成交价超出可观察价格范围×4；开盘跌停，无法证明卖出成交×1；资金不足以支付一手及费用×1 |
| formula | ok | 24460/14250 | 5572 | 372 | 364 | 21 | 180 | 滑点成交价超出可观察价格范围×21 |
| hold | ok | 24460/14250 | 10210 | 12 | 5 | 7 | 0 | 开盘涨停，无法证明买入成交×7 |

## 阻断单元

6 个 `sz000001` 单标的单元全部在数据层阻断，原因是基准日历 `sh000001` 缺少 `sz000001` 的交易日。各策略实际报出的日期数不同，因为校验只覆盖预热后的窗口：

| 策略 | 报错原文 |
| --- | --- |
| dual-ma | `基准日历 sh000001 缺少 sz000001 的交易日：1992-05-03, 1992-10-04, 1993-05-01, 1993-05-02` |
| double-breakout | `基准日历 sh000001 缺少 sz000001 的交易日：1992-05-03, 1992-10-04, 1993-05-01, 1993-05-02` |
| formula | `基准日历 sh000001 缺少 sz000001 的交易日：1992-05-03, 1992-10-04, 1993-05-01, 1993-05-02` |
| turtle | `基准日历 sh000001 缺少 sz000001 的交易日：1992-10-04, 1993-05-01, 1993-05-02` |
| rsi2 | `基准日历 sh000001 缺少 sz000001 的交易日：1992-10-04, 1993-05-01, 1993-05-02` |
| hold | `基准日历 sh000001 缺少 sz000001 的交易日：1991-04-06, 1991-04-13, 1991-04-20, 1991-05-04, 1991-05-11 等 39 个` |

`inspect-calendar.log` 显示底层缺口共 39 个日期，全部是周六或周日；`sz000001` 在这些日期有成交记录，`sh000001` 没有对应 bar。`hold` 预热为 0，所以列出完整 39 个；其余策略从预热后开始检查，只剩早期少量日期。这是同一处数据缺口的不同截断表现，不是不同标的或不同策略的数据差异。该缺口未在本批修复，依赖 `sz000001` 的单标的结论全部不成立。

## 问题分级

### P0（正确性失败）

无。30 个 ok 单元各 15 项检查中，`failedChecks` 为空：成交严格晚于信号日、订单/成交匹配与基数、重复成交、成交价在 bar 与涨跌停内、逐笔费用、现金非负、权益恒等、信号/原价比值只随公司行动变化、独立账本重放均通过。

### P1（告警/数据限制）

- **公司行动未触发（26 warn / 4 pass）**：20 个单标的信号策略单元与 6 个组合单元全部报 `N 个请求事件未触发（未持仓或动作日未到）`；4 个单标的 `hold` 单元通过。`missing` 只保留前 5 条样本，计数是请求事件数，不是缺失公司行动数。
- **容量提示（5 warn / 25 pass）**：全部集中在 `sh600519`，且只出现在信号策略；`double-breakout` 1 笔、`turtle` 20 笔、`rsi2` 25 笔、`formula` 27 笔、`dual-ma` 123 笔超过当日成交额 5%，其中 `dual-ma` 6 笔、`formula` 2 笔、`turtle` 1 笔、`rsi2` 1 笔超过 20%。最大单笔占当日成交额 43.09%（`dual-ma`），最大单笔相对 20 日均额 20.55%（`formula`）。引擎无容量约束，这些只是可达性提示，不代表可成交。
- **数据质量（27 warn / 3 pass）**：20 个单标的信号策略单元各报 `1 个标的含 GBBQ 问题`，6 个组合单元各报 `5 个标的含 GBBQ 问题`，单标的计数均为 91 条整文件未解析记录；`sh600519` 另报 `2006-05-25` 权证被跳过。`hold` 的 `sh600519` 与组合单元报 0 条 GBBQ 问题但仍报跳过权证，因为 `hold` 不走因果价路径，`gbbqIssueCount` 未填充（见“产物一致性”）。3 个完全通过的单元是 `hold` 的 `sh601318`、`sz000333`、`sz300750`。
- **拒绝分布（36 单元合计）**：滑点成交价超出可观察价格范围 362 次、开盘涨停无法证明买入 14 次、缺少当日交易限制依据 12 次、资金不足以支付一手及费用 9 次、开盘跌停无法证明卖出 6 次。均为执行约束拒绝，不是账本错误。拒绝按尝试计：例如 `dual-ma/sh600519` 的 314 笔订单中 291 笔成交、23 笔最终拒绝，但有 39 笔订单至少被拒一次、16 笔重试后成交，合计 43 次拒绝。
- **`hold` 对照**：4 个 ok 单元各有 1 笔成交；`sz300750` 为 8 笔订单、1 笔成交、7 次开盘涨停拒绝。组合层为 12 笔订单、5 笔成交、7 次开盘涨停拒绝，5 个标的各 1 笔成交，无平仓。对照证明建仓路径会在开盘涨停时拒绝，而不是伪造成交。

### P2（阻断与未验证边界）

- **`sz000001` 6 个单元阻断**：基准日历缺口导致无法进入回放；错误原文见上表。缺口日期全部为周末，需先确认是早期周末交易时段还是源数据多记，再决定修复方式。
- **GBBQ 为事后文件**：91 条整文件未解析记录按 record-only 策略仅记录；派息到账日、送转股份上市日未核实，统一按除权日研究情景入账与可卖。
- **历史证券池与交易状态未认证**：当前存续样本存在幸存者偏差；历史 ST、IPO 特殊限制、盘口排队未编码。涨跌停按板块与日期研究规则推算。
- **容量与冲击成本未建模**：容量提示只比较成交额占比，不含参与率、冲击或排队。
- **组合窗口较短**：2018-06-11 起，前四只标的更早的历史只用于预热（组合 warmup 合计 14250 根），不进入组合评分。
- **同 bar 保护性退出**：`double-breakout` 的 `protectiveSameBar` 在 4 个单标的单元分别为 8、9、5、3 笔，组合 20 笔；按协议属独立保护性退出路径，常规成交仍严格晚于信号日。日线无法验证盘中触发价与排队，只能作为研究情景。
- **`sz300750` 2023-04-26 除权**：原始收盘 385.9 降至 224.5，除权参考价 212.99，当日涨跌停 255.59/170.39；这不是坏 bar。`aggregate.json` 另记录创业板 2020-08-24 改革后 12 个交易日绝对涨跌幅超过 10%，最大 18.70%（2024-10-08），均在 20% 板块限制内。
- **`hold` 与信号策略的 GBBQ 计数不对称**：同一标的 `hold` 报 0 条、信号策略报 91 条，原因是 `forceCausalPrice` 只在信号策略启用；不是标的文件不同。

## 已知限制

- 结果只覆盖当前存续的五只中证 800 成分，不能外推到全市场或历史成分。
- 公司行动按除权日研究情景处理，现金到账与股份可卖时点未知；分红再投资、配股与余股规则均有近似。
- 未建模停牌排队、涨跌停封单量、冲击成本与市场容量；`fills` 是可观察价格范围内的模拟成交，不是可成交证明。
- 单标的窗口长度差异很大（评分窗口 1800~5869 个自然日，bars 2050~6047），跨标的只比较流程计数，不比较收益。
- 本批未做样本外、walk-forward 或参数敏感性；dual-ma `sh601318` 的 base/double-cost 探针只验证费用变化会改变成交与拒绝计数，不构成策略结论。

## 产物路径

- 批目录：`.test-data/backtest-diagnose/2026-11-22-batch1/`
- 单标的运行：`run-2026-11-22T04-36-56.537Z-31400/`
- 组合运行：`run-2026-11-22T04-37-59.461Z-34900/`
- 费用探针：`run-2026-11-22T04-38-20.698Z-16772/`（base）、`run-2026-11-22T04-38-24.692Z-32388/`（double-cost）
- 汇总：`aggregate.json`；计划快照：`plan.json`
- 日志：`logs/per-symbol.log`、`logs/portfolio.log`、`logs/cost-base.log`、`logs/cost-double-cost.log`、`logs/aggregate.log`、`logs/inspect-calendar.log`、`logs/inspect-catl.log`、`logs/plan.stdout.txt`
- 只读检查脚本：`.test-data/backtest-diagnose/tools/aggregate.ts`、`inspect-calendar.ts`、`inspect-catl.ts`
- 每个单元含 `summary.json`、`diagnostics.json`、`run.json`、`orders.csv`、`fills.csv`、`rejections.csv`、`equity.csv`、`bars.csv`、`positions.json`

## 命令（按 `plan.json`、`run.json` 与日志复原）

```powershell
# 计划
pnpm exec tsx scripts/backtest-diagnose.ts --tdx-root E:/new_tdx64 --plan --out .test-data/backtest-diagnose/2026-11-22-batch1 --data-dir .test-data/backtest-diagnose/data

# 单标的 30 单元
pnpm exec tsx scripts/backtest-diagnose.ts --tdx-root E:/new_tdx64 --mode per-symbol --out .test-data/backtest-diagnose/2026-11-22-batch1 --data-dir .test-data/backtest-diagnose/data

# 组合 6 单元
pnpm exec tsx scripts/backtest-diagnose.ts --tdx-root E:/new_tdx64 --mode portfolio --out .test-data/backtest-diagnose/2026-11-22-batch1 --data-dir .test-data/backtest-diagnose/data

# 费用探针：dual-ma/sh601318，各 1 单元
pnpm exec tsx scripts/backtest-diagnose.ts --tdx-root E:/new_tdx64 --symbols sh601318 --strategies dual-ma --mode per-symbol --limit 1 --cost base --out .test-data/backtest-diagnose/2026-11-22-batch1 --data-dir .test-data/backtest-diagnose/data
pnpm exec tsx scripts/backtest-diagnose.ts --tdx-root E:/new_tdx64 --symbols sh601318 --strategies dual-ma --mode per-symbol --limit 1 --cost double-cost --out .test-data/backtest-diagnose/2026-11-22-batch1 --data-dir .test-data/backtest-diagnose/data

# 只读汇总与检查
pnpm exec tsx .test-data/backtest-diagnose/tools/aggregate.ts ".test-data/backtest-diagnose/2026-11-22-batch1/run-2026-11-22T04-36-56.537Z-31400,.test-data/backtest-diagnose/2026-11-22-batch1/run-2026-11-22T04-37-59.461Z-34900" "E:/new_tdx64" ".test-data/backtest-diagnose/2026-11-22-batch1/aggregate.json"
pnpm exec tsx .test-data/backtest-diagnose/tools/inspect-calendar.ts E:/new_tdx64 > .test-data/backtest-diagnose/2026-11-22-batch1/logs/inspect-calendar.log
pnpm exec tsx .test-data/backtest-diagnose/tools/inspect-catl.ts E:/new_tdx64 > .test-data/backtest-diagnose/2026-11-22-batch1/logs/inspect-catl.log
```

`--data-dir` 必须是 `.test-data` 下的隔离目录；本批使用 `.test-data/backtest-diagnose/data`（含 `quant.sqlite` 与 `bar-store`）。CLI 会在 `--out` 下新建 `run-*` 目录，并用 `--data-dir` 覆盖 `QUANT_DATA_DIR`。

## 产物一致性说明

- `logs/aggregate.log` 的 `ok 30 / blocked 6` 是 36 个单元的总数；单标的报告里的 `ok 24 / blocked 6` 只统计 30 个单标的单元。两者分母不同，不矛盾。
- 两个费用探针是独立的 1 单元运行，不进入 36 单元矩阵，也不在 `aggregate.json` 的 `runRoots` 中。base 探针与批量中的 `dual-ma/sh601318` 计数一致；double-cost 探针的 orders 253、fills 242、rejections 22、closedTrades 121，与 base 的 257/248/17/124 不同，说明费用情景会改变成交与拒绝，属于预期行为。
- `hold` 的 GBBQ 计数为 0 与信号策略的 91 不一致，原因见 P2；引用时不要把它当作标的文件差异。
