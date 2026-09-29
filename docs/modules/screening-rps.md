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

**性能**：全市场公式选股的主要成本曾是通达信 `.day` 解码（`parseBars`，每条记录构造 Date 往返校验、数组与补零字符串）。现以数值日历校验与查表实现，全部本地日线（两种价格精度）与 5 分钟样本共 25690 次解析、1.525 亿条记录与旧实现逐条一致，解码耗时约为原来的 1/4.4；`screenFormula` 预读后续 8 个文件、按原顺序消费。基线：6154 只证券默认均线金叉 50.7 s → 15.4 s（同结果）。RPS 回填按 `RPS_PUBLISH_BATCH`（10 天）一个事务发布（`RpsStore.saveDays`），值行按 (symbol,date) 排序写入：表以 symbol 为首键，逐日写入每天要触及约 6000 个分散页面，批量后同一证券的若干天相邻；新旧实现写出的 `rps_days`/`rps_values` 逐行相同，个股 250 天回填 132 s → 55 s。取消最多丢弃一个批次内已计算未提交的天数，已提交日期保留。基线脚本 [screen-perf-browser.mjs](../../tests/screen-perf-browser.mjs)（需已扫描的隔离数据库与生产服务）。

## 维护指南

新筛选条件需写明输入日期/证券池、数据不足的处理和结果身份；长任务补取消/进度验证。新增用例放在 `tests/screening-rps/`，跨域工程约束归 `tests/engineering-validation/`。

**一句话选股**：`formulaFromText` 由模型起草通达信公式，再经 `validateScreenFormula` 门禁（失败时回喂报错修正一次），界面只回填草稿、不自动执行。提示词中的函数和字段表由 `tdx-formula-check.ts` 生成；向引擎新增函数后提示词会自动同步，不要在提示词里手写函数清单。
