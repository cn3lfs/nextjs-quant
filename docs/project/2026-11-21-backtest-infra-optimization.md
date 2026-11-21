# 回测引擎与交易基础设施优化（2026-11-21）

按用户“快速迭代、去掉老古董治理措施”的要求，分三批落地。分支 `feat/backtest-infra-p0-degovernance`，未推送。

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

## 验证

- `pnpm typecheck`、`pnpm lint`、改动文件 Prettier、`git diff --check` 通过。
- `quant-execution` 4、`quant-backtest` 100、`trading-strategies` 484、`quant-performance` 26、`trading-strategy-core` 26、`tstdx` 120 项通过。
- 受影响根测试累计 500+ 项通过（研究回测、纸面、模拟、加密、提醒、GBBQ、验证）。

## 保留的边界

- `docs/trading-skills-method-map.json` 是活数据目录（策略中心/理论研究使用），保留；只删除源锁与漂移审计。
- runner/显式 definitions 的运行期一致性与 worker 字节校验保留，防止长任务混用两个版本；改无关源码不再中断。
- `quant-execution` 尚未接管 `runPortfolio` 的全部账本；`portfolio-account` 与 sim 的完整迁移、对拍白名单、真实导入 tombstone、forward 复权绝对价格规则、窗口读取与 AbortSignal 留待后续批次。
