# 观澜 · 路线图（范围与方向入口）

## 当前方向（2026-11-25）

`v0.3.0 / SQLite v25` 已在 `master@d73c2534` 交付统一策略流水线、研究到调仓单闭环、固定内置 `hq.dll 2.0.2`、四通道平行账户，以及 A 股、数字货币和期货看盘图表直接模拟下单。当前进入 [Iteration 5（v0.4.0 / SQLite v26）](project/2026-11-25-iter5-v040-plan.md)，收口执行日报价与跨窗、共享账户风控、模拟账本及图表成交投影、冻结研究交接与运行台，并交付 A 股盘中实时预警。

界面为七个语义工作区：今日交易 `/`、行情看盘 `/scan`、选股筛选 `/scan`（公式 / RPS / 股票池等标签）、策略回测 `/lab`、持仓复盘 `/accounts`、资讯研报 `/intel`、系统设置 `/system`。名称、分组与界面词汇由 `navigation.ts` 和 `ui-glossary.ts` 统一，底层路由不因分组改变。工作区重构已 7/7 实机验收，后续反馈与候选能力见 [next-plan](next-plan.md)。

Wave 3 已完成历史工程实证。股债金模拟成交与统一账本的两组三账残差均为 0.00 元，10% 单标上限是旧窗收益由 +34.04% 降至 +13.38% 的主要约束。Alpha Top-10 旧窗复现 −71.20%，20 日调仓最新仍亏 45.47%，维持部署阻断。分钟窗口缺独立量证，五部署收盘规划实测中位 18.572 秒。详见 [Wave 3 实证报告](research-backtest/2026-11-26-iter5-closed-loop-empirical.md)。

## 当前能力

- **A 股行情与图表**：本地通达信 `vipdoc` 只读解析、tstdx 7709 协议、东方财富、westock-data 在线来源；原生缠论、多周期 RPS、公式选股、双突破、分时与画线。来源、周期、复权与失败语义显式展示，手动选源失败不静默换源。
- **策略与研究**：策略中心、统一策略对象、研究与回测引擎，研究结果可生成次日调仓单。统一策略流水线提供持续候选池、策略运行台及独立模拟/实盘总开关。L0–L5 交易生命周期已交付，研究资格按冻结证据单独核验。
- **交易与复盘**：真实、纸面和模拟交易所分账。`/accounts?tab=paper` 提供本地模拟、同花顺模拟、同花顺实盘桥接只读查账、期货模拟四个平行入口。交割单导入、现金对账、执行质量和组合复盘沿用现有归属。
- **提醒与资讯**：统一提醒引擎接管旧监控/台账/预选调度；默认 shadow，显式开启 live 并启用订阅后才投递。财联社本地新闻库只读、复盘与情报展示。
- **其他市场**：数字货币提供行情与 USDT 现货模拟，期货提供行情、双向保证金模拟开平仓及轻账本。两者均可从图表发起模拟。新增市场或数据源按实际需求立项。

## 当前缺口

- A 股历史证券池、完整公司行动、财务首次披露版本与真实可成交证据仍不完整；相关结论只按已有证据下界表述。
- 盘中五档、集合竞价、分价、涨停归因与异动现已接入[同花顺 THSDK 数据源](data-sources/2026-11-19-thsdk-delivery.md)作为可选来源（连同 tstdx 与东方财富各自标注边界，项目内置固定版 `hq.dll` `2.0.2` 并默认停用，启用并登录后生效）。
- 成交执行质量已有 `accountExecutionQuality` 与复盘实现，尚缺真实账户的持续运行样本与外部场所联调。
- 自然前向观察、真实渠道投递与桌面新版本发布按触发条件推进，不用历史回放替代。

## 架构与正确性决定

1. Windows-first，前后端 TypeScript，Electron 负责宿主与 bundled Node 服务。职责与依赖见 [architecture](architecture.md)，工程一致性见 [conventions](conventions.md)。
2. 策略纯规则归 trading-strategies，共享指标归 trading-strategy-core，数据协议/本地解析归 tstdx；撮合执行归 quant-backtest，评价归 quant-performance，多周期排名归 quant-rps。RPS 周期为 1/3/5/10/20/50/120，历史记录按自身周期读取。
3. 原生缠论使用 CZSC API v22，koffi 绑定、36 字节配置；每个宿主只有一个专用串行子进程。DLL/配置及历史起点固定，不替换为 TS 近似或并行 DLL 池。来源与分发约束见 [vendor](../vendor/czsc/README.md) 和 [第三方声明](../THIRD_PARTY_NOTICES.md)。
4. 扫描（包含行情/筛选）与回测显式保留页面实例，其余使用常规 Next 路由。URL、具名内存会话、浏览器会话及服务端事实各有所有者，具体生命周期见 [页面状态表](architecture.md#页面模型与状态归属)。
5. SQLite 查询进入类型仓储，分页有稳定唯一排序键；完整遍历与导出明确事务和载荷边界。物理表迁移由实测需求驱动；不降低 `user_version`，旧打包版会拒绝更高版本库，正式交付时同步更新桌面版本。
6. 数据来源、时间、证券池、复权和交易规则明确；原始值、未知与有效零分开。历史研究不能使用后来披露的财务信息。旧回测只能作为规则自检；缺少历史证券池、公司行动或可成交证据时，不能称为可信策略业绩。详细要求见 [invariants](invariants.md)。
7. 模型只解释有校验的证据，不执行生成代码，不自动下单。通知需要启用订阅；真实测试需要明确请求与目的地，凭证使用仓库外 DPAPI。

## 执行与验收

按可验收的小阶段核实并复用已有能力。局部命名、签名和边界自行处理；付费来源、重大架构取舍和不可逆操作提出具体方案。

开发期执行受影响的 Vitest、typecheck；应用交付执行 build，涉及 runtime 时重建 worker，桌面资源准备执行 `desktop:prepare`。完整工程门禁在约定的集成交付点集中执行并复用仍有效的证据。文档检查内容、相对链接与 diff。提交、推送、正式打包及用户库操作分别需要对应授权。任务产物集中管理并在收尾核对。

## 当前范围与决定

更新：2026-11-25。项目是面向 A 股的个人量化工作台，保留数字货币现货模拟和期货双向保证金模拟轻账本。当前交付、剩余项和验收入口见 [next-plan](next-plan.md) 与 [Iteration 5 实施计划](project/2026-11-25-iter5-v040-plan.md)。早期优化决定见[优化方案](project/2026-11-13-optimization-plan.md)。

- 公式选股、双突破与现行研究/回测可用；旧选股/回测、样本研究、walk-forward 与旧四类 LLM 分析执行链已退役，请求不会启动旧任务。
- 统一提醒引擎默认 shadow，显式设置 live 并启用订阅才允许投递；旧记录可查询，不补跑、不补发。
- 数字货币模拟交易仍限币安/OKX/Bybit 模拟环境与 BTCUSDT/ETHUSDT 现货；平台余额/成交读模型与策略账本分开。
- 黄金白银、外汇等市场按现有来源浏览；新增品种或来源按独立任务评估数据、单位与授权。
- 清理不再使用的历史衍生结果时，保留原始数据源、现行功能与测试输入。WDZ 定义归档、退役合成标定输出与浅色打包清理均已完成，详见 [decisions](decisions.md)。
- 通达信与外部 Blocks 只读；生产数据库、凭证和正式包不属于普通文件清理范围。

## 历史变更索引

以下只说明决定的来源，不恢复退役入口或覆盖文首状态。

- 2026-11-25：`d9aba2a7` 合入 Iteration 4 Milestone 2；`3af44850` 接通研究到调仓单并交付宏观择时、情绪状态、价值 PIT 与配对切换；`55c9da7d` 交付 `v0.3.0 / SQLite v25` 统一策略流水线、持续候选池和模拟/实盘双总开关。见 [Iteration 4 旗舰主计划](project/2026-11-24-iter4-flagship-plan.md)和[当前实施计划](next-plan.md)。
- 2026-11-25：`2f104f33` 固定内置 `hq.dll 2.0.2`，移除手工 DLL 路径配置；`d73c2534` 完成实测反馈 `#1–#20`，包括四通道平行账户及三市场看盘直接模拟下单。见 [THSDK 交付](data-sources/2026-11-19-thsdk-delivery.md)和[实测反馈记录](project/2026-11-25-user-testing-feedback.md)。
- 2026-11-24：Iteration 4 旗舰交付（桌面 `v0.2.0` / SQLite `user_version = 24`）：`MarketPanelStore` 列式面板、`PortfolioRiskEngine` 与 `ExecutionRealityEngine`、全市场多因子 Alpha 实验室（`/lab/analysis`）、3 族 A 股 ETF 轮动、统一 `/lab/backtest` 研究工作室、Perold 三账实施缺口与 `/accounts?tab=risk`、全天候作战室（`/`）与严格因果 Bar Replay 盲测训练，见[旗舰主计划](project/2026-11-24-iter4-flagship-plan.md)与[全市场实证报告](research-backtest/2026-11-24-iter4-flagship-empirical.md)。
- 2026-11-21：回测/交易基础设施去治理化、统一 `AccountBook` 账本、交割单软删除、PIT/因果复权与窗口读取；11-22 收口 sim 账本、THS 委托号对账与 RPS/chan 索引化，见[交付记录](project/2026-11-21-backtest-infra-optimization.md)。
- 2026-11-19：七工作区布局与信息降噪、Phase 2 风险/热力图可视化，见[对标报告](project/2026-11-19-trading-software-benchmark.md)。
- 2026-11-17：策略闭环、B2 多周期/结构/财务、理论策略工程化与按钮验收，见[策略闭环](research-backtest/2026-11-17-strategy-closure.md)与[B2 交付](research-backtest/2026-11-17-b2-development.md)。
- 2026-11-16：L0–L5 交易生命周期优化，见[交付记录](project/2026-11-16-lifecycle.md)。
- 2026-11-15：R1–R3 优化、纸面账户与统一持仓，见[优化方案](project/2026-11-14-optimization-plan.md)。
- 2026-11-13–14：恢复公式/双突破、退役旧执行链、浅色界面及 P0–P5 优化，见[当前优化交付](project/2026-11-13-optimization.md)。
- 2026-11-12：增加平台持仓/历史成交阅读，见[交付](portfolio-ledger/2026-11-12-crypto-account-history.md)。
- 2026-11-11：模拟双均线自动交易与策略包职责归属，见[交易交付](strategy-signals/2026-11-11-crypto-auto-trading.md)与[策略交付](strategy-signals/2026-11-11-strategy-factor-native.md)。
- 2026-11-08：多周期 RPS、CZSC v22、独立绩效评价及现行研究规则；分别见 [RPS 包](../packages/quant-rps/README.md)、[CZSC 交付](strategy-signals/2026-11-08-czsc-v22.md) 与[评价规格](product/specs/backtest-evaluation.md)。
- 2026-11-07：本地财务与 tstdx 数据边界，见[财务交付](data-sources/2026-11-07-local-financial.md)。
- 更早的裁定与失败经验保留在 [decisions](decisions.md)；当前用户授权优先于历史约束。
