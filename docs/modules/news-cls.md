# 新闻与财联社复盘

## 职责与非职责

新闻域采集/读取原始新闻和市场主题，聚合、分析并保存报告；CLS review 是原始报告/事实样本的复核流程。来源事实、模型解读和人工修订需可区分。策略执行与研究样本治理不由新闻组件拥有。

## 入口与消费者

- 页面：`src/app/news/page.tsx`、`src/app/cls-review/page.tsx`；展示组件位于 `src/components/news/`。
- 服务：`src/server/news/`，涵盖预算、新闻日聚合、sector/themes、CLS 文件/调度/校验；数据源在 `src/server/data-sources/cls/`。
- API：`news*`、`analyzeNews*`、`aggregateNewsDay`、`themePrices*`、`clsReview*`、`newsBudget` 等当前装配于 root router。

## 契约与依赖

原文、来源时间、发布日期、聚合日和模型观点需分层；CLS parser 对文件格式负责，review store/service 对校验/复核状态负责。外部内容由 data-source 提供，纯分类/因子规则归 `src/lib/news/`，服务依赖 SQLite、jobs/调度器和模型 adapter。

## 状态、副作用与验证

保存分析/复核结果、调度与预算使用状态；运行可能读取本地报告文件、访问新闻数据源或调用模型。代表测试：[cls-review-integration](../../tests/news-cls/cls-review-integration.test.ts)、[cls-report-parser](../../tests/news-cls/cls-report-parser.test.ts)、[news-analysis](../../tests/news-cls/news-analysis.test.ts)、[news-scheduler](../../tests/news-cls/news-scheduler.test.ts)。

## 维护指南

新闻截止时间、关键词和历史时点开关统一作为草稿，Enter/“查询新闻”提交并回到第一页。“刷新至当前时间”一次性提交条件，仅在查询键不变时手动 refetch。存在未提交条件、读取失败或模型信息未取得时禁用新分析，既有报告始终按自己的冻结输入展示。静态预渲染仅输出稳定加载状态，挂载后才恢复当前时间、URL和会话游标，避免构建时的日期造成 hydration 不一致。

`newsWorkspace` 返回50条摘要和基础筛选总数；`newsOriginal` 按源代际、ID及范围只读完整原文。源库不建索引或迁移。原文hash保留既有完整字段口径；`pageSelection` 在同一只读事务内核对有序ID/hash，再冻结模型输入。旧 `readClsNews` 和 `newsAnalyses` 保留后台/兼容职责，不能替换成摘要读取。

`newsArchiveHistory` 全历史每页20个档案ID，不再先截50份或隐藏相同新闻集合；按归档时间及ID排序，续作可能更新时间。`newsResumePreflight` 只读比较原/当前方法和模型，版本改变时明确创建新身份，执行用 `expectedVersion` 再校验。模型正文上限2000字符与完整原文导出分别说明。任务状态走 `newsTaskState` 元数据，终态才读取实际结果；隐藏页不轮询、不跳转，行业/主题展开后才加载，全文证据不进入持久缓存。

验证入口：`tests/news-cls/news-workspace-query.test.ts`、`news-analysis.test.ts`；`tests/news-workspace-browser.mjs`、`news-workspace-lifecycle-browser.mjs`、`news-workspace-memory-browser.mjs`；性能与负对照为同名前缀的 query-perf/http-perf/perf-browser/negative-controls。这些验证使用隔离合成数据，不代表真实模型或实源结果。

新分析字段必须标明证据 ID、来源和时间；不得把当日内容回填成历史时点已知信息。模型只负责有校验的解释，不能调用交易或通知执行接口。`src/server/mcp.ts` 与其 UI 文案不属于本模块的可编辑入口。

## 财联社观点复盘工作区

`cls-review-controls.tsx` 保持页面入口，组装位于 `cls-review-workspace.tsx`；报告列表、事实核对、价格观察、导入、调度与分段阅读各有独立组件。查询规格和草稿revision在 `src/lib/news/cls-review-workspace.ts`，页面查询在 `src/server/news/cls-review-query.ts`；原存储、解析、选样和价格算法继续负责原有业务口径。

`clsReviewReportPage` 是20+1条元数据分页，标题按字面包含匹配，日期指报告日期，排序按导入记录时间/id。游标绑定筛选；新增记录需刷新到第一页，删除不构成跨请求数据库快照。URL保存应用条件、reportId和视图；会话只保存游标位置，事实草稿不写URL或持久缓存。草稿按reportId/revision管理，晚到的保存完成不能清空后来编辑的内容。

`clsReviewFactPage` 分当前结论和追加历史，统计始终覆盖该报告所有最新主张（章节+完整摘录），不受页码与结论筛选缩小。排序/统计共用单条SQL中的元数据CTE，仅为当前21个ID读取完整payload；列表摘录200字符、依据500字符，截短有标识，`clsReviewFactDetail` 按reportId/id读取完整证据。

`clsReviewVerificationPage` 返回版本、来源和观察结果，行情数组仅由 `clsReviewVerificationDetail` 按日期/hash读取。关联样本日期由 `clsReviewReportSamples` 查询；独立按日读取显式说明报告归属。`clsReviewSampleEligibility` 只读当前时间、报告和日历条件，实际固定仍由原服务二次校验，删除保留日期占位，不能重选。顶部价格统计仍取各日最新核对，与人工事实支持率独立。

所有页面查询受可见性控制，调度后台本身不因隐藏页停止。全文按8000个UTF-16码元分段显示并保护代理对边界；回看事实可定位所属章节的匹配段，重复摘录不保证唯一字符位置。完整导出不受分页/分段裁剪。重试导出会清除旧错误并释放Blob URL；清理目标绑定明确报告ID，不能删除外部Markdown源文件。

验证：`tests/news-cls/cls-review-workspace.test.ts`、既有CLS集成/解析/调度测试；浏览器入口为 `tests/cls-review-browser.mjs`、`cls-review-recovery-browser.mjs`、`cls-review-lifecycle-browser.mjs`，性能/压力/负对照同前缀。均使用显式隔离数据目录与合成证据，不代表真实预测正确率或交易收益。
