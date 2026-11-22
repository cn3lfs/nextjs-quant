# 量价家族全程回测诊断（2026-11-22）

> 流程诊断，不是策略业绩；不做收益排名，不做策略间收益比较，不构成任何可交易结论。

本批把 9 个研究型量价策略接入五标的诊断矩阵，检验信号、订单、成交、费用、容量与账本能否逐项对上。口径见[回测研究假设](2026-11-22-backtest-assumptions.md)，流程见[回测诊断协议](2026-11-22-backtest-protocol.md)，策略映射改动见 `scripts/lib/backtest-diagnose/strategy-specs.ts`。

## 运行范围

| 项目      | 取值                                                                   |
| --------- | ---------------------------------------------------------------------- |
| 单元      | 170（strict 60 + clamp 60 + 容量档 50）                                |
| 状态      | **170/170 ok，0 blocked，0 failed**                                    |
| 标的      | `sh600519, sz000001, sh601318, sz000333, sz300750`                     |
| 策略      | 9 个 `research-volume-*` + `hold` 对照                                 |
| 形态      | 单标的各自全程 + 五标的共享资金组合                                    |
| 行情      | `E:/new_tdx64` 只读，日线截止 2026-11-20                               |
| 资金/费用 | 1,000,000 / `base`                                                     |
| 预热      | `studyWarmup` = 140 根                                                 |
| 数据隔离  | `QUANT_DATA_DIR=.test-data/backtest-diagnose/data`                     |
| 档位      | `strict`、`clamp`、`strict + maxParticipation 0.5% + clip`（仅单标的） |

## 策略总表（单标的 + 组合合计）

计数格式：`signals / fills / 拒绝尝试 / 容量裁剪 fills`。`signals` 是逐日入场或出场布尔为真的观察数，不是“应该成交的次数”；持仓期间重复入场信号不产生新订单。

| 策略                              |                  strict |                  clamp | 容量 0.5% clip（仅单标的） |
| --------------------------------- | ----------------------: | ---------------------: | -------------------------: |
| `research-volume-average-cross`   | 5,835 / 1,378 / 126 / 0 | 5,835 / 1,478 / 23 / 0 |     4,065 / 989 / 100 / 96 |
| `research-volume-breakout-15`     |    2,789 / 536 / 54 / 0 |    2,799 / 566 / 8 / 0 |      1,970 / 432 / 47 / 81 |
| `research-volume-breakout-20`     |    2,525 / 298 / 32 / 0 |   2,529 / 320 / 10 / 0 |      1,789 / 261 / 30 / 54 |
| `research-volume-flat-contracted` |    2,518 / 320 / 23 / 0 |    2,520 / 318 / 6 / 0 |      1,781 / 261 / 26 / 59 |
| `research-volume-price-protected` |    2,478 / 290 / 23 / 0 |    2,478 / 300 / 5 / 0 |      1,743 / 224 / 22 / 41 |
| `research-volume-up-normal`       |     2,340 / 76 / 10 / 0 |     2,340 / 86 / 4 / 0 |         1,645 / 62 / 6 / 8 |
| `research-volume-flat-expanded`   |      2,319 / 38 / 7 / 0 |     2,318 / 38 / 1 / 0 |        1,641 / 44 / 6 / 17 |
| `research-volume-up-contracted`   |      2,309 / 26 / 2 / 0 |     2,310 / 28 / 0 / 0 |         1,628 / 25 / 2 / 4 |
| `research-volume-down-contracted` |       2,294 / 4 / 0 / 0 |      2,294 / 4 / 0 / 0 |          1,614 / 7 / 1 / 4 |
| `hold` 对照                       |    34,631 / 10 / 90 / 0 |   34,631 / 10 / 87 / 0 |        24,421 / 5 / 83 / 1 |

合计：

| 档位           | 单元 | signals | orders | fills | 拒绝尝试 |  平仓 | 容量裁剪 |
| -------------- | ---: | ------: | -----: | ----: | -------: | ----: | -------: |
| strict         |   60 |  60,038 |  3,190 | 2,976 |      367 | 1,474 |        0 |
| clamp          |   60 |  60,054 |  3,275 | 3,148 |      144 | 1,560 |        0 |
| 容量 0.5% clip |   50 |  42,297 |  2,257 | 2,310 |      323 | 1,036 |      365 |

按形态：

| 档位      | 形态       | fills | 拒绝尝试 | 裁剪 |
| --------- | ---------- | ----: | -------: | ---: |
| strict    | per-symbol | 2,086 |      303 |    0 |
| strict    | portfolio  |   890 |       64 |    0 |
| clamp     | per-symbol | 2,220 |      126 |    0 |
| clamp     | portfolio  |   928 |       18 |    0 |
| 容量 0.5% | per-symbol | 2,310 |      323 |  365 |

## 观察

1. **9 个量价策略都能端到端执行**：每个策略至少在一个标的上产生成交；`report.md`、`summary.json`、`diagnostics.json`、`fills.csv` 完整。
2. **滑点越界拒绝仍是主要成交瓶颈，但量价家族比首批小**：strict 367 → clamp 144；clamp 同时把 fills 从 2,976 提到 3,148。方向与[执行敏感性](2026-11-23-execution-sensitivity.md)一致。
3. **容量 0.5% 对单标的全历史明显绑定**：per-symbol fills 从 2,086 增到 2,310（大单拆成多日），其中 365 笔由裁剪产生。fills 增加不是“更好”，而是成交路径被拆分；比较必须看成交额与仓位路径。
4. **策略活跃度差异很大**：`average-cross` / `breakout-15` / `breakout-20` / `flat-contracted` / `price-protected` 成交数百笔；`down-contracted` 只有 4 笔、`up-contracted` 26 笔、`flat-expanded` 38 笔，组合层更少。信号数高是因为逐日布尔重复为真，不代表有新的可执行机会。
5. **`hold` 对照的拒绝来自开盘涨停/一字**（`sz000001` 早期 76–77 次尝试），与首批结论一致；它不伪造成交。
6. **组合层差异远小于单标的**：strict 890 fills / 64 拒绝，clamp 928 / 18；五标的共享资金把单笔规模压小，容量档在组合层不绑定。

## 结论

- 量价家族具备进入下一阶段策略研究的工程条件：数据、信号、成交、费用与账本在 5 标的全历史上闭合。
- 研究结论必须并列 strict / clamp；单标的全历史另加 0.5% 容量档。`down-contracted`、`up-contracted`、`flat-expanded` 的极低成交频率是策略行为，不是引擎错误；下一阶段若要使用，应先回答“这是设计意图还是规则过严”。
- 本批不做收益比较、样本外或参数寻优；所有单元仍是规则自检。

## 产物

- strict：`.test-data/backtest-diagnose/2026-11-22-volume-family/strict/run-*/`
- clamp：`.test-data/backtest-diagnose/2026-11-22-volume-family/clamp/run-*/`
- 容量：`.test-data/backtest-diagnose/2026-11-22-volume-family/cap-0.5-clip/run-*/`
- 日志：`.codex-runs/research-backtest/2026-11-22-volume-family.log`
- 复现（示例）：

```powershell
pnpm exec tsx scripts/backtest-diagnose.ts `
  --tdx-root E:/new_tdx64 `
  --symbols "sh600519,sz000001,sh601318,sz000333,sz300750" `
  --strategies "research-volume-price-protected,research-volume-flat-expanded,research-volume-up-contracted,research-volume-down-contracted,research-volume-up-normal,research-volume-flat-contracted,research-volume-breakout-15,research-volume-breakout-20,research-volume-average-cross" `
  --controls hold --mode both --start auto --end 2026-11-20 `
  --initial 1000000 --cost base --data-dir .test-data/backtest-diagnose/data `
  --out .test-data/backtest-diagnose/2026-11-22-volume-family/strict `
  --execution-profile strict
```

## 边界

- 5 只当前存续标的，存在幸存者偏差；不外推到全市场。
- 历史 ST/IPO、权证事件与盘口排队仍未认证；GBBQ 按标的归因只解决坏记录连坐，不证明事件完整。
- 容量只按 `bar.amount × 参与率` 裁剪，不建模冲击成本；成交额缺失时不施加上限。
- 没有样本外、walk-forward 或参数寻优；本批不评价策略优劣。
