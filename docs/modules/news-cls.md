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

新分析字段必须标明证据 ID、来源和时间；不得把当日内容回填成历史时点已知信息。模型只负责有校验的解释，不能调用交易或通知执行接口。`src/server/mcp.ts` 与其 UI 文案不属于本模块的可编辑入口。
