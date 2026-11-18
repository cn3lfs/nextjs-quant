# 研究与回测

核对：2026-11-14；本页描述当前实现，验收边界见[当前优化交付](../project/2026-11-13-optimization.md)。

更新：2026-11-13。现行入口为回测工作台和策略中心，旧选股/回测、样本研究、walk-forward 与旧 LLM 分析链已退役，不保留只读兼容页面或旧执行协议。三个旧自动调度器保持暂停。范围见[优化方案](../project/2026-11-13-optimization-plan.md)和[统一策略中心规格](../product/specs/unified-strategy-center.md)。

## 职责与边界

- trading-strategies 负责策略纯规则，quant-backtest 负责执行/撮合/账户，quant-performance 负责评价；统计不能反向改变成交，规则不能直接写账户。
- 应用负责数据读取与输入核验、任务/worker 生命周期、冻结输入与结果、查询和导出。数据源、时间、证券池、复权和证据等级必须明确；工程测试通过不等于可信策略业绩。
- 用户真实账户与交易账本不由研究任务改写。当前数字货币模拟账户属于独立授权范围，不因旧回测退役停掉或扩展它。
- 旧 quant.ts、专用分红/复权模拟、历史信号回溯、交易轮次面板和旧 Backtest/Trade 结果类型已经移除。不要以修复旧导入为由重建它们。

## 入口与实现

| 边界       | 当前实现                                                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 回测工作台 | [页面容器](../../src/components/backtest/ma-baseline-panel.tsx)，配置、报告、历史分离；报告身份绑定所选任务，费用/窗口从冻结结果读取                                                                           |
| 五分钟任务 | [ma-baseline-job](../../src/server/backtest/ma-baseline-job.ts) → 通用 worker → [ma-baseline-work](../../src/server/backtest/ma-baseline-work.ts)；执行协议为 ma-baseline，旧 backtest worker 消息不能重新运行 |
| 回测 API   | [jobs router](../../src/server/api/routers/jobs.ts) 中的 maBaseline、Coverage、History、Result、Evaluation、Orders、Export、Remove；订单查询按状态分页，复用现有 job 存储                                      |
| 策略中心   | [strategy-center router](../../src/server/api/routers/strategy-center.ts)；日线、横截面等能力以现行注册/输入契约为准，不把 695 项方法目录数当作可执行数量                                                      |
| 数据输入   | [公司行动](../../src/server/backtest/backtest-actions.ts)、[分红对账](../../src/server/backtest/dividend-reconciliation.ts)以及独立 TDX 数据源保留；旧研究数据集采集/流式写入封装已移除                        |
| 构建       | [统一 worker 构建](../../scripts/build-runtime.mjs)与根 packages:build；没有旧 research-worker 构建入口                                                                                                        |

UI 详见[回测工作台规格](../product/specs/backtest-workbench.md)。图表价格、计算价格、估值和实际成交的时点/单位必须分开，不用旧回测的百分数或公司行动假设覆盖新引擎契约。

## 验证与维护

- 回放：[ma-baseline-work](../../tests/research-backtest/backtest/ma-baseline-work.test.ts)、[公司行动读取](../../tests/research-backtest/backtest/backtest-actions.test.ts)、[包边界](../../tests/engineering-validation/backtest-package.test.ts)以及 quant-backtest 包内手算/未来前缀用例。
- 退役：[API 与模块边界](../../tests/api-runtime/retired-sample-research.test.ts)。不存在的旧入口不能被重试、开机恢复或 CLI 再次激活。
- 独立计算：[每日绩效](../../tests/research-backtest/backtest/daily-performance.test.ts)、[CSCV/选参](../../tests/research-backtest/backtest/backtest-overfit.test.ts)。CSCV 继续复用曲线/夏普计算，不为采样组合重复运行整个回测。
- 使用记录：[台账隔离](../../tests/research-backtest/research-usage-ledger-isolation.test.ts)验证写入研究使用记录不会修改信号台账。
- 真实应用场景：pnpm e2e:p0 覆盖现行回测恢复/导出和公式/图表等关键路径；按[约定](../conventions.md)先构建与准备 standalone，并设置隔离数据目录。

新增规则放策略包对应领域，新增执行行为放独立回测包；应用数据契约变化要验证来源和失败语义。保持 native、worker、输入格式及当前账户边界，不把旧专用测试的删除当作取消现行能力的验证。
