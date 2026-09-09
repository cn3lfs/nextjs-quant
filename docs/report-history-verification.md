# 通用报告分页与按需读取

2026-09-09，模块 C 增量。

## 行为

原工作台无论当前页签，每 6 秒读取最多 100 份完整通用报告。现改为仅在研究档案页挂载报告列表，默认每页 20 条摘要。SQLite 投影 id、创建时间、截短标题及独立证券关联，不返回正文、证据、技能资料等完整字段。按创建时间和 id 降序游标翻页，可访问超过 100 份报告；新增记录不会使已保存游标重复返回前页记录。

点击报告后按 id 读取完整档案，并缓存不变的正文，不设详情轮询。当前名称仍来自证券主档，报告本身及原导出保持不变。首页轻量摘要在有活动任务时每 2 秒更新，空闲时每 30 秒更新；历史页不定时刷新。手动刷新回到首页。旧 reports API 为兼容调用者保留，工作台不再使用它。

## 证据

- 125 报告专项测试：七页 20/20/20/20/20/20/5，125 个唯一 id，原记录与详情一致；同创建时间、新报告插入、未知/非报告 id 均覆盖。摘要不携带证据或额外字段，测试序列化负载小于 20 KB。
- 完整 `pnpm typecheck`、`pnpm test`（142 文件、671 测试）、`pnpm build`（含 runtime）、`pnpm desktop:prepare`、`pnpm desktop:smoke` 通过。
- 生产 HTTP 隔离样本 45 报告：三页 20/20/5，45 个唯一 id；SuperJSON 数据序列化长度分别 3221/3216/860 bytes。旧完整接口同样本 7,941,037 bytes。这是含大证据字段的固定样本，不能推广为所有真实数据库的固定压缩比例。结果 `output/report-history-http-verification.json`。
- 浏览器实际翻到第三页，末页下一页禁用，选中原始报告显示完整正文及当前名称。导出 Markdown 的 SHA256 与分页改造前保存文件一致。
- 网络观察：详情打开后 8 秒无 reports/archivedReport 请求；首页插入固定第 46 份报告后观察 32 秒，出现 reportHistory 请求，自动展示新增样本，详情未重取；离开档案页后 8 秒无报告相关请求。原始日志在 `output/playwright/report-history-*-network.txt`，断言结果 `output/report-network-verification.json`。活动任务的 2 秒配置分支尚未在本次浏览器样本中单独测频率。
- 页面证据 `output/playwright/report-history-first.txt`、`report-history-second.txt`、`report-history-third.txt`、`report-history-detail.txt`、`report-history-refreshed.txt`。

测试报告为隔离库固定样本，未发起模型、交易或通知；未修改通达信数据，未打包 EXE。此次仅完成通用报告的历史传输和分页链路，其余任务阶段、其他数据面板以及 A–H 整体验收仍需继续。
