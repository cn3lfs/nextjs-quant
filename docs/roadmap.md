# 观澜 · 路线图（范围唯一事实源）

2026-09-10 文档收口。入门见 [README](README.md)，接续见 [next-plan](next-plan.md)，具体语义见 [invariants](invariants.md)。M1–M5 已交付，不再保留待执行式清单；历史原因完整保存在 [decisions](decisions.md)。

## 0. 项目定位

自用精简量化工作台：看图（K 线和指标）、算两策略（缠论/双突破）、推信号（四渠道及追加解读）。已有台账、手工持仓与受限公式支持这条主线；不是自建回测、全流派研究或自动交易平台。程序正确不代表策略赚钱，当前没有盈利有效性结论。

## 1. 已定架构决策

### 1.1 策略验证外包给聚宽

不再投入自建 A 股回测：公司行动、停复牌、涨跌停排队、退市、历史证券池与官方日历的完整建模不是本项目任务。已有 backtest-1..5、walk-forward、cost-experiment-1、cash-adjusted 仅为冻结的规则自检工具。根 README 的“不能用作正式策略业绩”限定永久保留。聚宽接续按 N2 双系统候选对齐，不能用聚宽结论直接替代本地口径验证。

### 1.2 指标本地计算

本地通达信行情由 TypeScript 计算，指标共享实现为 src/lib/indicators.ts，不走问财查询替代。技能提供方法、阈值和来源，不能变成另一个指标数据源。图表/公式/双突破的约束与手算测试入口见 [invariants §1–4](invariants.md#1-指标只有一个实现入口)。

### 1.3 缠论复用 DLL，不移植算法

版本资产在 vendor/czsc/CZSC64.dll，经 runtime:build 复制到 runtime/czsc；来源 commit、实际 hash 与重建原因见 [vendor 清单](../vendor/czsc/README.md)。koffi 从 RegisterTdxFunc 注册表读取 Func30/40 指针；先真实 C/V 注册，再按配置投影。不能按旧描述直接寻找 Func30 导出符号。

每个应用宿主使用单一专用子进程串行 DLL 调用，台账任务线程转发到同一队列；不得并发进入或另开 DLL 工作池。Float32Array、库对象存活与 golden 权威规则见 [invariants §6](invariants.md#6-缠论原生边界)。无法加载则汇报，不换 FFI、不移植算法。

DLL 由管理者重建并预置；执行者不需要自行安装编译工具或依赖。旧“本机无工具链/旧 build DLL 可直接用”的前提已被实际重建推翻。对外捆绑分发仍需用户确认许可义务，见 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)；不由执行者作法律或分发决定。

## 2. 范围外（冻结清单）

以下保持可用，零新增功能、零重构、零优化、零追加验收；bug 只记录，除非阻塞当前获授权工作。

| 冻结项 | 涉及范围 |
|---|---|
| 回测与滚动检验 | `backtest-*`、`walk-forward*`、`cash-dividends`、`backtest-costs` |
| CANSLIM | `canslim-*`（30+ 文件）、`canslim-panel.tsx` |
| 威科夫 | `wyckoff-*`、`wyckoff-panel.tsx` |
| 基本面 / 价值 / 估值 | `fundamental-*`、`valuation-*`、`annual-cash-flow`、`financial-*` |
| 市场情绪 / TMT | `market-sentiment`、`tmt-*` |
| 新闻行业链 | `news-*` |
| 其余未接入技能 | `trading-skill-ids.json` 中除 `swing-trader`、`chan-theory` 与量价快评外全部 |
| 性能优化 | 选股已从 40.84s 优化至 165ms（250 倍），**目标已达成，停止** |
| 组合 / 风控 / 归因 | 不实现 |
| 多品种扩展 | ETF、港美股、期货、可转债，不实现 |

旧 chan-panel/chan-* LLM 链路与 DLL 计算层不同，合并改造尚未获授权，继续冻结；已接入的规则解读保持可用。冻结 UI 已收进二级“研究”入口（N3），不是待办。不新增组合/风控/归因或其他市场能力。

## 3. 里程碑完成情况

A 层为代码/受控验证，B 层为用户判断；下面“完成”不表示人工签收或盈利验证。后续 N/P/Q 状态见 [next-plan](next-plan.md)。

| 里程碑 | 状态 | 留存材料/人工事项 |
|---|---|---|
| M1 指标 | A 层完成，管理者已验收 | [通达信核对](review/m1-tdx-checklist.md) 为建议抽查，不阻塞 |
| M2 图表 | A 层完成，管理者已验收；后由 Q1 扩展 | [旧核对表](review/m2-visual-checklist.md)，当前体验以 Q1 为准 |
| M3 缠论 FFI | A 层完成，golden 与串行接入完成 | [三股结构核对](review/m3-visual-checklist.md)；GPL 分发决定待用户 |
| M4 信号推送 | A 层完成，受控实际第三方投递 0 | [消息样本](review/m4-message-samples.md)；真实渠道确认待用户 |
| M5 双突破 | A 层完成，本地全市场与案例交付 | [三案例与阈值](review/m5-review/README.md) 待人工判断 |

### 3.1 原指标口径引用的去向

代码注释中的旧 roadmap §3.1（公式）现对应 [invariants §2](invariants.md#2-通达信认定公式与预热)，不再重复详细验收规格。

### 3.2 原预热与 null 规则的去向

见 [invariants §2](invariants.md#2-通达信认定公式与预热)：窗口不足 null，递推不屏蔽早期值，不用零填充。

### 3.3 原人工核对事项的去向

见 [review 入口](review/README.md)；M1 三项认定已获独立来源佐证，人工抽查用于排除数据/复权/历史起点差异。

### 3.4 原退化边界的去向

见 [invariants §2](invariants.md#2-通达信认定公式与预热)：无效输入保留状态，KDJ 不重置，不再把已经实现的边界当阻塞任务。

### 3.5 何时停下汇报，何时自行决定

只有范围/交付与验收变化、影响外部行为的架构（数据源/依赖/进程）、不可逆动作、许可证/分发需要升级。局部边界、签名、结构、命名和测试组织自行决定并继续；口径在代码注释、decisions 和人工核对项中留依据。当前明确授权优先，不因普通局部细节中止整个交付。

## 4. 工程纪律

### 4.1 验证分层

改动级：vitest run --changed + tsc --noEmit；子任务：pnpm test；里程碑：typecheck/test/build/desktop:prepare，之后桌面 smoke、Playwright、pack 由管理者执行。**desktop:smoke 前必须 prepare**；执行者不跑 smoke/pack。禁止单函数改动跑桌面/Playwright，完整步骤见 [operations](operations.md)。

### 4.2 不重建一次性材料

管理者已删除 A–H 的 25 份记录、optimization-progress/optimization-acceptance、output（545 文件/27MB）和被替代的 m2-review/n3-review；不恢复，不建 archive。被跟踪内容可查 git 历史，未跟踪内容不保证可恢复。验证只写持久 tests 用例，不建 output。

### 4.3 决策日志取代进度日志

只在 [decisions](decisions.md) 记录决定、放弃及原因、与预期不符的事实；不追加“N 测试/typecheck/build 通过”。历史正文完整保留，不代表旧裁定仍优先于后来的修订。

### 4.4 范围与权限

M1–M5 严格串行规则保留，已完成项不重开。新工作按 next-plan 的前置条件及当前授权；额外想法只入待议，不实现。按 §3.5 处理决策，不沿用旧“任何未知都停下”的泛化规则。冻结模块不顺手修复，性能工作已经结束。

### 4.5 保持的基础约束

AGENTS.md 继续有效：通达信只读；凭证 DPAPI、不得日志泄漏；通知显式订阅；模型结构与证据校验；不执行生成代码；技能只读契约写 TS 适配；依赖管理者预置。生产库与开发/测试隔离，新增迁移由管理者更新 exe。打包仅 release/win-unpacked，应用运行时停止。无授权不 commit/push/外发，具体测试边界见 [invariants](invariants.md)。
