# 交易策略收口与结果清理计划

日期：2026-09-21
范围：交易策略目录、已执行回测的可复核摘要、`.codex-runs` 中的中间计算产物
目标：保留每个大方向一个代表性策略，形成独立 package，并回收无法直接支撑结论的中间文件

## 1. 收口原则

1. “代表性”按方法方向和可解释性选取，不按收益挑最好的一档。
2. 原始方法表、源代码和受保护快照继续保留，package 只暴露代表策略目录。
3. 已完成、部分完成、未开始、数据覆盖缺口分开登记。
4. 零信号、样本不足、有效池为 0 都只记录为当前输入下的计算事实，不登记为策略无效。
5. `entryMaxWait=3/5/10` 是不同实验条件；不把三档成交数相加，也不把某一档登记为“最优”。
6. package 不依赖 `.codex-runs` 运行；回测路径和 hash 只作为证据索引，不把中间产物打包。

## 2. 代表策略边界

| 方向 | 唯一代表 | 结果状态 |
| --- | --- | --- |
| 双突破 | `SW01 / sw-double-prior20` | B3 完成归档，样本不足 |
| 技术指标共振 | `SW11-confluence-count / sw-confluence` | B3 完成归档，样本不足 |
| 量价 | `VP-vp-up-expanded-confirm / vp-up-expanded-confirm` | B3 完成归档，样本不足 |
| Wyckoff | `WY02 / wy-sos-daily` | B4 部分归档，当前无事件 |
| 缠论 | `CH03 / chan-third-native` | B4 部分归档，czsc 基线未独立验证 |
| 成长股 | `CA-B-N2 / canslim-high-98` | 已实现，未真实回测 |
| 价值 | `FA08` | 工程版本，S7 未开始 |
| 情绪 | `MS04` | 工程版本，S7 未开始 |
| 产业链 | `IC04` | 工程版本，S7 未开始 |

重复 preset ID 不作为独立 package 标识；入口采用稳定 package ID，并同时记录 source method ID 和 preset ID。

## 3. 清理策略

### 保留

- `packages/trading-strategies` 的目录、类型、测试和 README。
- `docs/strategy-results-consolidated-2026-09-21.md` 的结果登记。
- `docs/trading-skills-method-map.json`、源代码、测试和受保护的 source snapshots。
- B3/B3-w5/B3-w10 的 `records.json`、`summary.json`，用于保留批次级结果摘要。
- 每个已执行代表策略的 raw 文件：B3 三个、B4 两个。
- S5 的 canonical/refreeze 快照；它是数据研究输入，不是回测中间产物。

### 删除

- B3/B3-w5/B3-w10 的全量 raw 和日线数据集缓存，只保留代表 raw 与批次 summary/records。
- B4 的非代表 raw、shard/ledger、smoke/staging 归档和数据集缓存。
- B5 的全量五分钟 raw 与分钟数据集；只保留已有批次 summary/records，因为 B5 不是 package 代表策略的单独目录。
- 已标记 stale、失败、重复运行的回测目录。

删除前检查：无回测进程正在写入目标；逐路径计算字节数；删除后重新计算并将实际结果登记。恢复依赖 Git/系统回收站之外的备份时，报告明确写“未建立独立备份”。

## 4. 验收

- package：独立 `test`、`typecheck`、`build` 通过；测试确认每个 family 只有一个代表且未回测项没有 evidence。
- 文档：只保留关键文档在 `docs` 根目录；新增报告不生成中转指针。
- 清理：删除范围内无目标文件残留；保留代表 raw 可逐个 `JSON.parse`；受保护路径无差异。
- Git：本轮不自动提交、不推送；若后续授权提交，package、文档和清理登记作为同一可审查变更提交。
