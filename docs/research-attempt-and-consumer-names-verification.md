# 快评尝试选择与名称消费者验证

2026-09-09，覆盖原方案 A/C 的局部要求。

`screenTaskProgress` 按研究任务创建时间及 ID 选择最近一次尝试，避免旧尝试迟到更新将新尝试替换。回归样本显式设置数据库 `updated_at`，旧排序确实选择错误任务；改用创建时间后通过。候选快评与进度卡共用此选择。

自选、监控订阅和历史信号使用统一 `securityDisplayName`，已知名称优先主档，缺少名称显示“名称待补全”，旁边保留代码。原任务、信号及计算指标不改写。

## 本次复核证据

- `output/consumer-names-http-verification.json`：旧任务更新时间更晚，仍选中 `job-screen-reviews-ui`，读取该尝试 10 份报告。
- `output/playwright/consumer-names-watchlist.txt`：京华激光 SH603607、名称待补全 SH699999。
- `output/playwright/consumer-names-signals.txt`：停用订阅与两个历史信号均显示对应名称及代码。
- 浏览器操作后重新执行 HTTP 验证，任务、订阅和信号深度比对不变，投递记录为 0。
- 本次专项复验 `screen-reviews.test.ts` 与 `local-llm.test.ts`：2 文件 7 测试通过。该改动此前全量检查为 143 文件 675 测试，类型检查、生产构建、桌面准备及冒烟通过；本次仅补验收文档，没有重复全量构建。

样本位于独立临时数据库，自动分析关闭，订阅停用，信号和快评均为固定验证记录。未执行真实模型分析、启用监控或发送消息。此验证不证明交易状态、完整历史证券池或 A–H 整体完成。
