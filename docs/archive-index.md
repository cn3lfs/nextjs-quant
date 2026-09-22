# 中途记录归档索引

中途计划、验收、审计、执行和阶段交接记录按文件系统创建日期归档。目录名为 `YYYY-MM-DD`，文件名前两位为同日创建顺序；排序依据是本次重构时读取到的 `CreationTime`，同一时间按原文件名排序。

根目录保留长期有效的入口、规范、架构、当前计划、结果表、运行契约和机器登记表。旧交接、外部调研、阶段性适配说明、策略审计和复盘设计已按本次收纳日期归入 [2026-09-22 收纳目录](archive/2026-09-22/README.md)。`docs/review/`、`docs/tasks/` 是已有的稳定核对材料/任务设计子树，`docs/trading-skills-source-snapshots/` 是受保护的原始快照，均保持原路径和字节不变。

根目录同名文件若标记为“兼容指针”，只负责把旧引用导向实际归档文件；历史正文只存在于日期目录。

## 归档清单

| 创建日期 | 文件 |
| --- | --- |
| 2026-09-10 | [01-ui-plan.md](2026-09-10/01-ui-plan.md)、[02-review-plan.md](2026-09-10/02-review-plan.md) |
| 2026-09-11 | [01-tdx-full-day-import.md](2026-09-11/01-tdx-full-day-import.md) |
| 2026-09-14 | [01-workflow-plan-2026-09-11.md](2026-09-14/01-workflow-plan-2026-09-11.md)、[02-tdx-data-optimization-progress.md](2026-09-14/02-tdx-data-optimization-progress.md) |
| 2026-09-15 | [01-tstdx-handshake-fix.md](2026-09-15/01-tstdx-handshake-fix.md)、[02-data-source-execution.md](2026-09-15/02-data-source-execution.md)、[03-tstdx-acceptance.md](2026-09-15/03-tstdx-acceptance.md)、[04-tstdx-feature-parity.md](2026-09-15/04-tstdx-feature-parity.md)、[05-tstdx-library-comparison.md](2026-09-15/05-tstdx-library-comparison.md) |
| 2026-09-16 | [01-trading-skills-volume-audit.md](2026-09-16/01-trading-skills-volume-audit.md)、[02-trading-skills-swing-audit.md](2026-09-16/02-trading-skills-swing-audit.md)、[03-trading-skills-swing-indicators-position-audit.md](2026-09-16/03-trading-skills-swing-indicators-position-audit.md)、[04-trading-skills-risk-audit.md](2026-09-16/04-trading-skills-risk-audit.md)、[05-trading-skills-sepa-audit.md](2026-09-16/05-trading-skills-sepa-audit.md)、[06-trading-skills-canslim-audit.md](2026-09-16/06-trading-skills-canslim-audit.md)、[07-trading-skills-execution-optimization.md](2026-09-16/07-trading-skills-execution-optimization.md)、[08-trading-skills-b1-handoff.md](2026-09-16/08-trading-skills-b1-handoff.md)、[09-trading-skills-execution.md](2026-09-16/09-trading-skills-execution.md) |
| 2026-09-17 | [01-trading-skills-round-review.md](2026-09-17/01-trading-skills-round-review.md) |
| 2026-09-22 | [本次收纳目录](archive/2026-09-22/README.md)：交接、操作、数据源、研究、策略审计、交易复盘 |

## 现有稳定子树

- [review/README.md](review/README.md)：历史 UI、行情、模拟交易和消息核对材料入口。
- [tasks/](tasks/)：交易复盘等任务设计与交付边界。
- [trading-skills-source-snapshots/README.md](trading-skills-source-snapshots/README.md)：只读来源正文快照；不得自动刷新、格式化或改字节。
