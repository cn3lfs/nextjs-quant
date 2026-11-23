# 当前实施计划

## 2026-11-22：回测诊断第二批（量价 / 威科夫）已交付

- 门禁：`pnpm check` 现为异步 `spawn`，每步关闭 stdin、15 分钟单步超时、超时按进程树终止（Windows `taskkill /T`）；`check-result.json` 记录每步耗时与 `timedOut`。完整门禁 6/6 步通过。
- 研究口径：[回测研究假设](research-backtest/2026-11-22-backtest-assumptions.md)冻结 strict 基线、clamp 强制敏感性、单标的全历史 0.5% 容量档。
- 策略映射：诊断器支持 9 个量价 + 6 个威科夫 `research-*` study key；每个 key 在结构化 fixture 上必须有真实入场，并与 `createExtendedStudyRule` 对齐。
- 量价：[170/170 单元 ok](research-backtest/2026-11-22-volume-family-diagnostic.md)，9 个策略均有成交。
- 威科夫：[119/119 单元 ok](research-backtest/2026-11-22-wyckoff-family-diagnostic.md)，但 `wy-lps`、`wy-reaccumulation`、`wy-trend-pullback` 在五标的全历史上零入场；已登记为下一阶段研究前置问题。
- 数据：[GBBQ 按标的归因](research-backtest/2026-11-22-data-hardening.md)，无法归属的记录仍阻断 strict；主板 ST 自 2026-07-06 起按 10% 研究口径。
- 下一阶段可行性：[缠论/成长/RPS](research-backtest/2026-11-22-batch5-feasibility.md)。

## 当前阶段（2026-11-23 重梳）：策略原生适配、PIT 成长与规则健康基线

完整实施计划见[下一阶段主计划](research-backtest/2026-11-23-phase-plan.md)，前期交接细节见[交接文档](project/2026-11-23-handoff.md)。此前三条特性分支（`feat/global-optimization-20261119`、`feat/thsdk-data-source`、`feat/backtest-infra-p0-degovernance`）均已合入本地 `master`。

| 里程碑 | 事项                                                   | 状态 | 口径与验收                                                                                                                                                                                                                                               |
| :----- | :----------------------------------------------------- | :--- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1** | 缠论原生诊断适配（`research-chan`）                    | 完成 | 走 `chan-third-buy` + `instrument.external.chan` + `runPortfolio`（含 $O(N)$ 惰性校验、日历对齐后捕获、校验型只读缓存、`closeCzsc()` 收口）；五标的 × 三档 **30/30 ok、0 P0**，见[缠论原生诊断](research-backtest/2026-11-23-chan-native-diagnostic.md)  |
| **M2** | 成长 CANSLIM strict-PIT 适配（`research-canslim-pit`） | 完成 | 实现逐日 `availableFrom <= date` 过滤（`src/server/financial/canslim-pit-series.ts`），复用 `research-growth` 同退出规则做严格 A/B 对照；五标的 × 三档 **51/51 ok、0 P0**，见[成长 PIT 对照诊断](research-backtest/2026-11-23-canslim-pit-diagnostic.md) |
| **M3** | 威科夫口径对齐 + 94-key 真实健康基线                   | 完成 | 对齐 `WY08` `MA60 上升`文字（未改阈值）；`sh600519` `strict` 摸底全部 94 个 catalog key **95/95 ok、0 P0**（88 正常成交 / 6 稀有结构零入场），见[94-key 健康基线](research-backtest/2026-11-23-catalog-94-health.md)                                     |
| **M4** | 历史成分/退市/ST、周末 bar 第二源、桌面发版与实盘样本  | 挂起 | 依赖外部数据或显式授权；无本地证据前不做横截面外推                                                                                                                                                                                                       |

## 当前阶段（2026-11-23 完成）：底座提速、投资理论闭环与 `/lab` 产品化（Wave 0–3 已交付，待授权提交）

完整规划、12 只精简分层验证池、零迁移优化策略与 Wave 0–3 多 Agent 编排见 [下一阶段主实施计划](project/2026-11-23-next-phase-plan.md)，真实 12 股与原生缠论全谱验证证据见 [Wave 1–3 真实数据验证矩阵](research-backtest/2026-11-23-wave1-theories-matrix.md)：

- **Wave 0（已完成）**：`deliveryBatchPage` 以 `(PRAGMA data_version, total_changes())` 连接级缓存 + 轻量元数据索引实现**零迁移**降阶（保持 `user_version = 23`，万批 500 页 434.57 ms / 单页 P95 1.19 ms）；门禁拆 `heavy`/`io`/`pure` 三组、4 个热点测试进程内化 + 代表性子进程契约断言、Windows Job Object 两跳孤儿回收、统一 `test` 补齐 `tstdx`/`quant-execution`/`quant-rps` 共 7 个包，全量 `pnpm check` 零超时通过。
- **Wave 1（已完成）**：`FrozenChanObservation` 升级 v2 共享投影（一/二/三买 + `CH14` 真实卖点退出，同股 0 新增 DLL build）、缓存键绑定当前 DLL SHA/ABI/配置、按标的解除多标的 `firstIndex` 限制（`sh600519 + sh688981` 跨上市日组合全通过，旧三买 5,908 前缀逐字节一致）；接通 CANSLIM C1–A3 覆盖、SEPA PIT（`FN230/232/281`）、`sh000300` `M` 大盘制度（缺口日 fail-closed）、8%/7%/MA20/MA50 退出消融、`--pool core-12` 幸存者偏差披露、`gpcw20251231.dat` `300750` 重复记录披露与威科夫逐层漏斗。
- **Wave 2（已完成）**：抽离共享诊断服务 `src/server/research/diagnose/` 与共享契约 `src/lib/research/diagnose-contract.ts`（CLI 瘦身为薄封装，3 策略 × 3 档 9 组 CLI/Lab 对拍 100% 一致，常规生产回测 strict 零渗漏，取消任务隐藏未完成归档）；`/lab/backtest` 落地三档执行情景对比卡、15 项体检抽屉与缠论/PIT/威科夫披露面板；`/scan` 公式/形态/RPS 候选一键「带入回测」且绝不静默覆盖保活草稿（原生缠论/PIT 候选直达诊断运行表单）。
- **Wave 3（已完成）**：基于只读 `E:/new_tdx64` 完成 288/288 单元真实矩阵（0 阻断、0 P0、0 残留 `czsc-worker`）、落盘研究矩阵报告、通过最终完整 `pnpm check` 并清理 `.test-data/fleet/` 与任务临时产物；提交、推送与桌面打包分别待授权。

### 前置探针已完成项（2026-11-22）

| 事项             | 状态     | 口径                                                                                                                                             |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 通用 study key   | 完成     | 诊断器接受 94 个可构造的 catalog study ID（新增 77），账户型 11 个仍拒绝；见[记录](research-backtest/2026-11-22-generic-study-keys.md)           |
| 威科夫零入场排查 | 判定完成 | [逐条件计数](research-backtest/2026-11-22-wyckoff-zero-entry.md)：当前参数下属稀有结构，量能/价格带/次日确认未同时满足；不改规则，保留零信号记录 |
| 成长 PIT         | 审计完成 | [财务 PIT 审计](research-backtest/2026-11-22-growth-pit-audit.md)；5 标的覆盖完整，公告日齐全，`strict` 下 `availableFrom` 为公告后首个交易日    |
| 缠论原生         | 捕获完成 | [spike](research-backtest/2026-11-22-chan-native-spike.md)：`sh600519` 5,908 前缀/87 秒，DLL 身份可冻结                                          |

Batch 4 收口项：权证 `skippedWarrants` 路径已补测试；`sz000001` 39 个日历外日期已列入[数据硬化记录](research-backtest/2026-11-22-data-hardening.md)。

## 2026-11-21：回测与交易基础设施优化已交付

回测引擎与交易基础设施完成一轮结构性优化：去治理化（源锁/深度指纹/构建硬门禁/固定窗口/死板测试）、`AccountBook` 统一账本与 `quant-execution` 包、交割单软删除 v22、PIT/因果复权、窗口读取与按任务预算；后续收口把 sim 账本并入 `AccountBook`、补 `sim_fills.transfer_atoms`（v23）、THS 委托号对账、RPS/chan 热路径索引化，并修复提醒键、加密漏单/拒单重试、真实 NAV 期初现金、观察明细默认值、取消信号、可配置预算与公司行动时点披露。全量根测试 7,769 项零失败（收口前基线）。详见[交付记录](project/2026-11-21-backtest-infra-optimization.md)。生产回测仍使用 number 适配器，bigint 适配器用于行情原子、sim 与外部成交；完整历史指数成分、首次披露财务版本、真实场所历史委托查询仍依赖外部数据或联调。

## 历史已完成阶段：THSDK 全量数据源（已合入 master）

同花顺 `thsdk-hq` 全量接入已在 `feat/thsdk-data-source` 完成 Wave 0–5 并合入 `master`：全局数据源与 `/system` 诊断、`/scan` 盘口/分价/竞价/分时、情绪与板块、问财与资讯，以及图表、公式选股与实验室回测的**可选**输入。交付记录见 [THSDK 交付记录](data-sources/2026-11-19-thsdk-delivery.md)，[实施规格](data-sources/2026-11-19-thsdk-data-source-plan.md)与 [ABI 实证](data-sources/2026-11-19-thsdk-sample-verification.md)保留为背景与证据。

- 驱动为独立 Node 子进程 + `koffi` 直连外部校验过的 `hq.dll`，不依赖 Python/pandas；只读白名单之外的方法在进入 FFI 前拒绝，默认个人账号，游客快速体验为显式开关。
- 东财情绪与 IndexedDB 缓存、`src/server/mcp.ts` 均未改动；THS 信号价用原生 `qfq`/`hfq`，成交用同源未复权原价，不二次复权。
- Wave 5 验收件（`tests/desktop-build/thsdk-package.test.ts`、`tests/e2e/thsdk-acceptance.spec.ts`）已落盘；后续正式打包经明确授权后执行 `pnpm desktop:pack`。

## 当前界面与工程状态（2026-11-19）

七工作区重构已 7/7 实机验收：今日交易、行情看盘、选股筛选、策略回测、持仓复盘、资讯研报、系统设置。统一降噪原语（`MethodologyPopover`、`FilterToolbar`、`RiskDistanceBar`、`MonthlyReturnsHeatmap`）与两档密度已落地；工程门禁与双宽度截图证据见 [优化交付](project/2026-11-19-trading-software-benchmark.md)。后续候选能力回到对标报告的 Phase 2 / Phase 3 储备池，立项前回答数据能否支撑、是否需要新授权、验收用什么真实样本。

## 工作区功能迭代

七个分支各五轮，累计 35/35 轮完成并提交：

- **今日**：就绪度与收盘记录关联、候选来源标注、计划保存回执与深链。
- **扫描与图表**：冻结候选快照的前后翻股、来源/周期/复权一致性、RPS 榜单返回与恢复。
- **策略实验室**：深链身份校验、提交锁与回执、同口径比较导出、列表筛选保持。
- **账户与复盘**：来源筛选、止损状态筛选、详情返回保持、关联回执与复制。
- **新闻情报**：任务终态去重、分析档案关联、导出回执、跨报告日锚点、核对证据身份。
- **系统**：最近错误关联、按任务编号精确筛选、同范围来源对照、投递来源跳转、信号/投递互跳。
- **底座**：启动健康检查、托盘打开目录、启动日志、烟测 `ready` 记录、`--startup-only` 隔离模式。

上述记录的事实与证据留在各自模块目录，不在此重复测试数字。

## 策略池量化与十持仓研究

### 目标

用本地数据把可量化的独立方法变成可回放策略，再统一初筛盈利线索。均线只作系统回归，不作主赛道；八二仅为研发优先顺序，不是小时 KPI，也不进验收标准。

### 范围与取舍

- 799 只作扫描范围；旧全池均摊产物不再作排序依据。
- “跨家族基准排序”降级为冒烟测试：只验证链路可跑通，不产出排序。
- 第一批按条目挑——判据是输入齐备且入场、退出能写成完整规则；先做量价突破 1 条完整策略验证共享路径。
- 五根持有期入场实验单列阶段，只记录信号成交和拒单证据。

### 账户与选仓

A 股与 BTC/ETH 分账户，各自独立约束：同时最多 10 个品种、单品种目标 10%，旧仓卖不掉时继续占位、不释放额度。同日候选按原法预先声明的优先级竞争仓位，不按旧历史成绩裁定；原法无评分和优先级时，冻结同日并列的稳定排序，并在结果中披露可能受它影响的成交。

### 执行顺序

每根 K 线先全量生成候选，再按预先声明优先级统一选仓、统一撮合；禁止边算边占仓。用一个会争抢仓位的小样本调换输入顺序，核对订单与成交一致。匹配用基准独立于代码排序偏好。

### 必要验证

只查会导致错误决策的风险：信号时间无未来数据、旧仓占位是否正确计入、成交成本与单位、是否存在有效交易、候选顺序一致性。基准成本批次通过后，候选才跑双倍成本与较晚历史窗；全量回归只在出现具体风险时触发。

### 当前状态

A 股 118 条、BTC/ETH 114 条完整日线规则完成开发窗基准成本回放；五根持有期入场两市各 32 条；多周期八场景独立完成。周度复合 RPS 和月末低波动组合已接入并独立复算首次排名和成交。金融事实、历史成员、分钟数据和原法出场等缺口按对应方法登记，结果见[研究记录](research/theory-study-results.md)。

### 成本情景与只读重放

- `trading-strategy-core/costs` 提供唯一纯费用构造 `researchExecutionCosts(market, scenario)`：`fixed` 为实验室原默认（3bp 佣金/5 元最低/5bp 印花税/5bp 滑点），`base` 使用 2023-08-28 前后 10→5bp 历史印花税，`double-cost` 将各项同比放大两倍。
- 实验室、对象回测 UI、worker 与冻结导出统一接入 `costScenario`；CLI 的 `--cost-scenario` 缺省沿用各阶段既有 base 或 base+double。
- 冻结对象记录 `costScenario`、`frozen.request.costs`、复权口径与 `marketPolicy`；A 股信号复权为 forward 或逐证券 GBBQ anchor，成交只用 raw 原价。
- 只读 replay：`scripts/research-lab-replay.ts` 校验导出摘要后经 `runPortfolio` 重放，不重读行情、不改输入、不写数据库；输出已存在时拒绝覆盖。

## 当前待办与剩余验证

1. **THSDK 收口**：合入 `master` 前集中执行 `pnpm check` 与 `pnpm e2e`，并按授权核对桌面安装包；期权 Greeks、港美股与盘前盘后等扩展能力按实际需求再立项。
2. **成交执行质量**：`accountExecutionQuality` 与复盘已实现，尚缺真实账户的持续运行样本、外部场所联调与长期一致性观察；不因此恢复旧任务书或旧执行入口。
3. **A 股数据缺口**：历史证券池、非现金公司行动、财务首次披露版本与真实可成交证据按方法逐项登记；缺证据只阻断相应结论。
4. **外部数据成功态补验**：外部行情成功态、历史盘中批次、行业/概念 RPS 有数据态与桌面原生焦点，按实际可用环境只读补验。
5. **SQLite 调用收敛**：数据层外的保留调用按登记理由维持；只有实测瓶颈证明需要时才迁移或设计物理表，没有预设 schema 升级。

## 持续边界

- 公式、双突破与现行研究/回测可用；旧样本/执行链已退役，请求不会启动旧任务。
- 旧监控/台账/预选调度不再运行；统一提醒默认 shadow，启用旧配置不会恢复旧调度，重启不补跑、不补发。
- 仅扫描（包含行情/筛选）与回测显式保留实例；普通页面的 URL、内存草稿、sessionStorage 与服务器事实按[架构状态表](architecture.md#页面模型与状态归属)归属，返回不自动重提写入。
- 通达信/外部 Blocks 只读，凭证在仓库外 DPAPI；任何可能初始化数据库的验证先使用隔离 `QUANT_DATA_DIR`，不降低 `user_version`。
- 同花顺 `hq.dll` 保持外置：只从用户指定路径加载并校验哈希，仓库与安装包不分发闭源 DLL、会话或凭据文件。
- 数字货币模拟交易及其他市场按现有授权运行；新增实盘、合约或真实外部调用需独立授权。`src/server/mcp.ts` 与用户维护文案不动。
