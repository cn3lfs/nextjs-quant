# 候选快评分批回填

2026-09-09，模块 C/E 增量。

原先快评报告虽然分批保存，候选表没有对应解读入口，研究任务也直到结束才返回完整 reportIds。现每次批次进度发布附带已保存 reportIds 的副本；包含缓存复用路径。runtime 在运行中的研究任务 result 中保存这些部分 ID，最终仍返回原完整快评结果。已有终态保护继续阻止取消/失败任务被迟到进度覆盖。

新增 screenReviews 只读取所属选股任务的自动快评子任务 reportIds，并核对报告 contextId 与本任务候选 snapshotId，限定当前候选页最多 50 个快照。不按证券代码搜索任意最新报告，避免混入其他策略、任务或快照。仅返回有界摘要、最多两条风险预览及风险/缺口数量，不带完整证据；用户点击后通过单份档案接口读取全文。

候选表增加 AI 快评列。有对应报告时显示摘要、风险、缺口与完整查看按钮；无报告明确“暂无本任务快评”，不把未运行者算作失败。运行期间每 2 秒读取当前页快评，终态停止轮询。已有快评即便后续批次失败也可查看。

## 验证

- quickResearch 专项验证 Top10 两批发布 5/10 个独立 ID 副本、缓存路径发布部分 ID，未增加模型调用；runtime 专项验证研究尚在运行时 result 已持有已完成报告 ID。
- screenReviews 专项覆盖候选页限制、非本任务/非本快照/非快评报告隔离、有界摘要、证据不传输、失败状态保留已完成报告。三个相关文件 15 项专项通过。
- 全量 143 文件 / 674 测试、typecheck、build（含 runtime）、desktop:prepare、desktop:smoke 通过。
- 隔离库复制原 434 候选及前 10 份行情快照，使用 10 份固定快评样本，先令子任务 running 且关联前 5 份，再改为 completed 且关联 10 份。浏览器不刷新页面自动从 5 个完整快评按钮变成 10 个，独立进度从运行中变为完成，第二批摘要及风险可见。
- 点击第二批第一份报告，全文标题为固定样本 5，关联集泰股份 SZ002909。完成后连续观察 8 秒只有通知记录查询，无 screenReviews 或 archivedReport 重复请求。
- HTTP 摘要 5 份 1326 bytes，10 份 2573 bytes（SuperJSON 数据长度），原选股任务及所有固定报告深度相等。结果 `output/screen-reviews-http-5.json`、`screen-reviews-http-10.json`；脚本 `output/verify-screen-reviews-http.mjs`。
- 页面和网络证据 `output/playwright/screen-reviews-five.txt`、`screen-reviews-ten.txt`、`screen-reviews-detail.txt`、`screen-reviews-stopped.txt`。

本轮没有真实模型请求、重新选股、真实通知、通达信写入或 EXE 打包。测试库状态变化仅用于验证回填，不宣称真实模型速度或额度可用；原 A–H 目标仍需继续逐项验收。
