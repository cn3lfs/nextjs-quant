# 94 个通用 Catalog Study Key 真实数据健康摸底（2026-11-23）

> 工程健康基线，不是策略业绩；不做收益排名，不构成可交易结论。研究口径沿用[回测研究假设](2026-11-22-backtest-assumptions.md)，key 目录派生见[通用 study key 记录](2026-11-22-generic-study-keys.md)。

## 1. 范围与口径

- 标的：`sh600519`（`E:/new_tdx64` 只读日线至 `2026-11-20`，`--mode per-symbol --start auto --end 2026-11-20 --initial 1000000 --cost base --execution-profile strict`）。
- 覆盖：全部 94 个 `STUDY_STRATEGY_KEYS` + 1 个 `hold` 对照，共 95 个诊断单元。
- 产物：`.test-data/backtest-diagnose/2026-11-23-catalog-94-health/strict/run-2026-11-23T07-54-35.813Z-48264/report.md`。

## 2. 分层汇总（95/95 ok，0 P0）

| 类别                                         | 数量 | 说明                                                                                                                                                                                                                                              |
| :------------------------------------------- | ---: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 正常产生有效成交（`fills > 0`）              |   88 | 全部通过 12 项诊断与独立账本重放，无运行期抛错                                                                                                                                                                                                    |
| 仅有退出评估、零入场（`sig > 0, fills = 0`） |    4 | 均为已归因的威科夫稀有结构：`research-wy-jac-protected`、`research-wy-lps-protected`、`research-wy-reaccumulation-protected`、`research-wy-trend-pullback-protected`（`sh600519` 零入场，见[威科夫零入场排查](2026-11-22-wyckoff-zero-entry.md)） |
| 零信号（`sig = 0, fills = 0`）               |    2 | 稀有形态规则：`theory-cup-handle`、`theory-sos-pullback`（无抛错、无数据阻断）                                                                                                                                                                    |
| 预热/数据阻断（`blocked`）                   |    0 | 无                                                                                                                                                                                                                                                |
| 正确性失败或抛错（`failed`）                 |    0 | 无                                                                                                                                                                                                                                                |

## 3. 低成交与高拒绝提示（供后续批次优先对照 `clamp`）

- **低成交（`fills <= 4`）**：`research-volume-down-contracted`、`research-wy-sos-protected`、`research-wy-spring-protected`、`research-wyckoff`（均 2 笔成交 / 1 次完整平仓）。
- **高频/执行敏感（`strict` 5bp 滑点拒绝 ≥ 50 次）**：`classic-ibs`（2,776 成交 / 406 拒绝）、`classic-connors-rsi`（2,740 / 385）、`classic-stoch-rsi`（1,340 / 165）、`classic-kama`（719 / 99）、`classic-vortex`（535 / 84）、`classic-force-index`（625 / 81）、`sar`（477 / 72）、`obv`（503 / 67）、`dual-thrust`（477 / 54）。按冻结口径，上述规则后续做专题分析时须并列 `clamp` 与 `cap-0.5-clip` 对照。

## 4. 边界

- 仅覆盖 `sh600519` 单标的 `strict` 档，用于排除“合成探针可构造但真实行情抛错”的工程缺陷；不代表全部 94 个规则在短历史标的或全市场上均有成交。
