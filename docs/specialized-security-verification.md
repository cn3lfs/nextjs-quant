# 专门研究档案名称显示

2026-09-09，模块 A 增量。

CANSLIM、缠论、威科夫、基本面四类报告的历史选择列表及报告详情，均从 `securityNames` 的共享查询缓存读取当前主档名称，保留原证券代码与原报告标题。缺名使用统一“名称待补全”。名称不写入报告、方法资料、证据或导出。

## 验证

- `pnpm typecheck`、`pnpm test`（141 文件、669 测试）、`pnpm build`（含 runtime）、`pnpm desktop:prepare`、`pnpm desktop:smoke` 通过。
- 复制四类已有历史报告到新的隔离数据库，自动分析关闭，无新模型请求。生产 HTTP 四类历史接口均解析 sh600519，当前主档名为贵州茅台；四类详情接口与原报告深度相等，隔离库存储和原库报告不变。
- 实际浏览器选择四类报告，四个历史选项及四处详情均显示贵州茅台及代码，原标题保留。证据：`output/playwright/specialized-security-list.txt`、`specialized-security-details.txt`。
- 点击缠论、威科夫、基本面的下载按钮，三个 JSON 下载均与原档案深度相等。CANSLIM 本身无独立下载按钮，本次不声称验证其下载。结果：`output/specialized-security-downloads.json`。
- HTTP/源档案比对脚本 `output/verify-specialized-security.mjs`，结果 `output/specialized-security-verification.json`；下载比对脚本 `output/verify-specialized-downloads.mjs`。

本次没有写入通达信数据、发送通知或打包 EXE。该证据覆盖四类报告名称展示，不代表方法本身、其他品种模块或原 A–H 整体目标验收完成。
