# 核对材料入口

这些是已交付实现的核对依据，不是新的开发清单，也不代表用户已人工签收。日期、行情截止点、受控 fixture 和旧截图保留原语义；历史材料中的旧执行状态以后续章节及 [当前计划](../next-plan.md) 为准。返回 [文档入口](../README.md)。

## 文件与待用户确认事项

| 材料 | 内容 | 人工状态 / 下一步 |
|---|---|---|
| [m1-tdx-checklist.md](m1-tdx-checklist.md) | 三股指标、早期值、口径佐证 | 建议用户对终端抽查；B 层已降为建议，不阻塞里程碑 |
| [m2-visual-checklist.md](m2-visual-checklist.md) | 原读数、预热及交互核对点 | 未见人工签收；旧截图已删，当前体验以 Q1 为准 |
| [m3-visual-checklist.md](m3-visual-checklist.md) + [m3-review/](m3-review/) | 三股笔/线段/中枢截图 | 笔划分与视觉合理性待用户；机器 golden 不能代判 |
| [m4-message-samples.md](m4-message-samples.md) | 四渠道规则/追加解读样本 | 排版及已配置飞书的真实测试通知待用户；自动测试真实投递 0 |
| [m5-review/README.md](m5-review/README.md) | 有效、假突破、数据不足三个案例及批量证据 | 60 根/0.5%/10 根等阈值、案例分类及结构位待用户 |
| [p1-checklist.md](p1-checklist.md) | T+1、成本、除权、关联信号、模拟盘边界 | 本地口径待用户核对；模拟实操进展以 Q0 最新节为准 |
| [p2-message-samples.md](p2-message-samples.md) | 分级默认值与汇总消息 | 默认阈值、限额/静默/去重和汇总排版待用户 |
| [q0-mock-trading-log.md](q0-mock-trading-log.md) | 模拟开户/买入/查询/对账分阶段原始记录 | 买入成交已核实；卖出仍未完成，下一可卖日续做，不重复买入 |
| [q1-review/README.md](q1-review/README.md) | 当前四周期/画线/坐标/主题/成本线截图 | TradingView 体验目视确认待用户；成本线图有受控 fixture 标注 |
| [q2b-review/README.md](q2b-review/README.md) | 公式门禁/全市场/导出/取消及 DLL 故障证据 | 函数局部口径尚未经真实通达信逐项人工核对 |

N1 还需约 20 交易日真实积累后回答分组 T+N 统计；N2/P3 不能由旧截图提前验收。GPL 对外捆绑决定交用户，见 [许可文件](../../THIRD_PARTY_NOTICES.md)。最新 exe 验证/打包由管理者负责，本次未核实其状态。

## 目录内原始证据导航

- [m3-review/capture.json](m3-review/capture.json)：三股截图元数据；图片入口在 M3 核对表。
- [m5-review/batch.json](m5-review/batch.json)、[capture.json](m5-review/capture.json)：批量运行和三案例截图元数据；PNG 在该目录 README 中逐项链接。
- [q1-review/capture.json](q1-review/capture.json)、[initial-aria.txt](q1-review/initial-aria.txt)：浏览器记录与可访问树；六张图在该目录 README。
- [q2b-review/browser-evidence.json](q2b-review/browser-evidence.json)、[local-evidence.json](q2b-review/local-evidence.json)、[q0-reconciliation.json](q2b-review/q0-reconciliation.json)：浏览器、本地 worker 与模拟对账脱敏证据；图见对应 README。

## 旧路径与已删除材料

四组目录与七份文档已在此集中阅读。**兼容例外**：`tests/m4-monitor.test.ts` 和 `tests/p2-notification-policy.test.ts` 硬编码逐字读取旧 `docs/m4-message-samples.md` / `docs/p2-message-samples.md`。本次不改 tests，因此旧路径保留完全相同的副本；不能在这些样本正文加导航文字，否则快照断言失败。将来获授权修改测试路径后才可移除旧副本；两处内容目前必须一致。

旧视觉/实操脚本仍输出 docs/m3-review、m5-review、q1-review、q2b-review 等原路径，本次未改 tests/，也未运行这些脚本。复现前须另行迁移输出路径；现有 JSON 中保存的历史路径是当时事实，不改写成新拍摄证据。decisions 正文旧路径同样通过本索引定位，正文完整保留。

管理者已删除 m2-review、n3-review 截图以及 A–H/optimization 文档、output，一律不恢复、不建 archive。M2 旧截图链接已去除失效链接并注明由 Q1 接替。程序验证不是“视觉一致”，未填写的用户结论继续留空。
