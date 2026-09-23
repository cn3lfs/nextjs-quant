# 研究与回测

## 职责与非职责

研究域装配当时可得的数据证据、来源、方法和报告；回测域管理输入快照、模拟执行、公司行动/成本口径、worker 生命周期和结果。它不改写真实账本事实，也不把规则自检升级为正式业绩证明。

## 入口与消费者

- UI：`src/app/research/page.tsx`、`src/app/backtest/page.tsx`、`src/components/research/`、`src/components/backtest/`。
- 服务：`src/server/research/`、`src/server/backtest/`；分析包括方法证据和绩效查询，回测包括 worker、动作、分红和 walk-forward。
- API：`strategyResearch*`、`backtest`、`walkForward*`、`researchUsage/Attempts`、`reports/reportHistory/archivedReport` 等目前在 `api/root.ts`。
- runtime worker 构建入口见 `scripts/build-runtime.mjs`，目前包括 `research-worker.ts` 与通用 `worker.ts`。

## 契约与依赖

纯规则位于 `src/lib/research/` 与 `src/lib/backtest/`。研究入口 schema 保留在 `src/lib/research/strategy-research.ts`；研究按 `methods/`、`risk/`、`factors/`、`technical/`、`evidence/`、`specs/`、`workflow/` 和 `analysis/` 分域。各策略家族实现位于 `methods/{canslim,chan,volume,swing,wyckoff}/`。研究结果应回显证券池、数据时点、复权、来源和证据等级；回测输入快照不可被之后的数据静默替换。输入验证、任务取消/进度、持久结果 ID 和错误状态属于 API/worker 契约。研究调用行情、财务新闻源与模型；回测依赖纯规则/core、数据源、jobs 和 SQLite。

## 状态、副作用与验证

持久化任务、样本、快照、结果与报告；长任务使用 worker，模型/外部查询会有网络效果。API 验证请求后由 [backtest-job.ts](../../src/server/backtest/backtest-job.ts) 执行回测任务；隔离数据库要求见 [operations](../operations.md)。代表测试：[research-worker](../../tests/research-backtest/research-worker.test.ts)、[backtest-actions](../../tests/research-backtest/backtest/backtest-actions.test.ts)、[backtest-adjustment](../../tests/research-backtest/backtest/backtest-adjustment.test.ts)、[daily-performance](../../tests/research-backtest/backtest/daily-performance.test.ts)、[walk-forward](../../tests/research-backtest/backtest/walk-forward.test.ts)。

## 维护指南

新增研究因子要绑定证据来源与时点并归入 `factors/`；方法家族代码放入对应 `methods/` 子目录，跨家族技术规则放 `technical/`，共用风险参数放 `risk/`，固定输入 schema 与策略目录放 `specs/`。新增执行规则要分离信号价格与成交假设，并明确交易规则、费用和公司行动。只有定义了数据覆盖和执行条件的结果才可作业绩主张；参见 [roadmap §1.1](../roadmap.md#11-策略验证分层) 与 [invariants](../invariants.md)。
