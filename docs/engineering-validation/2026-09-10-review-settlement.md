# 核对材料 T5 清账记录（2026-09-10）

这是 2026-09-10 对十份核对材料的处置记录，保留当时的关闭、转测试和保留给用户裁定及理由；不是新的开发清单，也不代表用户已人工签收。日期、行情截止点、受控 fixture 和旧截图保留原语义；后续状态以[当前计划](../next-plan.md)和[文档入口](../README.md)为准。

唯一用户操作入口是 [review-todo.md](../market-chart/review-todo.md)。

## T5 清账结果（2026-09-10）

本表是十份材料的当前处置状态，覆盖原件中的历史“待确认”、空白签收栏和续做要求；原件保留历史证据，不代表人工通过。

| 材料 | 内容 | 归类 | 理由 / 具体处置 |
|---|---|---|---|
| [m1-tdx-checklist.md](../market-chart/2026-09-10-m1-tdx-checklist.md) | M1 三股指标与口径 | **关闭** | 三项存疑已有材料内独立佐证；同源同起点逐格对照成本过高，关闭例行人工签收，不宣称终端数值一致。 |
| [m2-visual-checklist.md](../market-chart/2026-09-10-m2-visual-checklist.md) | M2 原图表读数与交互 | **关闭** | 旧截图已删除、交互由 Q1 接替；不重建旧版视觉验收。 |
| [m3-visual-checklist.md](../market-chart/2026-09-10-m3-visual-checklist.md) | M3 笔、线段、中枢 | **关闭** | 三股结构合理性需专业逐段复核，几十秒不能作有效裁决；保留算法输出证据，不把截图或 golden 当策略有效性证明。 |
| [m4-message-samples.md](../strategy-signals/2026-09-10-m4-message-samples.md) | M4 四渠道规则与追加解读 | **转测试** | 由 tests/strategy-signals/monitoring/m4-monitor.test.ts 的六类点、四渠道载荷及真实渲染器逐字快照承接；迁移至 strategy-signals 单一原件。关闭排版签收及例行真实飞书试发，零真实投递不等于已验证送达。 |
| [m5-review.md](../strategy-signals/2026-09-10-m5-review.md) | M5 三类双突破案例与阈值 | **关闭** | 材料已有逐项复算及 breakout 持久用例证据；阈值有效性不能靠签字证明，策略验证归 JoinQuant，不再逐表索要认可。 |
| [p1-checklist.md](../portfolio-ledger/2026-09-10-p1-checklist.md) | P1 本地账本与模拟盘边界 | **关闭** | 材料列明账本、服务和模拟契约持久用例；实操已有 Q0 后续记录，冻结模块不追加验证或要求用户开户。实验费用不冒充真实费用。 |
| [p2-message-samples.md](../strategy-signals/2026-09-10-p2-message-samples.md) | P2 分级、限额、静默、去重与汇总 | **转测试** | 由 tests/strategy-signals/monitoring/p2-notification-policy.test.ts 的分级、额度、交易日去重、静默、撤权及逐字汇总断言承接；迁移单一原件，现有可配置默认值无需签收。 |
| [q0-mock-trading-log.md](../portfolio-ledger/2026-09-10-q0-mock-trading-log.md) | Q0 模拟开户、买入与对账 | **关闭** | 买入和对账已有实测；卖出仍未完成且需下一可卖日及委托授权，不是几十秒核对，冻结可选模拟盘不继续实操；保留未完成事实，不重复买入。 |
| [q1-review.md](../market-chart/2026-09-10-q1-review.md) | Q1 当前图表可读性 | **保留给用户** | 30 秒打开本材料的日线默认和暗色截图，只看日期/价格/图例是否可读、是否遮住 K 线；回复“可读”则关闭，或指出一处遮挡/难辨文字以定位修复。其余终端数值、画线手感及 TradingView 等同体验签收关闭，静态截图无法证明这些。 |
| [q2b-review.md](../screening-rps/2026-09-10-q2b-review.md) | Q2b 公式、导出与 DLL 故障 | **关闭** | 材料已有函数手算、未来数据不变性及 DLL 占用回归证据；冻结公式模块不增加逐函数终端兼容认证，未核对的动态参数兼容性仍属已知边界。 |

共 2 项转测试、7 项关闭、1 项保留给用户。转测试复用并迁移已有持久断言，不另造计算验证；`tests/engineering-validation/review-sample-paths.test.ts` 防止重复样本回流。关闭仅结束签收待办，不消除文中已知限制。

N1 的真实交易日积累不是人工签收，不加入本清单；N2/P3 不由旧图提前验收。GPL 对外捆绑属于未来实际分发前的许可决策，本次个人本地使用不触发该决策，也未批准对外分发。最新 exe 状态由管理者负责，本次未验证。

原逐文件目录导航已省略；上述材料按业务模块存放，旧归档路径不再作为入口。
