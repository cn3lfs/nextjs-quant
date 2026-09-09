# 证券名称显示与候选搜索核验

2026-09-09。模块 A/C 的本次增量，不代表原 A–H 方案整体完成。

候选、排除项、行情标题和已加载品种优先显示证券主档名称；主档缺名时使用有效归档名，否则显示“名称待补全”。归档名与当前名不同时，标题提示保留原名称。候选服务端搜索同时匹配代码、归档名和当前主档名。仅有搜索文字时读取主档名称映射，空查询分页不增加目录读取。

名称只作用于展示和检索，分页记录与导出继续返回原始候选，历史快照、价格、指标和任务不改写。

## 实测证据

- 隔离数据库中的 sh603607 候选和快照使用“旧名称样本”，主档来自只读本地资料，为“京华激光”。自动分析关闭。
- 生产构建的真实 HTTP 接口：新名、旧名、代码三种查询各命中 1 条。分页候选与原候选深度相等，导出候选不变，SQLite 快照与任务深度相等，报告数为 0。
- 真实浏览器：新名/旧名均搜到当前名称候选；“研究”跳转后下拉框及行情标题显示“京华激光”，原日线快照仍截至 2026-09-07，共 300 根。浏览器操作后再次核验 HTTP/数据库，证据仍未改写。
- 验证脚本 `output/verify-security-display-http.mjs`，结果 `output/security-display-http-verification.json`；页面证据 `output/playwright/security-display-current-search.txt`、`security-display-archived-search.txt`、`security-display-research.txt`。
- `pnpm typecheck`、`pnpm test`（140 文件、666 测试）、`pnpm build`（含 runtime）、`pnpm desktop:prepare`、`pnpm desktop:smoke` 均通过。没有打包 EXE，没有调用模型、发送通知或写入通达信数据。

## 未覆盖边界

本次不改写报告正文或归档标题；研究档案的独立证券上下文及其他主档消费者仍需逐项核验。主档完整字段、历史证券池成员资格、全部数据质量状态及原方案其他模块尚未整体验收。
