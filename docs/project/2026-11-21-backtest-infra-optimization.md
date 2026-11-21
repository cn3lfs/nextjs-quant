# 回测引擎与交易基础设施优化（2026-11-21）

按用户“快速迭代、去掉老古董治理措施”的要求，分三批落地。分支 `feat/backtest-infra-p0-degovernance`，未推送。

后续 P3–P7 使用 `multi-agent-commander` 多 Agent 编排：Astra 负责账本迁移与交割软删除，Sol-high 负责 PIT/复权与窗口读取，Sol Review 对每个 wave 做只读缺陷审查；共 6 个 wave，P1/P2 修复回灌后再次审查。

## 已完成

### 批次 1：去治理化（`6e002666`）

- 删除 487 KB `docs/trading-skills-source-lock.json`、源快照、`known-source-drift.md`、source-drift/skill-inventory/method-evidence 审计脚本与对应测试。
- `research-method.ts` 不再查源锁与 `sha256`，来源只保留路径；删除 `validateResearchMethod`。
- `research-run.ts` 不再递归哈希整个 `src`/包 `dist`/lockfile；默认只记录 `package.json`、`pnpm-lock.yaml`、git HEAD，显式 runner/definitions 保留运行期一致性。
- 构建哈希从门禁降为记录：`validation-artifacts`、`forward-identity`、`lifecycle-runner`、`paper/advance` 不再因构建变化拒绝读取/推进；worker 字节自校验保留。
- 删除 14 个研究模块的 `2000-01-04..2022-11-30` 硬窗口；`coverage-window` 默认最早可运行窗口，可选 `maxDays`；pattern lookback 20 → 250。
- 删除第一批治理/结构测试与 2 个快照；`w5-statement-import`/`trade-review-nav` 改显式断言；`verify:batch` 改为正常测试退出码。

### 批次 2：资金与统计止血（`c57f519d`）

- A 股过户费：`base`/`double` 情景 0.1bp/0.2bp 双边；`fixed` 保持 0；`affordableQuantity` 与审计 helper 同步。
- 红利税：`ExecutionCosts.dividendTaxBps` 可选，`PortfolioAccount` 按税率扣减；默认 0（持有期未知）。
- 加密 365 年化：`quant-performance` 参数化 `annualizationDays`；lab/纸面/validation/combined book 按市场传 252/365。
- GBBQ category 11 扩缩股进入复权因子，账户股数与信号价格一致。
- 退市成员写 `terminal: last-close`，不再直接排除；bars 未覆盖到退市日则明确拒绝。
- THSDK lab 保留可用，冻结结果标 `corporateActionCoverage: "excluded"`，边界文案阻断与本地源比较。
- 目标权重买单现金截断后保留 pending/重试，不再静默 `filled`。
- 绩效允许 `value=0`（-100% 收益、100% 回撤），持仓权重不除零；北交所 30% 规则。

### 批次 3：统一执行核心与基础设施修正

- 新增 `packages/quant-execution`：bigint 原子、订单/成交/分项费用、次开撮合、T+1 批次、涨跌停/停牌/一字拒绝、公司行动、外部成交对账、事件日志。`quant-backtest` 依赖并通过包根导出核心类型与 `ExecutionLedger`。
- 提醒前向收益改按信号 `event.bar` 锚定，不再用 `observedAt`，避免跨日收盘扫描顺延 T+1。
- 加密 bot 使用适配器 `serverNow()`（交易所时间偏移）判断完成/过期。
- sim 账户拒绝未来日期与非交易日（有日历证据时）；`preview/confirm` 支持显式 `now` 便于确定性测试。
- GBBQ 来源指纹改为内容寻址：stat 身份命中时复用，变化时内容哈希；并发首次读取共享同一 in-flight promise。
- 财务低估值事实增加 `vintage: "current-revision"`，明确不是首次披露版本。
- validation 请求传入 PIT `memberships`；lab/validation 默认 `observationDetail: "counts"`。
- `runPortfolio` 增加可选 `AbortSignal`，lab 与 validation replay 在 bar 边界可中止。
- 继续测试松绑：`runtime-validation-identity` 改为机制 fixture，不再锁 15 个仓库路径；`e2e-workbench-fixture` 改为结构不变量；`w8-repo-direction`、chan/wyckoff 删除全对象 hash，保留显式字段与行为断言。

## 验证

- `pnpm typecheck`、`pnpm lint`、改动文件 Prettier、`git diff --check` 通过。
- 最终根全量 Vitest：**7,769 项（7,741 通过 / 28 跳过），0 失败**（隔离 `QUANT_DATA_DIR`）。
- `pnpm check` 全量门禁通过（format、依赖方向、runtime 构建、typecheck、lint、根与各包测试）。
- 包测试：`quant-execution` 7、`quant-backtest` 105、`trading-strategies` 484、`trading-strategy-core` 26、`quant-performance` 26、`tstdx` 125 项通过（`tstdx` 另 1 项跳过）。

## P3 迁移的实际结构

- 新增 `AccountBook` 作为共享状态机，统一现金、持仓、FIFO 批次扣减、公司行动与终值后的删除条件。
- 两个数值适配：
  - `ResearchExecutionLedger`（number）：`PortfolioAccount` 的正式实现，`runPortfolio` 已通过它执行；保留研究回放的 binary64/平均成本语义。
  - `ExecutionLedger`（bigint）：面向行情原子、纸面/模拟/外部成交对账的适配器。
- `postPortfolioFill` 把已定价、已知费用明细的成交转为 bigint 原子并入账；12 步两买两卖、同日锁定、资金不足、`settledCashChange`、分红送转、配股、category 11、terminal 对拍零差异。
- **边界**：生产 `runPortfolio` 使用 number 适配器而不是 bigint 适配器；两者共享 `AccountBook`，但不是同一数值实例。若未来要把生产回测切到 bigint，需要单独验证 binary64 结算尾差与全部历史结果，不在本批次声称完成。

## P4/P5/P6 结果

- P4：`import_batches` 迁移为 `delivery_batches` + active 视图 + 逐批 claim + canonical payload；撤销只写 `revoked_at`，不删经济行；同文件重试返回零新增计数；旧清理工具识别视图与 claim。
- P5：A 股公式绝对价格比较要求逐 bar 因果价格；PIT 名册按回放日可知事实（公告/抓取时间）淘汰；财务 `current-revision` 的 PE/PB 保持未知；退市最后交易日与终止上市日分离。
- P6：`readWindowSnapshot` 按日期索引读取并与全量逐根一致；BarStore 支持跨读取共享预算，lab/validation 累计原价与 signalBars，超限任务失败；缺终值持仓的评分返回 blocked/null。

## 保留的边界

- `docs/trading-skills-method-map.json` 是活数据目录（策略中心/理论研究使用），保留；只删除源锁与漂移审计。
- runner/显式 definitions 的运行期一致性与 worker 字节校验保留，防止长任务混用两个版本；改无关源码不再中断。
- 生产 `runPortfolio` 使用 `ResearchExecutionLedger`（number）而不是 bigint `ExecutionLedger`；两者共享 `AccountBook`。切到 bigint 需单独验证 binary64 尾差与全部历史，不在本批次声称完成。
- 完整历史指数成分、首次披露财务版本、外部券商/THS mock 的委托查询仍需外部数据或联调；缺证据时保留未知/阻断，不补造。
- 少量数据 manifest 精确计数（WDZ、public factor）是数据契约，不是实现形状，保留。
