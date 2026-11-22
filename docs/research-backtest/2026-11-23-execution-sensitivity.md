# 执行与容量敏感性（2026-11-23）

> 流程诊断，不是策略业绩；不做收益排名，不做策略间收益比较。比较的是成交可行性、拒绝与账本一致性，不是策略优劣。

本批在五标的诊断矩阵上增加两类诊断开关：执行滑点 profile 与成交额参与率上限。目标是回答“成交假设会不会改变策略行为”，再决定研究默认口径。默认生产行为不变。

## 运行口径

| 项目 | 取值 |
| --- | --- |
| 单元 | 每档 36（per-symbol 30 + portfolio 6） |
| 标的 | `sh600519, sz000001, sh601318, sz000333, sz300750` |
| 策略 | `dual-ma, turtle, rsi2, double-breakout, formula` + `hold` 对照 |
| 行情 | `E:/new_tdx64` 只读，日线截止 2026-11-20 |
| 资金/费用 | 1,000,000 / `base` |
| 数据隔离 | `QUANT_DATA_DIR=.test-data/backtest-diagnose/data` |
| 状态 | 五档全部 **36/36 ok，0 blocked，0 failed** |

五档：

1. `strict`：当前默认，滑点越界拒绝
2. `clamp`：滑点越界按当日 high/low 成交，停牌/一字/涨跌停仍拒绝
3. `no-slippage`：按 open 成交，滑点不作为价格
4. `strict + maxParticipation 0.5% + clip`
5. `strict + maxParticipation 1.0% + clip`

## 总体结果

| 档位 | fills | 成交额（亿元） | 费用（万元） | 拒绝尝试 | 平仓 | capacity 裁剪 fills |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| strict | 5,762 | 467.5 | 3,470 | 718 | 2,865 | 0 |
| clamp | 6,054 | 391.6 | 2,958 | 238 | 3,010 | 0 |
| no-slippage | 6,028 | 317.6 | 2,404 | 257 | 2,997 | 0 |
| cap 0.5% clip | 6,598 | 119.4 | 888 | 667 | 2,916 | 1,192 |
| cap 1.0% clip | 6,398 | 156.6 | 1,166 | 688 | 2,907 | 869 |

**不要用 fills 数直接比较档位**：容量裁剪会把大单拆成多日分笔，fills 反而增加；成交额、费用和仓位路径才是有效比较口径。同理，各档成交额不同包含现金/权益路径差异，不是“多成交等于更好”。

## 按模式拆分

| 档位 | 模式 | fills | 成交额（亿元） | 费用（万元） | 裁剪 fills |
| --- | --- | ---: | ---: | ---: | ---: |
| strict | per-symbol | 3,932 | 462.5 | 3,435 | 0 |
| strict | portfolio | 1,830 | 5.0 | 35 | 0 |
| clamp | per-symbol | 4,139 | 387.0 | 2,925 | 0 |
| clamp | portfolio | 1,915 | 4.6 | 33 | 0 |
| no-slippage | per-symbol | 4,111 | 312.9 | 2,370 | 0 |
| no-slippage | portfolio | 1,917 | 4.7 | 34 | 0 |
| cap 0.5% | per-symbol | 4,768 | 114.5 | 853 | 1,192 |
| cap 0.5% | portfolio | 1,830 | 5.0 | 35 | 0 |
| cap 1.0% | per-symbol | 4,568 | 151.7 | 1,131 | 869 |
| cap 1.0% | portfolio | 1,830 | 5.0 | 35 | 0 |

关键差异在 **单标的全历史**：容量 0.5% 把单标的成交额从 462.5 亿压到 114.5 亿（约 -75%）；而 2018-06-11 起的 5 标的组合完全不触发容量裁剪（单笔相对日成交额太小）。

## 按策略拆分（单标的，strict / clamp / no-slippage）

| 策略 | strict fills / 成交额（亿） | clamp fills / 成交额（亿） | no-slippage fills / 成交额（亿） |
| --- | ---: | ---: | ---: |
| dual-ma | 1,165 / 267.7 | 1,300 / 222.0 | 1,294 / 134.6 |
| turtle | 666 / 84.6 | 688 / 69.1 | 678 / 75.1 |
| rsi2 | 1,162 / 25.4 | 1,172 / 16.9 | 1,168 / 18.2 |
| double-breakout | 178 / 0.6 | 182 / 0.6 | 182 / 0.6 |
| formula | 756 / 84.3 | 792 / 78.3 | 784 / 84.3 |
| hold | 5 / 0.05 | 5 / 0.05 | 5 / 0.05 |

- `dual-ma` 对滑点模型最敏感：strict 的 267.7 亿路径在 clamp/no-slippage 下降到 222.0/134.6 亿；这不是单纯多成交，而是不同的成交时点与资金路径。
- `turtle`、`formula` 方向类似但幅度较小；`rsi2` 的 fills 多、单笔小，成交额对价格路径敏感。
- `double-breakout` 成交很少，三档几乎一致。
- `hold` 不受影响（仅建仓一次）。

## 组合结果

组合窗口为 2018-06-11 ~ 2026-11-20，五只等权、共享资金：

- strict：1,830 fills / 5.0 亿成交额 / 35 万费用
- clamp：1,915 fills / 4.6 亿 / 33 万
- no-slippage：1,917 fills / 4.7 亿 / 34 万
- cap 0.5%/1.0%：与 strict 完全相同（1,830 / 5.0 亿），没有裁剪

组合层的滑点 profile 仍会改变 fills 与成交路径，但成交额变化远小于单标的全历史；容量上限在该组合规模下不绑定。

## 结论与建议

1. **strict 作为保守基线保留**。它把“滑点后价格越出当日可观察范围”视为不可成交，拒绝率最高，最不容易高估可成交性。
2. **clamp 应作为策略研究的强制敏感性档**，而不是直接替换默认。它把拒绝尝试从 718 降到 238，但成交额也从 467.5 亿降到 391.6 亿；策略结论若在 strict/clamp 之间翻转，应标为“执行假设敏感”，不能当作稳健结论。
3. **no-slippage 只作零滑点敏感性情景**，不建议作为默认；它进一步把成交额降到 317.6 亿，且不反映真实滑点，也不是“可成交上界”。
4. **容量默认关闭，但单标的全历史/早期历史研究应启用 0.5%–1% 参与率上限**。本批 0.5% 对单标的成交额削减约 75%，1.0% 约 67%；对 2018+ 的 5 标的组合不绑定。
5. **报告口径**：以后策略诊断至少并列 `strict` 与 `clamp`，并注明成交额/费用/拒绝；单标的全历史再加容量档。不要把 strict 的 fills 或收益单独当作可执行结论。

## 产物

- 根目录：`.test-data/backtest-diagnose/2026-11-23-execution-sensitivity/`
- 五档运行根：`<档位>/run-*/`，每档含 36 个单元的 `summary.json`、`diagnostics.json`、`fills.csv`（含 `capacityClipped` 列）、`report.md`
- 日志：`logs/{strict,clamp,no-slippage,cap-0.5-clip,cap-1.0-clip}.log`
- 复现命令（示例）：

```powershell
pnpm exec tsx scripts/backtest-diagnose.ts `
  --symbols "sh600519,sz000001,sh601318,sz000333,sz300750" `
  --strategies "dual-ma,turtle,rsi2,double-breakout,formula" --controls hold `
  --mode both --start auto --end 2026-11-20 `
  --tdx-root E:/new_tdx64 --initial 1000000 --cost base `
  --data-dir .test-data/backtest-diagnose/data `
  --out .test-data/backtest-diagnose/2026-11-23-execution-sensitivity/clamp `
  --execution-profile clamp
```

## 边界

- 本批只覆盖 5 只当前存续标的；存在幸存者偏差，不能外推到全市场。
- 滑点 profile 与容量都是研究情景；不代表真实盘口排队、冲击成本或可成交量。
- 成交额/费用随路径变化，不是收益比较；本批没有做样本外、walk-forward 或参数寻优。
- 容量裁剪只作用于 `bar.amount > 0` 的成交；成交额缺失时引擎不施加参与率上限。
