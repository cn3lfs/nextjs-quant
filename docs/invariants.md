# 不可违反的约束

这是当前约束入口；理由的演变见 [decisions.md](decisions.md)，范围见 [roadmap.md](roadmap.md)。以下按 2026-09-10 工作区代码与测试核对。测试名表示实际覆盖的范围，不表示自动证明全部工程纪律；未覆盖部分明确标注。终端口径及视觉判断仍见 [人工核对目录](review/README.md)。

## 1. 指标只有一个实现入口

- **是什么**：图表、双突破以及公式的 MA/EMA/SMA/STD 共用 [indicators.ts](../src/lib/indicators.ts)。图表不得内联第二套公式；公式扩展函数仍在公式求值器内实现，DLL 内部指标由原引擎计算，不宣称全仓库每一段数学计算都在此文件。
- **为什么**：同一行情、同一参数必须给出同一口径；图表参数可调不改变策略默认参数。
- **测试**：[indicators.test.ts](../tests/indicators.test.ts)、[q1-chart.test.ts](../tests/q1-chart.test.ts)、[q2a-formula.test.ts](../tests/q2a-formula.test.ts)、[breakout.test.ts](../tests/breakout.test.ts)。全仓库禁止新增重复公式的静态扫描：**无测试保护**。
- **违反会怎样**：图上看到的指标与选股依据不一致，用户无法复核。

### U1 日收益绩效口径

- **是什么**：新增 17 项统一由 [daily-performance.ts](../src/lib/daily-performance.ts) 计算，通过复盘分段 `wbtStats` 追加；旧六项不替换。旧 `sharpe` 仍为减日无风险利率、样本标准差 ddof=1；新 `sharpeWbt` 固定 rf=0、总体标准差 ddof=0。新年化波动率使用全体有效收益的总体标准差，下行波动率使用负收益子集的总体标准差；旧 `sortino` 使用减 rf 的下偏二阶矩，分母为全部收益数，不能互换。
- **是什么（曲线）**：默认 compound 累乘，回撤为相对本金及运行峰值的比例；simple 累加，回撤为绝对差，仅作对照。回归、新高、Top-5 长度均基于所选曲线。新高间隔是含首亏的最长连续严格水下 bar 数，持平会中断且计入新高占比。Top-5 按深度迭代剥离峰至恢复日（含端点），未恢复剥离至末日；同深度先出现者优先，峰值持平取最近者。峰至谷按原观察位置差计数，期初虚拟 bar 不计入长度，固定除以 5 再除以 `yearlyDays`。
- **是什么（参数与缺失）**：年化因子来自 `yearlyDays` 并回显，默认 252，不按日期推断；rf 入参仅在新核回显，不能影响 wbt 夏普。null 剔除并计 coverage，零收益是可得观测且按 wbt 算胜。空样本全部留空；无亏损下行波动率留空；缺任一侧均值的盈亏比及赢面留空；零分母比率留空。数值溢出留空并说明原因，不 clamp、不舍入、不填约定数。复利收益低于 -100% 时曲线相关指标留空，其他日收益描述统计仍可计算。
- **为什么**：防止 wbt 对照覆盖已验收的账户口径；零收益不等于缺失。不同曲线回撤及年化不可直接比较，未来展示必须标注口径。
- **测试**：[daily-performance.test.ts](../tests/daily-performance.test.ts) 手算表、退化量、双曲线与年化参数；[trade-review-nav.test.ts](../tests/trade-review-nav.test.ts) 修改前既有 R9 合成 fixture 的六项精确快照及首亏基线。真实账户复验由管理者执行。
- **违反会怎样**：同名夏普含义改变、缺失被伪装成零风险，或现有复盘数字漂移。

### U2 交易日回溯与矩阵缺失

- **是什么**：分段调用 U1 全部 17 项；A 股回溯由 [period-performance.ts](../src/lib/period-performance.ts) 的 `aSharePeriodTradingDays` 定义为 5/10/20/60/120/250 交易日，日历由调用方提供。`ytd` 从自然年首日对齐日历；不足窗口返回实际起止、交易日数和 `truncated`，有效收益不足 5 日标 `insufficientSample`。czscflow 用自然日，我们用交易日，故同名分段的数值不可与其输出直接比对。
- **是什么（缺失）**：缺失交易日对齐为 null。分段沿用 U1 剔除 null 并报告 coverage，不冒充完整连续业绩；矩阵窗口含任一 null 则整格 null + reason，不以 0 累计。盈利按严格 > 0（零收益可得但不盈利），各列仅以该列可得标的数作分母，零分母为 null。超长矩阵窗口只计算实际范围并标 truncated。
- **是什么（自然周期与分页）**：ISO 周按星期四所属年；周/月/季/年胜率按日收益和 > 0，含首尾部分周期，含缺失的周期不进分母。两处矩阵服务端全量排序后分页，汇总独立于页码。研究两期本金独立，不拼接，缺价日及下一日留空；不同日期轴不能跨日或重设本金造收益。
- **为什么**：自然日、交易日和有效观察数不可互换；缺失会改变盈利比例分母，跨分区拼接会造假收益。
- **测试**：[period-performance.test.ts](../tests/period-performance.test.ts)、[period-performance-service.test.ts](../tests/period-performance-service.test.ts)、[trade-review-api.test.ts](../tests/trade-review-api.test.ts)。真实账户和浏览器由管理者验收。
- **违反会怎样**：长假窗口错位、跨年周归属错误、缺数据被当零收益、翻页改变全体汇总。

### U10 滚动绩效

- **是什么**：沿用上文 U2 交易日回溯口径与 `alignPeriodInput`，默认 60 交易日；第 `minPeriods` 个交易日起每日前进一日（默认等于窗口），允许较小起算日数，`tradingDays` 如实报告实际窗长，不补齐、不外推。全部 17 项与 coverage 只调用 U1。
- **是什么（缺失）**：null 原样交给 U1 剔除并计观察/可得/null/零收益日数。可得日 / 观察日严格低于 `rollingPerformanceDefaults.minimumCoverage=0.6` 标 `insufficientCoverage`，仍输出指标并展示标记；60% 达标。与 wbt 的差异：它把 NaN 当 0，我们留空；非有限数沿 U1 契约拒绝，不偷偷转零。
- **是什么（展示）**：完整指标在服务端排序分页，null 排末；曲线仅投影全区间夏普/最大回撤/年化，遇 null 分段断线。账户取日度 TWR，研究按独立分区模拟净值派生，与 U6 三段并存；滚动不驱动 U8 或最优窗口搜索。
- **为什么**：理由沿用上文 U2 的交易日与有效观察区分及 §5 缺失约束；避免长假错窗、零填充虚构业绩或不满窗伪装完整历史。
- **测试**：[rolling-performance.test.ts](../tests/rolling-performance.test.ts)、[rolling-performance-service.test.ts](../tests/rolling-performance-service.test.ts)、[rolling-performance-api.test.ts](../tests/rolling-performance-api.test.ts)、[rolling-performance-chart.test.ts](../tests/rolling-performance-chart.test.ts) 覆盖切窗、门槛、wbt 反例、指标同源、分页、路由与断线。真实账户和浏览器交互尚未人工验收。
- **违反会怎样**：窗口错位、缺失被伪造成零收益、分页或图表改变历史含义。

### U11 持仓集中度与敞口

- **是什么**：`positionValues` 只追加每标的市值及原因，原 `positions`、`marketValue`、`nav` 路径不变。`herfindahl = Σ(市值/nav)²`，分母总资产含现金稀释；`herfindahlInvested = Σ(市值/持仓市值合计)²`，`effectivePositions` 为后者倒数。未到期逆回购本金进 nav 分母，不进集中度分子与持仓只数。
- **是什么（缺失）**：任一持仓市值未知，当日五项指标整体 null 并说明原因，不能只计算可得部分；非正/未知总资产亦留空。空仓只数为 0，集中度留空。只数仍表示账本中非零数量记录数，未知股份不据此推断真实只数。摘要仅使用可得日并披露数量，峰值并列取最早日；曲线缺失断线，表格服务端排序分页。
- **为什么**：现金会稀释总资产口径；只展示它或部分估算会低估已投资部分的集中风险。
- **测试**：[position-risk.test.ts](../tests/position-risk.test.ts)、[trade-review-nav.test.ts](../tests/trade-review-nav.test.ts)、[position-risk-service.test.ts](../tests/position-risk-service.test.ts)、[position-risk-api.test.ts](../tests/position-risk-api.test.ts)、[position-risk-chart.test.ts](../tests/position-risk-chart.test.ts) 保护手算、逆回购、缺失、原数值、分页及断线。
- **违反会怎样**：把集中持仓展示成分散、现金或逆回购伪装方向敞口，或令已验收净值漂移。

### U5 持仓价格收益相关性

- **是什么**：证券集合取 U11 的区间内非零 `positions`，排除逆回购。价格取复盘快照中经 R12 校验的未复权日线，按完整交易日历计算 `close[t]/close[t-1]-1`，不读取 `positionValues`；只统计复盘区间收益，允许区间前一交易日作为首日基价。
- **是什么（缺失）**：Pearson 逐对使用两边均有收益的日期，返回 `overlapDays`；不足 20 日返回 null 和固定原因。缺价不跨日连接，非正/非有限/重复日期价格不可用；无收益标的整行整列留空，零方差亦留空。对角线只在足够样本且非退化时为 1。平均只含可得无序证券对，不含对角线。
- **是什么（分页）**：服务端按证券排序分页，默认 10 行、最多 20 行；客户端仅收到当前页行对全部证券的单元格，不传全量 N×N。全体证券对摘要不随页码改变。
- **为什么**：仓位市值含买卖股数变化；缺价跨日会把多日收益混入日收益，小样本和零方差不能伪装可靠相关性。
- **测试**：[holdings-correlation.test.ts](../tests/holdings-correlation.test.ts)、[holdings-correlation-api.test.ts](../tests/holdings-correlation-api.test.ts) 保护手算、19/20/21、缺失、数量不变性、逆回购、分页及路由。真实账户与浏览器尚未验收。
- **违反会怎样**：交易行为被误认为价格联动，缺失或小样本被误读为分散依据。

### U4 执行质量与反事实

- **是什么**：日 VWAP 只经 [trade-review-vwap.ts](../src/lib/trade-review-vwap.ts) 的 `tradeReviewDayVwap` 计算，R12 价格除数校验与 U4 共用；基准具名为 `dayVwap`，不是委托价。成交量或成交额非正、非有限、缺唯一当日日线时留空并说明，不拿收盘价或原成交价替代。可得的一字板等不主观剔除，按成交额筛选。
- **是什么（单位与费用）**：沿用 R12：沪债交割单数量保留既有 10 张乘数与成交金额独立校验；该乘数不用于判定日线 VWAP 单位。204/131 逆回购不进入执行质量任何分子分母，账户重放仍保留原逆回购本金和现金。滑点正为不利（买贵/卖便宜），平均 BP 按原成交额加权；费用取入库值，任何汇总缺失不以零补齐。
- **是什么（重放）**：任何非逆回购成交缺 VWAP，整份反事实为 null 并列日期、代码与原因。替换成交副本价款，保持数量、日期、证券、费用不变；沿实际 `reviewTradeNav.replay` 顺序，将价款差同步平移副本资金发生额、柜台余额及已提供流前估值，保留原残差与缺失。再原样调用 `reviewTradeNav`；不 fork 净值、不编造流前估值。实际与反事实使用同一期初现金、同一日历和行情，仅同边界分段可相减；全期 TWR 中断则全期损耗留空，可看同边界分段。
- **为什么**：只改 price/amount 会被柜台现金锚点覆盖；沪债错单位会制造十倍差价；缺基准补原价会低估损耗。执行损耗为实际 TWR 减反事实 TWR，负值表示实际较差，与不利滑点符号方向不同。
- **测试**：[execution-quality.test.ts](../tests/execution-quality.test.ts) 覆盖四方向手算、金额加权、缺失传播、R12 转债、零损耗锚点、非零现金价差、边界不一致、脱敏和分页；真实账户与浏览器验收由管理者执行。
- **违反会怎样**：虚构均价、价差被余额吞掉、不同收益区间相减或导出账号，产生貌似可信的假损耗。

### W11 反事实失效诊断

- **是什么**：反事实可得收盘净值出现任何非正值时，`terminalDifference` 与执行损耗留空并说明最低金额、日期及当前方法不可用；仍输出 `counterfactualNonPositiveDays` 和 `counterfactualWorstNav`。缺失净值不算零；非正净值日数与实际/反事实收益可得性差异日数是两个独立量。
- **适用条件**：非正值拦截优先于原 `boundaries`；其余情况边界一致沿用 TWR，边界不一致仅在共同期末净值可得时输出绝对金额差，并标明含路径影响、不是纯执行差异。不改实际路径，不加反事实资金约束。
- **为什么**：异常量级的反事实不能降级成看似可信的金额答案；资金约束会改变原成交集合。
- **测试**：[execution-quality.test.ts](../tests/execution-quality.test.ts) 覆盖负值、零值、同边界零值、缺失日、正常 TWR 不变、服务端透传与页面原因；510 与 333 是修复前历史证据；当前真实样本按 W12 验收（需 `W12_REAL_DATA=1` 和本地原始文件），仍断言执行损耗及期末差不可用。
- **违反会怎样**：将失效反事实包装成执行损耗，或混淆非正净值与收益缺失证据。

### U8 策略准入判定

- **是什么**：判定只调用 [daily-performance.ts](../src/lib/daily-performance.ts) 的 `simple` + `annualRiskFreeRate=0`，年化因子走 U1 默认或显式 `yearlyDays` 并回显；展示净值曲线仍用复利。U1 的单利“仅作对照”在 U8 判定中例外，结果 `basis="simple"`，禁止第二份收益、波动率、回撤或夏普实现。
- **是什么（边界与退化）**：全样本超额回撤 ≤ 阈值、Sharpe > 阈值；逐年/近期第三路回撤严格 < 阈值。归一化 scale 只由全样本计算，recent 历史段严格剔除尾部窗口。long/bench 任一年化波动率 < 1e-12、非有限收益或溢出均令 alpha 退化，所有超额派生值为 `ReviewValue` 空值，不能通过超额条件或总体判定。缺失路径也不能补零；绝对收益缺失的窗口留空，long/bench 缺失时整段超额不可认定。
- **是什么（证据与用途）**：可选 `longDaily` 默认取策略腿，不实现多空拆分。全部参数和输入随完整 JSON 导出，`evidenceLevel` 原样带出；未有管理者标定决定前，页面总判定固定为“未标定”，只展示分指标与条件。`isGood` 不驱动交易、参数选择或淘汰；输入收益 NaN/Inf 是任务书 §2.1 明确的退化特判，其他非法输入均抛错，JSON 导出拒绝不能无损表达的 NaN/Inf。
- **为什么**：wbt 阈值在单利收益空间标定，切为复利会改变阈值含义；空值变零会制造零风险，近期重新缩放或重叠窗口会改变“近期更稳”的问题。
- **测试**：[strategy-admission.test.ts](../tests/strategy-admission.test.ts)、[strategy-admission-service.test.ts](../tests/strategy-admission-service.test.ts)。真实账户与浏览器由管理者验收；[合成分布](review/u8-calibration-distribution.json) 不代表账户阈值已标定。
- **违反会怎样**：边界倒置、退化策略误获准入、默认值冒充账户结论，或用未经核验的样本宣称可信业绩。

### U6 三段样本治理

- 开发段沿用原 development；原 validation 在观察日期达到系统推导起点时才覆盖为 tracking。原始两段判定、资金路径、写入结果及 hash 不改，三段另作只读查询与导出。
- `trackingStart` 只能来自精确相同策略版本的前向台账 observedDate 与盘中信号所属 observedAt（北京时间日期），两处取更早者；不使用结构端点、研究回测产物、手工日期或版本别名。无前向记录返回 null 和原因，不补 end/今天；早于 validationStart 如实报告重叠，不出第三段指标。
- 三段日收益从完整原分区净值先生成再切片，17 项全部调用 U1，不重置跟踪首日本金。跟踪日期可得不意味着参数已冻结或存在真实成交，页面必须披露来源限制。
- U8 history 分别使用开发段、保留验证段，recent 使用跟踪段；无法获得合法跟踪段时标 `trackingSegmentAvailable: false`，并显示「近期窗口是按尾部天数截的，不是真实上线跟踪段」。不拼接两段独立本金，recent 历史比较沿用验证净值前缀。衰减只提示，不驱动操作。
- 测试：[three-segment-sample.test.ts](../tests/three-segment-sample.test.ts)。字段与版本差异及快照边界处理见 [decisions](decisions.md)。

### V1 多重检验与同频夏普

- **是什么**：PSR/DSR 按 Bailey & López de Prado（2014）Eq. (2)，输入及紧缩门槛均为日夏普；日夏普复用 U1（rf=0、ddof=0），三四阶标准化矩使用总体矩，峰度非超额；候选夏普方差用 ddof=1。年化只用于展示，天数参数化并回显。
- **是什么（试验与样本）**：N 为本次候选数，是实际尝试次数下界，不是经相关性估计的有效独立试验数。候选矩阵在相同预热、全部预热后行情及成本上计算；DSR 对象只取各 fold 独立本金下测试日收益的时间顺序拼接。全窗方差是事后诊断，不参与原训练排名。
- **是什么（缺失）**：不足三日、非有限数、零收益方差、缺失候选夏普、试验不足、零试验方差、非正 PSR 分母均返回 null 和原因；候选数组保持同序，不丢候选、不补零。旧档案缺少 multipleTesting 时显示未记录，不追溯伪造。
- **为什么**：防止年化与日频混用、把空仓说成零风险、把未记录尝试或相关候选视为已完成独立性校正。N 下界与不构成业绩证据同时在 assumptions 和页面披露。
- **测试**：[multiple-testing.test.ts](../tests/multiple-testing.test.ts) 保护分位点、手算、单调性、偏度惩罚、U1 同源、退化、矩阵、拼接和页面；[walk-forward.test.ts](../tests/walk-forward.test.ts) 固定接入前 summary 全部数值。真实浏览器及统计适用性人工验收尚未执行。
- **违反会怎样**：选择偏差诊断被夸大为策略证据，或既有选参与汇总路径发生漂移。

### V2 CSCV 子段与并列

- **是什么**：复用 V1 全窗候选同期矩阵，默认 S=10，等长切段，末尾余数丢弃；每段至少 20 日。任一候选含 null 的子段全体共同作废，剩余段数为奇数再丢最后有效段，不重切。`discardedPeriods` 为总丢弃日数，`nullPeriods` 为缺失段日数（不重复计算），`oddPeriods` 为奇数补丢日数；`splits` 为有效段数，`requestedSplits` 回显请求。
- **是什么（排名）**：完整枚举 C(S,S/2)，补集按时间顺序作样本外。默认 metric="selection"，复用 U1 dailyPerformance 的复利净收益与含本金回撤，训练按净收益降序→回撤升序→fast升序→slow升序；候选参数与矩阵逐行对应，缺失或长度不符整份留空。metric="sharpe" 直接复用 V1，训练最佳并列取小序号；两口径仅在各自完整训练排序无法区分全部候选时整份无效。样本外仅按对应主指标（净收益或夏普），不含回撤和参数，并列取平均升序排名，ω=rank/(N+1)，PBO 为 λ≤0 比例。任一候选绩效缺失或非有限，整份 null + reason，不丢候选或组合。OLS 含截距，训练零方差回归留空；样本外零方差仅 R² 留空，不抹掉可计算的 PBO。
- **为什么**：不同样本排名、余数拉伸和挑选有效组合都会偏置 PBO。PBO 必须绑定所检验的选择动作，bySelectionRule 与 bySharpe 分列不合成，结论只挂前者；旧V2单份结果仅属夏普对照，不补算、不冒充实际规则。矩阵子段不重置持仓，并非独立重跑，也不是策略有效的证据；仅限当前候选集合，未记录人工试验不可观测。
- **测试**：[backtest-overfit.test.ts](../tests/backtest-overfit.test.ts) 保护组合、双并列、缺失奇偶、退化和手算回归；[backtest-overfit-api.test.ts](../tests/backtest-overfit-api.test.ts) 保护普通响应剥离 λ 与按需完整导出；既有 walk-forward 数值护栏保持。
- **违反会怎样**：假缺失、假样本外排名或页面载荷膨胀，或将不同选择规则误说成同一流程已验证。

### V5 研究使用台账与留出集

- **是什么**：四类计算运行追加 `records/research-usage`，同配置重复运行不覆盖。区间按含端点重叠计数，完整读取不能使用 `list` 默认 200 条。已记录的试验次数（下界）为 `max(candidateSum, distinctConfigs)`；未上线、应用外、失败/取消及写入失败的使用不可观测，不补造。
- **是什么（留出）**：`settings.holdoutStart` 默认 null，由用户手动设置，不自动平移，只记录不拦截。记录保存运行时起点与触碰标记；汇总按当前起点核对全台账，不因改设置清除历史记录，触碰次数不是统计显著性阈值。
- **是什么（隔离）**：输入构造、配置读取、台账写入与累计读取失败不能让研究失败；失败累计值为 null + reason。台账不占用样本研究档案限额。`multipleTesting.recordedTrials` 是运行时快照，只展示；跨标的跨配置的历史 m 绝不代入 DSR，DSR 继续使用本次候选数 N。
- **为什么**：防止截断历史造成虚假未触碰、观测工具阻断计算，或把不同检验对象的次数误用于论文 N。
- **测试**：[research-usage.test.ts](../tests/research-usage.test.ts) 保护 321 条全量、重叠、重复运行、失败隔离、限额隔离、留出边界、文案与 DSR 不变；公式与独立 worker 的接入另由运行路径测试保护。真实浏览器由管理者验收。

## 2. 通达信认定公式与预热

- **是什么**：输入为时间升序、不复权的只读 Bar 数组；输出与输入逐点对齐，不排序、不修改输入、不在中间舍入。MA 默认 20；图表 MA 默认 5/10/20/60；以下是默认口径，参数可调。

```text
EMA(X,N) = (2*X + (N-1)*前值)/(N+1)，首个有效 X 初始化
SMA(X,N,M) = (M*X + (N-M)*前值)/N；SMA(X,N,1) 就是 Wilder 平滑
MACD(12,26,9)：DIF=EMA(C,12)-EMA(C,26)，DEA=EMA(DIF,9)，柱=2*(DIF-DEA)
KDJ(9,3,3)：RSV=(C-LLV(L,9))/(HHV(H,9)-LLV(L,9))*100
             K=SMA(RSV,3,1)，D=SMA(K,3,1)，J=3*K-2*D
RSI(N)：SMA(MAX(C-REF(C,1),0),N,1)/SMA(ABS(C-REF(C,1)),N,1)*100
BOLL(20,2)：MID=MA(C,20)，上下轨=MID±2*STD(C,20)，STD 分母为 N−1
```

- **是什么（空值）**：窗口类 MA/STD/HHV/LLV 不足完整窗口返回 null；MA20/BOLL 前 19 根、默认 RSV 前 8 根无值。递推 EMA/SMA 从首个有效输入开始，不人为屏蔽预热；DEA 使用完整 DIF。空输入返回空数组，不用 0 或首值补齐缺失。
- **是什么（退化）**：无效输入保持递推状态，恢复后不重新初始化；KDJ 的 HHV=LLV 时 K、D 均不更新，初始无状态则保持 null，不用 50 种子。RSI 首根缺 REF、全平盘 0/0 返回 null，严格取上一根，不跨坏数据造涨跌。合法零成交 bar 仍参与指标计算。价格包装器要求正有限价格，公式序列可以为零或负数。
- **为什么**：×2、样本标准差和递推起点都会系统性改变信号；停牌不能被当成随意删行的理由。
- **测试**：[indicators.test.ts](../tests/indicators.test.ts) 覆盖手算、空值、退化、参数与确定性；[q2a-formula.test.ts](../tests/q2a-formula.test.ts) 覆盖序列基元；[q1-chart.test.ts](../tests/q1-chart.test.ts) 覆盖可调参数默认等价。与真实终端逐项人工一致：**无自动测试保护**，见 [M1 核对表](review/m1-tdx-checklist.md)。
- **违反会怎样**：BOLL 整体偏移、MACD 柱差一倍、历史窗口移动后指标漂移。

## 3. 未来函数必须硬拒绝

- **是什么**：[tdx-formula-check.ts](../src/lib/tdx-formula-check.ts) 在求值前检查全部语句，含未使用赋值和死分支。命中以下 **31 项**即拒绝执行并给函数名/行号，不能“警告后继续”：

```text
ZIG ZIGA PEAK PEAKBARS TROUGH TROUGHBARS BACKSET BARSNEXT REFX REFXV
XMA DRAWLINE DHIGH DOPEN DLOW DCLOSE DVOL FILTERX REFDATE CONST
ALIGNRIGHT CURRBARSCOUNT TOTALBARSCOUNT ISLASTBAR BARSTATUS IFC TESTSKIP
FINDHIGH FINDHIGHBARS FINDLOW FINDLOWBARS
```

- **是什么（其他门禁）**：跨周期 `#`、负数或不能静态证明非负整数的 REF 偏移均拒绝。白名单外函数明确报不支持，不近似替代。60 个可调用函数不含行情别名；FINANCE/DYNAINFO 原文失败不得偷偷删句，价量子集必须显式命名“非原公式”。筛选仅接受一个输出，运行时公式错误令整任务失败，不能跳过该股票冒充成功。
- **为什么**：事后重绘和末根依赖会产生当时不可能知道的候选；未支持的数据不能伪装成已支持。
- **测试**：[q2a-formula.test.ts](../tests/q2a-formula.test.ts)、[q2b-functions.test.ts](../tests/q2b-functions.test.ts)、[q2b-screening.test.ts](../tests/q2b-screening.test.ts)。
- **违反会怎样**：产生虚假历史信号或与原公式不等价的结果。

### 公式局部口径（同样不能裁丢）

- **是什么**：静态整数窗口；COUNT 的 N<=0 自首有效值累计，其他累计窗口 N=0 同理，内部未知保持未知。CROSS 前点相等视为下侧；FILTER 保守跟踪未知抑制；LAST 的 B=0 指当前点。运算优先级为一元、乘除、加减、比较、AND、OR，同级左结合。DMA 权重可为序列且 0<A<1；TMA 系数静态且小于1；ROUND 半值远离零，LOG 常用对数、LN 自然对数；BETWEEN 含端点，RANGE 不含端点。
- **为什么**：这些是已选择的可复核语义，不等于支持通达信所有动态参数变体。
- **测试**：[q2a-formula.test.ts](../tests/q2a-formula.test.ts)、[q2b-functions.test.ts](../tests/q2b-functions.test.ts)；终端逐项对照**无自动测试保护**，见 [Q2b 核对](review/q2b-review/README.md)。
- **违反会怎样**：语法仍可运行但候选发生隐蔽变化。

## 4. 因果性与完整历史

- **是什么**：固定截止点后追加未来 bar，不改变该截止点的指标、双突破、公式输出/候选快照与已结算台账。图表先算完整快照再裁显示窗口；双突破尾窗只能否决，候选必须重新读完整历史确认；公式递推和累计也不能套用旧均线尾窗。
- **为什么**：递推起点和可用证据时点属于结果契约。缠论未确认结构本身可以演化，不能将此约束误写成“DLL 全历史结构永不重绘”；台账用实际观察日固定证据，另存历史端点日。
- **测试**：[indicators.test.ts](../tests/indicators.test.ts)、[chart-data.test.ts](../tests/chart-data.test.ts)、[breakout.test.ts](../tests/breakout.test.ts)、[breakout-batch.test.ts](../tests/breakout-batch.test.ts)、[q2a-formula.test.ts](../tests/q2a-formula.test.ts)、[q2b-functions.test.ts](../tests/q2b-functions.test.ts)、[q2b-screening.test.ts](../tests/q2b-screening.test.ts)、[signal-ledger.test.ts](../tests/signal-ledger.test.ts)。
- **违反会怎样**：向左滚图、补数据或追加行情都会改写过去的“事实”。

## 5. 信号台账：宁可留空，不可给假数

- **是什么**：[signal-ledger-job.ts](../src/server/signal-ledger-job.ts) 每个完成交易日收盘后按本地全市场日线池向前积累两策略观察，不限订阅；落库不等于推送。无历史回放补录，首次旧缠论端点只建基线，质量变化是新观察。首次到期回填固定，含留空状态；数据修订不覆写已结算记录。
- **是什么（收益）**：信号观察日为 T，T+1 开盘入场，T+5/10/20 收盘出场；不复权、无成本、无滑点，页面标“非策略业绩”。按市场交易日而非该股有效 bar 计数；未到期继续等待，缺行情/停牌留空并记原因，不顺延。向下信号也用价格涨跌，不反号模拟做空。聚合只让有效收益进入统计，零收益进入胜率分母，缺盈利或亏损一侧时盈亏比留空。无建议、评级、自动调参。
- **是什么（除权三态）**：GBBQ 可读、全文件最大事件日期覆盖持有区间且无该股事件 → 无除权，可比；区间含类别 1/11/12 事件 → 含除权，不可比，收益空；文件缺失/不可读/无有效覆盖日期或最大日期早于区间末 → 未知，收益空。覆盖日期与来源必须展示；不能把“该股无事件”当成“未知”，也不能用文件 mtime 代替覆盖日期。
- **为什么**：无事件与缺证据不同；除权跳空不是策略亏损。全市场观察用于积累样本，订阅只用于控制打扰。
- **测试**：[signal-ledger.test.ts](../tests/signal-ledger.test.ts) 覆盖三态、区间两端、收益、基线、调度、幂等和未来隔离；[p2-notification-policy.test.ts](../tests/p2-notification-policy.test.ts) 覆盖过滤不改台账。
- **违反会怎样**：假收益污染分布，订阅选择偏差或历史回放被冒充向前证据。

## 6. 缠论原生边界

- **是什么**：[czsc.ts](../src/server/czsc.ts) 的全局 Promise 队列将任务交给一个专用子进程；[czsc-worker.ts](../src/server/czsc-worker.ts) 同步执行真实 C/V 的 Func40，再执行全部 Func30。禁止 koffi async、worker_threads 并发进入 DLL；台账线程把投影请求转回同一所有者。单例是每个宿主进程的边界，不是操作系统全局互斥锁。
- **是什么（ABI/精度）**：koffi 从 RegisterTdxFunc 的 pack(1) 注册表取 30/40 号指针；输入/输出用 Float32Array，价格不严格相等比较。库对象保持引用直至 disconnect，不能让裸函数指针指向已卸载库。少于两个端点为无结构。
- **是什么（golden）**：vendor 二进制为版本资产；运行时副本由构建复制。权威为来源 CzscCoreTests.cpp 断言，结果文本辅助，过期 notes 锚点不作依据。配置 0 对应笔 157/端点158/中枢18/买卖点17；1100 对应线段端点15/中枢2/买卖点2；mode=配置×1000+输出×10。除数量外核对方向、日期和价格；float32 锚点容差严格小于 0.0001。
- **为什么**：DLL 有全局 C/V 和单槽缓存，交错调用、失去库引用或混用二进制版本都会破坏结果。
- **测试**：[czsc.test.ts](../tests/czsc.test.ts)、[m4-native.test.ts](../tests/m4-native.test.ts)、[signal-ledger-worker.test.ts](../tests/signal-ledger-worker.test.ts)。跨独立应用实例只有一个 DLL 进程：**无测试保护，也非当前代码保证**。
- **违反会怎样**：信号串股、golden 失败或 native 崩溃。FFI 无法加载应汇报，不换库、不移植算法、不放宽 golden。

## 7. 双突破不足即未知

- **是什么**：[breakout.ts](../src/server/breakout.ts) 复用 vcpFacts 的确认摆动/歧义屏障和共享指标；至少 61 根日线，前 60 根结构窗口，趋势线至少两触，触及容差 0.5%，缩量平台 10 根；放量基准是此前 20 根均量×1.5。趋势、关键位、放量三项与五项质量评分分开，不能用评分覆盖核心失败。目标二缺失时 1:X 留空，不外推凑数；向下仅为破位观察。形态限评分所需，不扩完整形态库。
- **为什么**：结构及目标必须有当时证据，方法来源保存 swing-trader 文件 hash。
- **测试**：[breakout.test.ts](../tests/breakout.test.ts)、[breakout-batch.test.ts](../tests/breakout-batch.test.ts)；阈值合理性需 [M5 人工确认](review/m5-review/README.md)，**无自动测试保护**。
- **违反会怎样**：短历史拼出买点、虚构目标，评分被误读为完整交易准入。

## 8. 订阅、分级与真实投递

- **是什么**：通知仅送已启用订阅和渠道；日线缠论/双突破遵守 15:05、交易日、完成行情、交易状态及首次/恢复基线。旧 MA 订阅兼容保留。缠论观察级不因分级配置而变成可推送信号；新确认点与历史端点日期分开披露。
- **是什么（P2）**：立即/收盘汇总/仅台账三档只影响推送，过滤原因可追溯。立即档绕过 quietOutsideTrading，但仍受自定义 quietEnabled、每日限额、交易日去重约束；不延长真实交易窗口。入队、领取及发送前重新检查授权/静默；AI 不能绕过父信号限制。复用 outbox 四渠道，不重写链路，LLM 失败不撤回规则信号。
- **为什么**：落库与用户允许的打扰不是同一权限；每日 15:05 的强信号不能因默认盘外静默永远无法进入立即档。
- **测试**：[m4-monitor.test.ts](../tests/m4-monitor.test.ts)、[delivery-subscription.test.ts](../tests/delivery-subscription.test.ts)、[monitor-revision.test.ts](../tests/monitor-revision.test.ts)、[p2-notification-policy.test.ts](../tests/p2-notification-policy.test.ts)、[core.test.ts](../tests/core.test.ts)。假渠道端到端的**实际第三方投递数为 0**；受控本地 HTTP 不等于真实外发。
- **违反会怎样**：关闭订阅仍收到消息、重复刷屏、漏发或未经授权外发。真实测试通知必须用户明确请求并配置目标；自动测试不能代替人工真实渠道确认。

## 9. 持仓账本与除权审计

- **是什么**：本地手工成交是事实源，交易只追加、ID 幂等、事务中重放，计算移动加权成本和 T+1 可卖量。100 股整数倍来源为 mock-trading 契约；交易日/T+1 参考 astock-market-rules，不能错归来源。涨跌停用当日明确上下限及依据，不推测特殊日规则。费用复用 cost-experiment-1，标“实验参数，非历史实际费用”。
- **是什么（除权）**：普通除息/送转按 GBBQ 在当日交易前调整并留存调整前成本、事件和修订审计；覆盖不足、配股/缩股/碎股依据不足时已核对成本及浮盈留空，参考成本另列。新增股份可卖日须明确到账依据，不从除权日推导；除权前报价不能与除权后成本混算。交易可不关联信号，关联不能跨证券或指向未来。
- **为什么**：市场事件无法证明个人实际认购、到账与可卖数；信号收益与成交盈亏必须分开。
- **测试**：[p1-trade-ledger.test.ts](../tests/p1-trade-ledger.test.ts)、[p1-trade-services.test.ts](../tests/p1-trade-services.test.ts)。
- **违反会怎样**：超卖、重复录入、假浮盈或账本被错误除权覆盖。

## 10. 模拟盘契约与外部动作

- **是什么**：默认关闭，启用自身不请求网络；开户、对账、委托各需显式操作。产品下单需界面确认，60 秒一次性预览编号在请求前消费，不自动重放/重试；受理不等于成交，不自动写本地成交。历史 Q0 的实操授权不是本次文档任务的操作授权，不接真实券商。
- **是什么（契约）**：读取技能契约写 TypeScript HTTP 适配器，不执行技能交易 Python 脚本。允许的模拟主机与弱身份认证例外仅属模拟盘；用户名/资金及股东账号按凭证用 DPAPI 保存，不入业务库/日志。保留最近 20 次脱敏原始响应、fetchedAt、payloadHash、HTTP 状态及失败字段；成功适配也不删除诊断。文档/实测两套字段显式展示，冲突拒绝，9/8/: 未知市场不猜测、不静默丢弃。
- **是什么（重试/对账）**：结果未知保留原身份，不重复开户/买入；Q0 限定的一次重查已经用完，非自动重试许可。对账展示差异，不覆盖任一侧；实测持仓使用 gpsl+djsl，总数不等于 kysl 可卖数。
- **为什么**：弱认证身份仍能触发持久外部动作；契约会漂移，空结果不能伪装成空账户。
- **测试**：[p1-mock-trading.test.ts](../tests/p1-mock-trading.test.ts)、[p1-trade-services.test.ts](../tests/p1-trade-services.test.ts)、[p1-trade-ledger.test.ts](../tests/p1-trade-ledger.test.ts)。默认关闭实际请求 0；技能 hash 有覆盖，禁止执行任意技能脚本的全局静态护栏：**无测试保护**。
- **违反会怎样**：重复外部账户/委托、凭证泄漏、假对账。既有证券身份查询另有受限 westock-data Node 搜索入口；“不执行技能脚本”在此特指契约适配与研究方法读取，不伪称全仓库零子进程。

## 11. 图表不能画错周期或假成本

- **是什么**：week/month 仅为 ChartPeriod；复用完成周/月聚合，缺日、冲突、未完成周期排除。缺口的判定收在「能证明」的范围内：只有日历证明当天开市、而本品种缺这一根（或该日被标记休市）才算缺口，日历覆盖不到的日期不作为缺口——兜底日历只有最近约 400 个交易日且不含休市名单，按「工作日不在日历里即为缺口」的旧口径，每个节假日都会让整块周/月行情作废。周/月缠论和双突破明确不可用，5 分钟缠论图与日线监控分开，双突破只日线。视图/画线按标的×周期隔离增量落库，锚点存日期/价格，不存屏幕坐标。指标参数保存不改变策略参数；仅已核对成本可画成本线。保留 TradingView 归属标识，null 区间不画零、不跨缺口连线。
- **为什么**：把日线结构画到周线或把未核对成本画成确定线都会误导操作。
- **测试**：[q1-chart.test.ts](../tests/q1-chart.test.ts)、[chart-data.test.ts](../tests/chart-data.test.ts)、[chart.test.ts](../tests/chart.test.ts)、[weekly-bars.test.ts](../tests/weekly-bars.test.ts)。真实交互体验由用户确认。
- **违反会怎样**：结构错级别、跨证券画线污染、未完成周期提前产生历史形态。

## 12. 数据与迁移隔离

- **是什么**：源通达信目录只读；新解析器需二进制 fixture 与损坏输入测试。源、时点、单位、复权模式及 hash 显式保留。SQLite 只经 [migrations.ts](../src/server/db/migrations.ts) 增量迁移，不用 db:push，不修改历史迁移绕过版本检查。
- **是什么（运行）**：所有可能迁移的开发/浏览器/集成运行先设置隔离 QUANT_DATA_DIR。Vitest 的 [setup-data-dir.ts](../tests/setup-data-dir.ts) 仅在变量未设置时创建临时目录（`??=`），已设置生产路径时不会替你修正。每增一条迁移，现有打包版按交付规则即过期，由管理者重打包；不能降低 user_version 强开。
- **为什么**：默认目录是共享生产库，旧 exe 拒绝高版本库是保护数据的设计。
- **测试**：[core.test.ts](../tests/core.test.ts)、[integration.test.ts](../tests/integration.test.ts)、[tdx-gbbq.test.ts](../tests/tdx-gbbq.test.ts)、[tail-cache-codec.test.ts](../tests/tail-cache-codec.test.ts)、[signal-ledger.test.ts](../tests/signal-ledger.test.ts)、[q1-chart.test.ts](../tests/q1-chart.test.ts) 覆盖解析、快照及迁移保留。setup 文件是隔离机制，其正确挂载/不指向生产、每次重打包纪律：**无专门测试保护**。
- **违反会怎样**：损坏源数据、丢失研究证据、生产库升级后旧 exe“服务启动超时”。

## 13. 批处理与结构护栏

- **是什么**：N1 台账与 Q2b 公式为 worker 批处理，不阻塞 UI/监控，支持取消/进度；全市场单次 <10 分钟为管理者验收口径，不再按交互选股的倍数要求优化。性能改动由当前瓶颈证据驱动。合法 UI 变化可更新结构指纹，但须单独精确验证新增部分，不删、不跳过护栏。DLL EBUSY 要定位原因，不接受“重跑就好”。
- **为什么**：避免错误延迟指标驱动越界优化，也避免测试失去发现意外改动的能力。
- **测试**：[signal-ledger-worker.test.ts](../tests/signal-ledger-worker.test.ts)、[q2b-screening.test.ts](../tests/q2b-screening.test.ts)、[workbench-refactor.test.ts](../tests/workbench-refactor.test.ts)、[czsc.test.ts](../tests/czsc.test.ts)。全市场 <10 分钟的持续自动门禁：**无测试保护**，历史测量见 review。
- **违反会怎样**：界面卡住、取消后仍保存结果、为了追求无关性能扩大任务。

## 14. LLM 是解读层，不是执行器

- **是什么**：[research.ts](../src/server/research.ts) 及专项报告校验结构和证据 ID；技能只读取方法并记录文件 hash，缺文件明确失败；不能执行模型生成代码或让模型/信号触发交易 API。历史证据不能混入今天财务新闻冒充当时已知。
- **为什么**：模型输出与外部证据不可信，报告成功不等于策略被验证有用。
- **测试**：[research.test.ts](../tests/research.test.ts)、[report-security.test.ts](../tests/report-security.test.ts)、[local-llm.test.ts](../tests/local-llm.test.ts)、[research-skills.test.ts](../tests/research-skills.test.ts)、[m4-monitor.test.ts](../tests/m4-monitor.test.ts)。
- **违反会怎样**：伪造引用、未来信息泄漏、自动产生未经确认的交易动作。

## 15. 文档裁定与范围纪律

- **是什么**：M1–M5 为历史交付记录，新增需求按 E0–E4 推进。A 层机器验证与 B 层人工确认分开；历史模块可按授权修改，研究按数据与交易证据分层，小样本只作描述，不声称有效。局部边界自行决定并记录；仅范围、架构、不可逆动作、许可事项升级。历史“不动某文件”与已授权交付冲突时以交付为准并记录，不能拿它越过当前用户限制。
- **为什么**：防止把已完成工作重做、把小样本/机器核对冒充有效性结论。GPL 对外捆绑决定仍交用户；这里只记录项目分发门禁，不作法律结论。
- **测试**：**无测试保护**（工程与授权纪律）。当前范围见 [roadmap §2](roadmap.md#2-当前范围与待议)，E0–E4 规格见 [next-plan.md](next-plan.md)。
- **违反会怎样**：范围失控、错误业绩宣传、未经授权分发；README“不能用作正式策略业绩”的限定在具备相应交易与数据验证证据前保留，不因新增研究功能自动移除。

### V3 信号信息含量

- **是什么**：新增 [signal-information.ts](../src/lib/signal-information.ts) 与旧聚合并存。按策略×方向×期限分组，short 的 returnPct 不取反；按观察日计算平均并列秩 Spearman，截面少于5条留空。IC样本标准差 ddof=1，小于10截面警告；不足2截面或标准差为零的比率留空。分层默认5组，每组期望少于10条降3组，仍不足整组留空；全样本经验分位数，并列跨界整体归低组，空组不填零。
- **为什么**：空头是价格方向观察，反号会虚构做空收益；拆并列与补零会制造评分差异。
- **测试**：[signal-information.test.ts](../tests/signal-information.test.ts) 覆盖手算、方向、排除、去重、门槛、分层、退化与服务端选页展示。
- **违反会怎样**：虚构盈亏、混方向抵消，或把不足样本误当作可信信号证据。

### V4 证券池时点审计

- **是什么**：审计只读 `storedSecurityLifecycle` 既有可信日期缓存与本地名单/代码映射，不调用核验、远程接口、行情扫描或研究采集，不保存新名单快照。缺日期计入 `noEvidence`，行情覆盖日期绝不充当上市日；主档没有首日时单列覆盖未知数。
- **是什么（口径）**：退市字段按任务书明确的 `退市日 ≤ end` 计数，含起点以前已退市标的，页面始终显示「≥ N 只」，不可估计偏差幅度。北交所代码文件只证明供应商记录，不能证明沪深无代码变更或记录日为生效日。
- **是什么（时点）**：名单快照时间不能用 mtime 或本次读取时间替代。研究使用原冻结成员和区间，系统采集时间标为研究快照时间，不当作官方成分生效日；概念使用结果保存的成分并集，未保存周期起点时由用户明确选择审计区间，不以自然日推算交易日。
- **为什么**：防止当前成分、不可枚举的已移除证券和缺失缓存被误读为完整历史证券池。当前缓存证据不表示研究当时已知。
- **测试**：[universe-audit.test.ts](../tests/universe-audit.test.ts) 保护手算、边界、空池、零核验/外呼、只读名单、原快照成员、分页与下界展示。真实数据与浏览器验收尚待管理者执行。
- **违反会怎样**：审计触发外呼、伪造上市日期、把退市下界宣称为精确总量或把今天名单当历史名单。

## W1 研究送转口径

- **是什么**：`adjustment` 省略或 `none` 时保持全部原数值与现金实验路径。`backward` 仅送转因子：`1 + bonusRatio`，不含现金/配股；信号用调整价，成交估值用原始价，策略及买入持有股数跟送转，现金分红只计数、不入现金。碎股向下取整到整股并按生效观测日原始开盘价折现。
- **是什么（拒绝）**：类别1且配股比例为正，以及11/12/13/14，或来源缺失/未覆盖/事件非法，整段不可用并返回原因与诊断；先检查整个输入，禁止候选、预热和尾部绕过拒绝。类别2至10按 W1 §8 总股本/上市流通变动假设处理，不重复增股，必须披露判断来源及可卖性未建模。
- **为什么**：现金信号复权但现金不入账会混用口径；因子调股会误计现金/配股。仅送转仍残留除息跳空，未还原登记日、送股可卖日、现金到账、退市、历史税制和成交量调整，不构成可信业绩。
- **测试**：[backtest-adjustment.test.ts](../tests/backtest-adjustment.test.ts) 保护手算净值、现金不入账、碎股、拒绝清单、默认完整结果哈希、信号反例、日期对齐与候选/fold透传。实际证券与浏览器验收由管理者执行，无自动化真实数据证明。
- **违反会怎样**：假暴跌进入风险统计，信号与持仓口径不一致，或不可用事件被当零收益参与选参。

## W4 出入金前估值

- **是什么**：`flowValuation` 默认 `explicit`，保持原算法；`previousClose` 仅在有证券持仓路径且调用方未提供逐笔估值时，用交易日历紧邻前一日收盘账户总估值（现金 + 持仓市值 + 逆回购本金）补足。首日或前日估值不可得仍留空，不追溯更早日期。显式非法值不回退；空仓继续用事件时现金加本金，逆回购原因非空继续留空。
- **为什么**：前收只是日频近似。固定说明同时随结果输出并展示于 TWR：缺失的出入金前估值以前一交易日收盘估值替代；单笔出入金时，当日市场波动计入出入金后一期；不是精确时点估值。
- **局限**：同日多笔各复用同一前收，可能产生较大偏差；不保证同日多笔的波动归属。
- **测试**：[trade-review-nav.test.ts](../tests/trade-review-nav.test.ts) 保护修改前完整输出快照、三日手算、显式优先、缺口、空仓、逆回购与多笔反例；[trade-review-ui.test.ts](../tests/trade-review-ui.test.ts) 保护两种模式的页面说明与重放输入。
- **违反会怎样**：把近似值当成时点估值、跨缺口补造收益或改变默认模式数值。

## W8 逆回购资金方向

- **是什么**：仅逆回购按实际 netAmount 符号判方向，负为融出、正为购回；null、非有限数及零不猜方向，计入 unknownDirectionCount，逐笔 warnings 说明原因。操作列与资金方向冲突逐笔保留“操作列与资金方向不一致，以资金方向为准”。普通证券仍按 kind。
- **配平**：逐品种融出数量记正、购回记负；任一品种方向不可判或数量未平，汇总 interestIncome 留空并说明原因；全部配平才汇总净现金。资金占用仍为累计实际负现金绝对值，非峰值。
- **为什么**：券商成交明细存在卖出标签实际为购回的记录，按标签配平会让已闭环利息永久留空。
- **测试**：[w8-repo-direction.test.ts](../tests/w8-repo-direction.test.ts) 保护配平、跨品种不抵消、缺失与冲突留痕、普通证券不变；W8_REAL_DATA=1 启用本地真实账单验收及修改前非逆回购完整输出 SHA-256 护栏。
- **违反会怎样**：利息留空或方向误判，数据源格式变化被静默掩盖。

## W10 同日内现金顺序

- **是什么**：净值重放先沿既有日期/时间/原始行序排序，再仅把 `reverseRepo` 的有限正 `netAmount` 与 `cashManagement` 的有限正 `amount` 提前到当日首笔资金流出之前。其他记录保持原相对顺序，普通证券回合配对排序不变，原始输入不修改；实际发生重排时在输出 warnings 标注「同日内逆回购与现金管理流入已提前」。
- **日末**：重排日的收盘现金仍按原事件顺序累计，避免浮点加法次序造成尾差；不调整期初现金、不补造流水。需重排的日期若含成交柜台资金余额锚点，明确报错，不能把原路径的绝对余额套到新路径。
- **为什么**：内部回款应先供资金使用，但普通证券先买/先卖会影响移动加权成本和回合；排序只能改变日内路径，不能改变日末余额。
- **测试**：[w10-intraday-order.test.ts](../tests/w10-intraday-order.test.ts) 保护手算、买卖双顺序的逐项回合/成本、跨日、输入不变、非法金额、余额锚点拒绝与标注；`W10_REAL_DATA=1` 核对指定本地文件的完整回合结果、逐日精确现金值及流水数量/金额。W8 非逆回购哈希护栏保持。
- **违反会怎样**：普通证券统计漂移、虚构现金改善、日末对账失真，或掩盖数据源排序假设。

### W12 逐笔 VWAP 单位与异常隔离

- **是什么**：执行质量以原始 `amount / volume` 除以交割单成交价识别倍率；[0.8,1.25]、[8,12.5]、[80,125] 分别除以 1、10、100，其他比例不猜测。倍率不依赖品种或 close，不保留 close 归一备用路径；原始 VWAP 入口及 R12 价格校验不改。
- **是什么（异常）**：无法识别倍率或换算后 |BP|>500 的记录进入 `unitMismatchCount` 与完整明细；滑点分子和成交额分母同时排除，费用仍保留，全体总执行成本留空。已识别但超 500 BP 的 VWAP 保留供原反事实诊断，W11 非正值拦截不放宽。
- **为什么**：同一证券的历史成交量单位可能改变；沪深转债 close 也可能是元/手，不能作确定单位的中间参照。成交价只识别数量级，不替代 VWAP。
- **测试**：[execution-quality.test.ts](../tests/execution-quality.test.ts) 覆盖四条自检、同代码跨日期倍率、close 无关性、区间边界、未知倍率、异常双边排除及完整导出；真实验收保持回合 785 / 50.892857% / 0.891201。
- **违反会怎样**：十倍/百倍单位错误伪装成执行优势，或者通过选择性分母美化滑点。异常标签不证明一定是单位错误，仍需人工检查行情和当日价格偏离。
