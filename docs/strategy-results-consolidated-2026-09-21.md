# 交易策略与回测结果收口登记

日期：2026-09-21
性质：研究资产整理和结果登记，不是收益评价，不构成交易建议

## 1. 已证实

### 1.1 已执行回测批次

| 批次 | 已证实结果 | 解释边界 |
| --- | --- | --- |
| B3，`entryMaxWait=3` | 日线/月线 252/252；1,304,017 个事件；296,610 个闭合 round trip；交易数组长度 297,340 | 事件观察和固定实验撮合，不是盈利证明；标签“样本不足”167、“无交易”85 与“产生信号项”163 不是同一统计口径 |
| B3 网格，`entryMaxWait=5` | 日线/月线 170/170；310,245 个闭合 round trip；交易数组长度 310,994 | 独立实验条件，不与其他档相加 |
| B3 网格，`entryMaxWait=10` | 日线/月线 170/170；321,166 个闭合 round trip；交易数组长度 321,934 | 独立实验条件，不与其他档相加 |
| B3 网格横向 | 170 个可比预设中，118 个发生变化、52 个未变化 | 不能据此选择最好档或证明泛化 |
| B4，Wyckoff/缠论 | 目标 48 个，已形成 46 个 canonical raw；两个中阴目标没有最终归档 | 不能登记 B4 48/48，也不能用进程状态代替结果 |
| B5，K8 五分钟 | `records.json` 29 条，29 条均为“样本不足”，窗口为独立五分钟锚 | `corporateActionFree=0`，交易模拟不可用；只保留为中间归档事实，不能与日线/月线结果合并比较 |

批次级原始交付证据：`.codex-runs/s101-manager-delivery.md`、`.codex-runs/s120-manager-delivery.md`。B5 当前文件证据为 `.codex-runs/r3-results/b5-full-min11/summary.json` 与 `records.json`。

### 1.2 代表策略登记

独立 package 目录在 [`packages/trading-strategies`](../packages/trading-strategies/README.md)，共保留 9 个大方向代表。完整方法不删除，仍由 `docs/trading-skills-method-map.json` 和源代码负责溯源。

| 方向 | 代表 | 状态 | 已保留证据 |
| --- | --- | --- | --- |
| 双突破 | `SW01 / sw-double-prior20` | B3 完成归档，标签为样本不足 | B3 raw、result hash、开发/验证分区统计 |
| 技术指标共振 | `SW11-confluence-count / sw-confluence` | B3 完成归档，标签为样本不足 | B3 raw、result hash、开发/验证分区统计 |
| 量价 | `VP-vp-up-expanded-confirm / vp-up-expanded-confirm` | B3 完成归档，标签为样本不足 | B3 raw、result hash、开发/验证分区统计 |
| Wyckoff | `WY02 / wy-sos-daily` | B4 部分批次中已有 raw；当前观察 0 事件 | raw、hash、覆盖警告 |
| 缠论 | `CH03 / chan-third-native` | B4 部分批次中已有 raw；387 个结构观察、0 个闭合交易 | raw、hash；czsc 基线未独立验证 |
| 成长股 | `CA-B-N2 / canslim-high-98` | 已实现，未真实回测 | 方法表与实现边界 |
| 价值 | `FA08` | 工程版本，S7 未开始 | 方法表 |
| 情绪 | `MS04` | 工程版本，S7 未开始 | 方法表 |
| 产业链 | `IC04` | 工程版本，S7 未开始 | 方法表 |

### 1.3 数据与解释边界

- 回测证券池是当前中证 A500 成分快照，不是历史时点成分，存在存活者/成分偏差。
- 公司行动和量能可比性覆盖不是 `full`；有效池不足、无交易和零信号优先按数据覆盖或样本条件解释。
- 固定输入测试和回测统计是程序/研究证据，不是已验证的可交易盈利证据。
- 依赖 czsc 输出的方法不能据未经验证的 czsc 基线判断实现正确性。
- S5 是财务数据快照链路，income 事实数量不能当作策略结果；S7 的 217 个方法真实回测尚未开始。

## 2. 未完成与不假装完成

| 项目 | 当前登记 |
| --- | --- |
| B2 | 133 个预设未执行；`b2/raw` 为空，旧 `.stale` 不算当前结果 |
| B4 | 46/48 raw，两个 `chan-zhongyin-*daily-native` 缺少最终归档；不能写成完成 |
| S5 | 取数/冻结链路部分完成，仍是研究输入，不是回测 |
| S7 | 217 个因子方法真实回测未开始 |
| SuperMind 替代、本地复权口径分歧、B2 跨预设复用 | 保持待用户裁定，不由本登记代替决定 |

## 3. 中间产物清理登记

本轮清理前，`.codex-runs` 实测约 37.908 GB，其中 `r3-results` 约 34.63 GB。最终精确清理清单删除 1,169 个文件、35,715,061,923 bytes（约 33.262 GiB）；此前另有一个已核实的 B3 stale 目录单独按精确路径删除，未计入这组清单数字。

清理后复核：`.codex-runs/r3-results` 剩 13 个文件、125,384,078 bytes（约 0.117 GiB），只包括 5 个代表策略 raw 和 8 个批次 `records.json/summary.json`；`.codex-runs` 总量约 3.393 GB，S5 保留约 2.294 GB。5 个代表 raw 已逐个 `JSON.parse`；S5 未删除。

实际删除范围：B3/B3-w5/B3-w10 的非代表 raw、数据集和 shard；B4 的非代表 raw、shard、single-ledger、smoke/staging；B5 的 raw/shard 和 smoke 数据集；B2/B3/B5 的 stale 目录；S14 共享数据集。未删除源代码、方法表、S5 canonical/refreeze 或 protected snapshots。

未建立独立备份。被删除的 ignored raw/数据集不能从 Git 恢复；留下的是批次摘要、代表 raw、方法表、源码和本报告。范围外已有的 5 个 `dual_ma_strategy_回测结果_20260918_120111` 跟踪文件删除状态未纳入本轮清理，也未被恢复或提交。

## 4. 不能从结果推出的结论

本登记不做“某策略最好”“某参数最优”“胜率提升百分比”“盈利能力”“可实盘”等结论。特别是网格成交数只反映实验条件变化；零信号/有效池为 0/样本不足保留为事实，不删除、不重跑到好看为止。

## 5. 本轮实现与验证

- 新增 `packages/trading-strategies`，导出 9 个代表方向；包内不读取数据库、通达信路径或回测 raw。
- package 测试：1 个文件、3 个测试通过；package typecheck 和 build 通过。
- 仓库根 `npx.cmd tsc --noEmit` 在最后一轮源码改动后退出 0。
- 5 个保留代表 raw 已逐个 JSON 解析，并与 package 登记的结果 hash 逐项相等；9 个 family 检查为一一对应。
- Markdown 链接检查：192 个文件、0 个缺失链接；`git diff --check` 通过。
- 未修改 `src/server/mcp.ts`、source lock、source snapshots；未访问通达信目录、未打开数据库、未下载付费数据。
- 本轮未提交、未推送。当前分支仍比 `origin/master` 超前 3 个已有本地提交；工作区原有 5 个 `dual_ma_strategy_回测结果_20260918_120111` 跟踪文件删除状态未处理。
