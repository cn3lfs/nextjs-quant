# 选股与 RPS

## 职责与非职责

本模块负责本地公式校验/求值、市场池筛选、RPS/行业概念排名、结果分页导出与长任务生命周期。策略分析、订阅信号和研究结论分别归策略信号、研究回测模块；公式候选不会自动变成监控策略。

## 入口与消费者

- UI：`src/app/rps/page.tsx`、`src/app/screen/page.tsx`、`src/components/screening/`。
- 纯规则：`src/lib/formula/`、`src/lib/screening/`、`src/lib/screening/rps.ts` 等兼容根模块。
- 服务与任务：`src/server/screening/`；API procedure 当前包括 `rpsStatus/Start/Cancel/Ranking/Curve`、`conceptRps*`、`industryRps*`、`formulas/saveFormula/checkFormula/formulaScreen`、`screenResults/screenReviews/screenExport`、`onlineScreen*`。
- workers 由 `scripts/build-runtime.mjs` 指定的 `rps-worker.ts`、通用 `worker.ts` 承载；页面通过 tRPC 消费状态与结果。

## 契约与依赖

公式从受限语法输入到 AST/校验问题，再到序列结果；静态门禁须拒绝未来函数。RPS 结果身份、证券池、基准日期和缺失覆盖要可复核；输出由服务端分页/排序，UI 不全量加载后重排。数据读取依赖 market/data-source，持久化依赖 RPS store 和 SQLite，长任务依赖 jobs/worker。

## 状态、副作用与验证

写入公式、RPS 日/值、筛选结果及任务状态；workers 支持进度、取消和失败报告。选股应用用例位于 [screen-job.ts](../../src/server/screening/screen-job.ts)。代表测试：[q2a-formula](../../tests/screening-rps/rps/q2a-formula.test.ts)、[q2b-screening](../../tests/screening-rps/rps/q2b-screening.test.ts)、[rps-worker](../../tests/screening-rps/rps/rps-worker.test.ts)、[screen-results](../../tests/screening-rps/screen-results.test.ts)、[server-layout](../../tests/engineering-validation/server-layout.test.ts)。正确性约束见 [invariants](../invariants.md) 的未来函数、缺失语义和批处理章节。

## 维护指南

新筛选条件需写明输入日期/证券池、数据不足的处理和结果身份；长任务补取消/进度验证。新增用例放在 `tests/screening-rps/`，跨域工程约束归 `tests/engineering-validation/`。
