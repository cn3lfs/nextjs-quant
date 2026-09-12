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

- **是什么**：week/month 仅为 ChartPeriod；复用完成周/月聚合，日历未知、缺失、冲突、未完成周期排除。周/月缠论和双突破明确不可用，5 分钟缠论图与日线监控分开，双突破只日线。视图/画线按标的×周期隔离增量落库，锚点存日期/价格，不存屏幕坐标。指标参数保存不改变策略参数；仅已核对成本可画成本线。保留 TradingView 归属标识，null 区间不画零、不跨缺口连线。
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
