# 选股与 RPS

## 职责与非职责

本模块负责本地公式校验/求值、市场池筛选、RPS/行业概念排名、结果分页导出与长任务生命周期。策略分析、订阅信号和研究结论分别归策略信号、研究回测模块；公式候选不会自动变成监控策略。

## 入口与消费者

- UI：`src/app/rps/page.tsx`、`src/app/screen/page.tsx`、`src/components/screening/`。
- RPS 纯计算：`packages/quant-rps`，默认当日（1）/3/5/10/20/50/120 交易日；证券资格、涨幅、排名与板块等权聚合只在包内实现。应用 `rps-adapter.ts` 负责复权准备与哈希，`industry-rps.ts` 负责快照校验和应用元数据；旧结果按自身周期读取。
- 纯规则：`src/lib/formula/`、`src/lib/screening/`、`src/lib/screening/rps.ts` 等具名契约。
- 服务与任务：`src/server/screening/`；API procedure 当前包括 `rpsStatus/Start/Cancel/Ranking/Curve`、`conceptRps*`、`industryRps*`、`formulas/saveFormula/checkFormula/formulaScreen`、`screenResults/screenTaskProgress/screenExport`、`onlineScreen*`。
- workers 由 `scripts/build-runtime.mjs` 指定的 `rps-worker.ts`、通用 `worker.ts` 承载；页面通过 tRPC 消费状态与结果。

旧 `screenJob` / `screenLocal` 和 worker `screen` 协议已移除；公式任务仍用 `formula-screen` worker，并以 `screen` 任务类别展示。共享结果类型位于 `screening-result.ts`；双突破批量缓存校验独立于旧选股实现，快照序列化保留当前公式路径。

选股结果查询、首屏摘要与完整导出只接受已完成的 `formula-screen` 输入；任务类别仍为 `screen`。摘要暴露 `isFormulaScreen`，旧任务不作为默认结果、不提供公式页结果链接。旧自动快评服务、API、表格列与设置已移除；公式进度只读取自身任务，不再承诺后续 AI 快评。导出显式列出公式参数和完整结果，排除内部快照及其他输入字段。

## 契约与依赖

公式从受限语法输入到 AST/校验问题，再到序列结果；静态门禁须拒绝未来函数。RPS 结果身份、证券池、基准日期和缺失覆盖要可复核；输出由服务端分页/排序，UI 不全量加载后重排。数据读取依赖 market/data-source，持久化依赖 db/rps-store、db/rps-observations 及任务类型仓储，长任务依赖 jobs/worker。

## 状态、副作用与验证

RPS 的 `waiting` 表示本次尝试因已知前置条件不足而结束，结构化 `waiting.code/message` 与故障 `error` 分开；释放 worker/数据库租约，不发布空排名或使用不复权替代值。普通自动任务仍按每类每日一次尝试，补齐条件后可手动重算；自动观察批次沿用自身调度策略。异常读取、损坏/重复输入和计算错误仍为 `failed`。运行卡、证券池、首页与自动批次日志区分这些状态；真实 worker 重试与日志分类见 `rps-worker.test.ts`、`rps-job.test.ts`、`workflow-rps.test.ts`，真实页面见 `tests/e2e/stock-pool.spec.ts`。

写入公式、RPS 日/值、筛选结果及任务状态；workers 支持进度、取消和失败报告。选股应用用例位于 [formula-screen-service.ts](../../src/server/screening/formula-screen-service.ts)。代表测试：[q2a-formula](../../tests/screening-rps/rps/q2a-formula.test.ts)、[q2b-screening](../../tests/screening-rps/rps/q2b-screening.test.ts)、[rps-worker](../../tests/screening-rps/rps/rps-worker.test.ts)、[screen-results](../../tests/screening-rps/screen-results.test.ts)、[server-layout](../../tests/engineering-validation/server-layout.test.ts)。正确性约束见 [invariants](../invariants.md) 的未来函数、缺失语义和批处理章节。

**性能**：全市场公式选股的主要成本曾是通达信 `.day` 解码（`parseBars`，每条记录构造 Date 往返校验、数组与补零字符串）。现以数值日历校验与查表实现，全部本地日线（两种价格精度）与 5 分钟样本共 25690 次解析、1.525 亿条记录与旧实现逐条一致，解码耗时约为原来的 1/4.4；`screenFormula` 预读后续 8 个文件、按原顺序消费。基线：6154 只证券默认均线金叉 50.7 s → 15.4 s（同结果）。RPS 回填按 `RPS_PUBLISH_BATCH`（10 天）一个事务发布（`RpsStore.saveDays`），值行按 (symbol,date) 排序写入：表以 symbol 为首键，逐日写入每天要触及约 6000 个分散页面，批量后同一证券的若干天相邻；新旧实现写出的 `rps_days`/`rps_values` 逐行相同，个股 250 天回填 132 s → 55 s。取消最多丢弃一个批次内已计算未提交的天数，已提交日期保留。上述耗时为历史性能记录，原性能脚本已不在当前仓库，不能作为本批性能结论。当前公式功能验收见 [p0-workflow.spec.ts](../../tests/e2e/p0-workflow.spec.ts)，不等同于全市场性能测试。

## 维护指南

新筛选条件需写明输入日期/证券池、数据不足的处理和结果身份；长任务补取消/进度验证。新增用例放在 `tests/screening-rps/`，跨域工程约束归 `tests/engineering-validation/`。

**一句话选股**：`formulaFromText` 由模型起草通达信公式，再经 `validateScreenFormula` 门禁（失败时回喂报错修正一次），界面只回填草稿、不自动执行。提示词中的函数和字段表由 `tdx-formula-check.ts` 生成；向引擎新增函数后提示词会自动同步，不要在提示词里手写函数清单。
