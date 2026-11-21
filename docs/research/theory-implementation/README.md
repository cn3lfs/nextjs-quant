# 理论到策略工程覆盖

逐卡研究到工程映射；strategyIds只表示明示本地代理或组件，不表示原法等价、回测通过或盈利。new-proxy须通过绑定验证后才表示可执行。

核对日期：2026-11-17。共 228 张卡。existing-proxy: 52；new-proxy: 35；component: 54；engineering: 26；data-gap: 51；interpretation: 10。

## 读取方式

- existing-proxy：已有可执行本地规则；与原法的差异见理由。
- new-proxy：本轮新增可执行代理（周期以策略定义为准）；必须通过目录绑定验证，不代表通过收益检验。
- component：指标、分析、风险或执行组件，不计独立交易策略；是否已有代码见证据。
- engineering：输入已有或容易取得，但该卡交易包装/模型尚待工程，不能称已交付。
- data-gap：所需历史时点或执行输入未齐，不补造数据。
- interpretation：仍含原法解释/人工证据，机械代理需另命名。

映射事实源为 [coverage.json](coverage.json)。理论方法在 [策略筛选模块](../../../packages/trading-strategies/src/screener/)中逐步注册，并通过对应的单元测试验证。原研究来源与人工留项仍全部有效。

## 生成统计

- 分批：B1-规则融合: 83；B2-可用数据工程: 26；B2-多周期结构与离线财务: 7；B3-输入与解释补齐: 92；P4-策略闭环公共组件: 19；P4-策略闭环可执行代理: 1。
- 策略绑定：唯一 99；existing-proxy 唯一 59；new-proxy 唯一 40。
- component：共 54 张；有代码证据 32 张；其余 22 张为理论/分析组件，不表示已有可执行代码。
- engineering 逐卡就绪评估见 [closure-readiness.md](closure-readiness.md)；P4 排期不改变本表 status。

## 分批推进

B1融合已有规则与新增代理，先做因果及成交检查；B2推进价格结构、周期、多周期、截面和财务中输入就绪的工程，逐卡更新状态；B3核验历史财报、题材/事件、盘口、多腿与解释证据。B2/B3不是一概删除或永远排除。

收益研究按全部实际尝试计数：训练/开发集初筛与有限优化，未使用时段只在锁定候选后评价；已反复查看的历史只能作开发数据，缺干净留出则前向观察。禁止只报告获胜参数。沪深当前成分前视和BTC/ETH单一市场共同暴露单独标记。

## 逐项去向

| 理论 | 去向 | 策略绑定 | 具体边界或剩余工作 |
| --- | --- | --- | --- |
| [F01.01 有效市场假说（EMH）](../theory-to-pseudocode/F01.md#f01-01-v2) | component | — | 市场效率为可检验假说，需定义收益预测检验，不能直接下单 |
| [F01.02 随机游走与鞅基准（Random Walk / Martingale）](../theory-to-pseudocode/F01.md#f01-02-v2) | component | — | 随机过程用于零优势对照，随机交易基准尚未接入 |
| [F01.03 行为金融（Behavioral Finance）](../theory-to-pseudocode/F01.md#f01-03-v2) | component | — | 行为机制需先选可观测代理，不能由心理术语产生买点 |
| [F01.04 适应性市场假说（Adaptive Markets Hypothesis）](../theory-to-pseudocode/F01.md#f01-04-v2) | component | — | 环境适应是假说，需冻结变化检测与切换映射 |
| [F01.05 分形市场假说（Fractal Market Hypothesis）](../theory-to-pseudocode/F01.md#f01-05-v2) | component | — | 多尺度统计为分析组件，需定义尺度与检验统计量 |
| [F01.06 风险溢价（Risk Premium）](../theory-to-pseudocode/F01.md#f01-06-v2) | component | — | 风险溢价解释不是单个入场系统 |
| [F01.07 反身性（Reflexivity）](../theory-to-pseudocode/F01.md#f01-07-v2) | component | — | 反馈机制缺少可观测方向和首次可知时点 |
| [F01.08 拍卖市场理论（Auction Market Theory）](../theory-to-pseudocode/F01.md#f01-08-v2) | component | — | 拍卖解释需价格接受与拒绝的机械规则 |
| [F01.09 现金基准（Cash Benchmark）](../theory-to-pseudocode/F01.md#f01-09-v2) | component | — | 现金收益基准需同币种可投资利率序列，现有零息现金须显式标注 |
| [F01.10 买入持有基准（Buy and Hold）](../theory-to-pseudocode/F01.md#f01-10-v2) | existing-proxy | `hold` | 已实现一次建仓且不复投分红；不是所有总回报持有口径 |
| [F01.11 等权基准（Equal Weight）](../theory-to-pseudocode/F01.md#f01-11-v2) | existing-proxy | `allocation-equal` | 已有全部有效候选等权配置；调仓与可交易约束由回放负责 |
| [F02.01 道氏理论（Dow Theory）](../theory-to-pseudocode/F02.md#f02-01-v2) | component | — | 已实现确认摆点道氏结构组件：两指数共用 asOf，同一确认时刻保守返回 UNKNOWN；两指数同向才 UP/DOWN，单方或未来确认不反推。仅为结构过滤，不称完整 Rhea 系统，NO_DIRECT_TRADE |
| [F02.02 趋势层级（Primary / Secondary / Minor Trends）](../theory-to-pseudocode/F02.md#f02-02-v2) | component | — | 已实现长/中/短三层独立趋势状态及长UP+中DOWN回调候选；短层不得改写长层，缺失层 UNKNOWN。仅为多尺度过滤，NO_DIRECT_TRADE |
| [F02.03 指数相互确认（Intermarket / Average Confirmation）](../theory-to-pseudocode/F02.md#f02-03-v2) | component | — | 已实现双指数确认状态机：版本与 frozenAt 冻结、按完成bar计窗口、过期先烧毁整版、缺口断连续、乱序/重复不倒退。单方只 WAIT，NO_DIRECT_TRADE |
| [F02.04 支撑与阻力（Support / Resistance）](../theory-to-pseudocode/F02.md#f02-04-v2) | component | — | 已实现确认支撑拒绝组件；3/3确认、冻结ATR容差、有效期及深穿排除，不作为独立交易策略 |
| [F02.05 趋势线（Trendline）](../theory-to-pseudocode/F02.md#f02-05-v2) | new-proxy | `theory-trendline-close` | 确认下降高点投影突破；确认后低点作固定保护；完整单向入退场已接入，右侧确认滞后保留；本地代理不声明完整原法或有效收益 |
| [F02.06 价格通道（Price Channel）](../theory-to-pseudocode/F02.md#f02-06-v2) | existing-proxy | `breakout` | 复用此前55日高点/20日低点的收盘通道，不代表全部通道定义 |
| [F02.07 Livermore 关键点与领涨股（Pivotal Points / Leaders）](../theory-to-pseudocode/F02.md#f02-07-v2) | component | — | 已实现 Livermore 关键点/领涨股只做多筛选组件：仅限 CN 股票，冻结 watchlist、基准与锚点（锚点确认须为已完成日线且不得晚于决策截止），显式 lookback/maxCandidateAge 等 A 参数；F02 为当前完成收盘决策，asOf 须同上海交易日且 >=15:05，决策日完成由 core completedBarFilter 证明。实际持仓按 fillId 匹配不可变冻结止损；EXIT 仅为意图并保留 pendingExit 原保护/触发证据，须宿主 position:null 确认才清除。原卡止损/退出规则保留；仅输出 ENTER/HOLD/EXIT/WAIT/UNKNOWN 意图，不是完整策略、执行或业绩，NO_DIRECT_TRADE |
| [F02.08 Weinstein 四阶段（Stage Analysis）](../theory-to-pseudocode/F02.md#f02-08-v2) | new-proxy | `theory-stage150` | 150日均线和20根斜率的日线阶段转强代理，不等同原周线四阶段；完整单向入退场已接入，右侧确认滞后保留；本地代理不声明完整原法或有效收益 |
| [F02.09 高低点序列与市场结构（Swing Structure）](../theory-to-pseudocode/F02.md#f02-09-v2) | new-proxy | `theory-swing-breakout` | 3/3确认HH/HL后冻结末高低并等待突破；完整单向入退场已接入，右侧确认滞后保留；本地代理不声明完整原法或有效收益 |
| [F03.01 SMA、EMA 与 WMA 平滑](../theory-to-pseudocode/F03.md#f03-01-v2) | component | — | SMA/EMA/WMA为已有指标原语，不单独计策略 |
| [F03.02 单均线趋势规则（Single Moving Average）](../theory-to-pseudocode/F03.md#f03-02-v2) | existing-proxy | `sma200` | 已有收盘对MA200的趋势基线 |
| [F03.03 双均线交叉（Dual Moving Average Crossover）](../theory-to-pseudocode/F03.md#f03-03-v2) | existing-proxy | `ma`、`golden-cross`、`ema-cross` | 已有双均线基线 |
| [F03.04 三均线过滤（Triple Moving Average）](../theory-to-pseudocode/F03.md#f03-04-v2) | existing-proxy | `triple-ma` | 已有三均线基线 |
| [F03.05 均线排列与回踩（Alignment / Pullback）](../theory-to-pseudocode/F03.md#f03-05-v2) | new-proxy | `theory-ema-reclaim` | 新增EMA重夺代理，原排列回踩版本仍分别保留；新增规则为独立日线本地代理，最终工程状态由目录绑定检查，不宣称原法复现 |
| [F03.06 MACD（Moving Average Convergence Divergence）](../theory-to-pseudocode/F03.md#f03-06-v2) | existing-proxy | `macd` | 已有MACD规则 |
| [F03.07 DMI 与 ADX（Directional Movement / Trend Strength）](../theory-to-pseudocode/F03.md#f03-07-v2) | existing-proxy | `dmi` | 已有DMI/ADX规则 |
| [F03.08 抛物线转向指标（Parabolic SAR）](../theory-to-pseudocode/F03.md#f03-08-v2) | existing-proxy | `sar` | 已有SAR规则 |
| [F03.09 Supertrend（超级趋势）](../theory-to-pseudocode/F03.md#f03-09-v2) | existing-proxy | `supertrend` | 已有Supertrend规则，ATR初始化按目录声明 |
| [F03.10 一目均衡表（Ichimoku Kinko Hyo）](../theory-to-pseudocode/F03.md#f03-10-v2) | existing-proxy | `ichimoku` | 已有一目规则，使用延迟云层 |
| [F03.11 Elder 三重滤网（Triple Screen）](../theory-to-pseudocode/F03.md#f03-11-v2) | new-proxy | `theory-triple-screen-week-day`、`theory-triple-screen-day-hour-five` | 已实现周日收盘与日/60分/5分两版本地代理；仅完成周期、同源复权、实际成交状态，非原法盘中买停单复现 |
| [F03.12 Chandelier Exit（吊灯止损）](../theory-to-pseudocode/F03.md#f03-12-v2) | existing-proxy | `chandelier` | 已有最高收盘减ATR退出，属于保护组件包装 |
| [F03.13 KAMA（Kaufman Adaptive Moving Average）](../theory-to-pseudocode/F03.md#f03-13-v2) | existing-proxy | `classic-kama` | 已有KAMA基线 |
| [F03.14 Aroon（阿隆指标）](../theory-to-pseudocode/F03.md#f03-14-v2) | existing-proxy | `classic-aroon` | 已有Aroon基线 |
| [F03.15 TRIX（三重指数平滑变化率）](../theory-to-pseudocode/F03.md#f03-15-v2) | existing-proxy | `classic-trix` | 已有TRIX基线 |
| [F03.16 Coppock Curve（科波克曲线）](../theory-to-pseudocode/F03.md#f03-16-v2) | existing-proxy | `classic-coppock` | 已有日线化Coppock代理，不冒充月线原法 |
| [F03.17 Vortex Indicator（涡旋指标）](../theory-to-pseudocode/F03.md#f03-17-v2) | existing-proxy | `classic-vortex` | 已有Vortex基线 |
| [F04.01 Donchian 通道突破（Price Channel Breakout）](../theory-to-pseudocode/F04.md#f04-01-v2) | existing-proxy | `breakout` | 现有Donchian55/20可复用，原卡重入门控与现有持续状态需区分 |
| [F04.02 海龟交易法（Turtle Trading）](../theory-to-pseudocode/F04.md#f04-02-v2) | existing-proxy | `turtle` | 已有日线20/10及2ATR简化版；虚拟突破过滤、分单位加仓与盘中顺序未实现 |
| [F04.03 箱体与新高突破（Range / New High Breakout）](../theory-to-pseudocode/F04.md#f04-03-v2) | new-proxy | `theory-box20` | 新增20根箱体收盘代理，不混入Darvas；新增规则为独立日线本地代理，最终工程状态由目录绑定检查，不宣称原法复现 |
| [F04.04 布林带与肯特纳挤压突破（Bollinger / Keltner Squeeze）](../theory-to-pseudocode/F04.md#f04-04-v2) | new-proxy | `theory-squeeze` | 新增BB/KC收缩释放完整代理；新增规则为独立日线本地代理，最终工程状态由目录绑定检查，不宣称原法复现 |
| [F04.05 开盘区间突破（Opening Range Breakout / ORB）](../theory-to-pseudocode/F04.md#f04-05-v2) | new-proxy | `theory-utc-orb` | 已实现明确命名的仅 BTC/ETH 现货 UTC 5 分钟完成收盘突破代理：stretch = 前 10 个完整 UTC 日 min(H-O,O-L) 的均值（2880 根完成 5 分钟 bar），不是 ATR；首个完整 5 分钟开盘区间加 stretch 冻结 U/S，完成收盘越过 U 发出入场意图，后续跌破冻结 S 或会话退出发出退出意图，均在宿主语义下于下一根 bar 开盘执行。CN 原卡 T+1 与分钟尾部缺口另行阻断。非原法精确复现、收益或浏览器验收，根 P5 bundled/app 验收待完成 |
| [F04.06 Dual Thrust（双推力）](../theory-to-pseudocode/F04.md#f04-06-v2) | existing-proxy | `dual-thrust` | 已有日线收盘确认代理，不是原日内反手系统 |
| [F04.07 NR4 与 NR7（Narrow Range）](../theory-to-pseudocode/F04.md#f04-07-v2) | new-proxy | `theory-nr4-close`、`theory-nr7-close` | 新增NR4和NR7收盘确认，双边穿越歧义必须排除；新增规则为独立日线本地代理，最终工程状态由目录绑定检查，不宣称原法复现 |
| [F04.08 双突破（趋势线与水平阻力的联合突破）](../theory-to-pseudocode/F04.md#f04-08-v2) | existing-proxy | `research-breakout` | 复用既有确认趋势线及水平位双突破 |
| [F05.01 蜡烛图（Candlestick Analysis）](../theory-to-pseudocode/F05.md#f05-01-v2) | new-proxy | `theory-engulf-confirm` | 新增吞没确认本地代理；蜡烛图全体系不由单形态覆盖；新增规则为独立日线本地代理，最终工程状态由目录绑定检查，不宣称原法复现 |
| [F05.02 Pin Bar（针形 K 线）](../theory-to-pseudocode/F05.md#f05-02-v2) | new-proxy | `theory-pin-confirm` | 新增针形确认代理；新增规则为独立日线本地代理，最终工程状态由目录绑定检查，不宣称原法复现 |
| [F05.03 Inside Bar（内包线）](../theory-to-pseudocode/F05.md#f05-03-v2) | new-proxy | `theory-inside-close` | 新增内包线收盘确认代理；新增规则为独立日线本地代理，最终工程状态由目录绑定检查，不宣称原法复现 |
| [F05.04 头肩顶与头肩底（Head and Shoulders）](../theory-to-pseudocode/F05.md#f05-04-v2) | new-proxy | `theory-head-shoulders-bottom` | 确认低高低高低和固定肩部容差的头肩底颈线代理；完整单向入退场已接入，不声明原法等价或有效收益 |
| [F05.05 双顶与双底（Double Top / Double Bottom）](../theory-to-pseudocode/F05.md#f05-05-v2) | new-proxy | `theory-double-bottom` | 已确认双底、固定3%容差和颈线突破；完整单向入退场已接入，右侧确认滞后保留；本地代理不声明完整原法或有效收益 |
| [F05.06 三角形（Symmetrical / Ascending / Descending Triangle）](../theory-to-pseudocode/F05.md#f05-06-v2) | new-proxy | `theory-triangle-close` | 已确认下降高点/上升低点的收敛线突破；完整单向入退场已接入，右侧确认滞后保留；本地代理不声明完整原法或有效收益；本版仅确认摆点双线收敛，未检验全部形成期OHLC被两线包络，属于简化代理 |
| [F05.07 旗形与三角旗（Flag / Pennant）](../theory-to-pseudocode/F05.md#f05-07-v2) | new-proxy | `theory-flag-close` | 10根旗杆与10根有限回撤整理的价格代理；完整单向入退场已接入，右侧确认滞后保留；本地代理不声明完整原法或有效收益 |
| [F05.08 楔形（Rising / Falling Wedge）](../theory-to-pseudocode/F05.md#f05-08-v2) | new-proxy | `theory-falling-wedge` | 确认下降双线收敛、形成期OHLC包络校验的楔形代理；完整单向入退场已接入，不声明原法等价或有效收益 |
| [F05.09 杯柄形态（Cup with Handle）](../theory-to-pseudocode/F05.md#f05-09-v2) | new-proxy | `theory-cup-handle` | 确认高低高低、固定杯深及柄幅的几何代理，不代表完整O’Neil法；完整单向入退场已接入，不声明原法等价或有效收益 |
| [F05.10 平台与平底整理（Base / Flat Base）](../theory-to-pseudocode/F05.md#f05-10-v2) | new-proxy | `theory-flat-base` | 高位35根窄幅整理、均线趋势和放量突破；完整单向入退场已接入，右侧确认滞后保留；本地代理不声明完整原法或有效收益 |
| [F05.11 缺口（Price Gaps）](../theory-to-pseudocode/F05.md#f05-11-v2) | new-proxy | `theory-gap-continuation` | 新增向上缺口延续代理；不覆盖所有缺口交易；新增规则为独立日线本地代理，最终工程状态由目录绑定检查，不宣称原法复现 |
| [F05.12 Al Brooks 价格行为](../theory-to-pseudocode/F05.md#f05-12-v2) | engineering | — | 裁量价格行为需选明确子规则，不能包装黑箱 |
| [F05.13 点数图（Point and Figure / P&F）](../theory-to-pseudocode/F05.md#f05-13-v2) | component | — | 已实现固定格值收盘法 X/O 列与同列单次突破组件：b>0、整数 r>=1、floor(C/b)，缺口重置分段；动态ATR格值及原著计数目标未实现，NO_DIRECT_TRADE |
| [F06.01 Elliott 推动浪（Impulse / Motive Waves）](../theory-to-pseudocode/F06.md#f06-01-v2) | interpretation | — | 原卡仍含人工计数或版本解释；可计算子规则可另命名代理，尚未完整实现 |
| [F06.02 Elliott 调整浪（Corrective Waves）](../theory-to-pseudocode/F06.md#f06-02-v2) | interpretation | — | 原卡仍含人工计数或版本解释；可计算子规则可另命名代理，尚未完整实现 |
| [F06.03 浪级、交替与替代计数（Degree / Alternation / Alternative Counts）](../theory-to-pseudocode/F06.md#f06-03-v2) | interpretation | — | 原卡仍含人工计数或版本解释；可计算子规则可另命名代理，尚未完整实现 |
| [F06.04 Fibonacci 回撤（Retracement）](../theory-to-pseudocode/F06.md#f06-04-v2) | new-proxy | `theory-fib-reclaim` | 已确认上涨段50%回撤后收复确认；50%不称原Fibonacci数比；完整单向入退场已接入，右侧确认滞后保留；本地代理不声明完整原法或有效收益 |
| [F06.05 Fibonacci 扩展与投射（Extension / Projection）](../theory-to-pseudocode/F06.md#f06-05-v2) | component | — | 已实现两点扩展/三点投射目标纯组件：确认锚点后 EXTENSION=A+rD、PROJECTION=C+rD；冻结模式与比例，投射收盘跌破C失效，保护退出优先；仅输出目标与宿主保护/减仓参考，不产生新入场，不是完整策略或收益验证，NO_DIRECT_TRADE |
| [F06.06 Hurst 周期分析](../theory-to-pseudocode/F06.md#f06-06-v2) | engineering | — | OHLC可得，周期估计方法、在线稳定性与信号映射待工程 |
| [F06.07 附录：江恩（Gann）](../theory-to-pseudocode/F06.md#f06-07-v2) | interpretation | — | 原卡仍含人工计数或版本解释；可计算子规则可另命名代理，尚未完整实现 |
| [F06.08 附录：谐波形态（Harmonic Patterns）](../theory-to-pseudocode/F06.md#f06-08-v2) | component | — | 已实现五点确认谐波比例标签纯组件：严格形成顺序与交替结构、四型比例表、AB_EQ_CD 独立标签；仅识别标签，不含 PRZ 执行或入场确认，不是完整形态策略或收益验证，NO_DIRECT_TRADE |
| [F06.09 附录：SMC（Smart Money Concepts）](../theory-to-pseudocode/F06.md#f06-09-v2) | interpretation | — | 原卡仍含人工计数或版本解释；可计算子规则可另命名代理，尚未完整实现 |
| [F06.10 附录：ICT（Inner Circle Trader）](../theory-to-pseudocode/F06.md#f06-10-v2) | interpretation | — | 原卡仍含人工计数或版本解释；可计算子规则可另命名代理，尚未完整实现 |
| [F07.01 包含关系与 K 线合并](../theory-to-pseudocode/F07.md#f07-01-v2) | component | — | 已有原生/开源合并结构，不能推定算法等同全部缠论 |
| [F07.02 顶底分型](../theory-to-pseudocode/F07.md#f07-02-v2) | component | — | 已有分型结构，首次确认点需保持 |
| [F07.03 笔](../theory-to-pseudocode/F07.md#f07-03-v2) | component | — | 已有笔结构，版本和DLL语义独立 |
| [F07.04 线段](../theory-to-pseudocode/F07.md#f07-04-v2) | engineering | — | 线段解释需按版本保留，原生输入不证明原文复现 |
| [F07.05 特征序列](../theory-to-pseudocode/F07.md#f07-05-v2) | engineering | — | 特征序列定义与跨段证据仍待接入 |
| [F07.06 中枢](../theory-to-pseudocode/F07.md#f07-06-v2) | engineering | — | 中枢有结构输入，级别及延伸规则需明确 |
| [F07.07 走势类型与走势连接](../theory-to-pseudocode/F07.md#f07-07-v2) | engineering | — | 走势类型连接尚非完整可执行策略 |
| [F07.08 趋势背驰](../theory-to-pseudocode/F07.md#f07-08-v2) | engineering | — | 背驰需同级别比较和首次确认时间 |
| [F07.09 盘整背驰](../theory-to-pseudocode/F07.md#f07-09-v2) | engineering | — | 盘整背驰需中枢及力度量化版本 |
| [F07.10 第一类买卖点](../theory-to-pseudocode/F07.md#f07-10-v2) | engineering | — | 一买有研究原语，完整因果回放待接入 |
| [F07.11 第二类买卖点](../theory-to-pseudocode/F07.md#f07-11-v2) | engineering | — | 二买有研究原语，完整因果回放待接入 |
| [F07.12 第三类买卖点](../theory-to-pseudocode/F07.md#f07-12-v2) | existing-proxy | `research-chan` | 已有原生逐前缀三买执行 |
| [F07.13 区间套](../theory-to-pseudocode/F07.md#f07-13-v2) | engineering | — | 跨级别数据与完成时钟需同步 |
| [F07.14 同级别分解](../theory-to-pseudocode/F07.md#f07-14-v2) | engineering | — | 同级分解定义及连接语义待固定 |
| [F07.15 小转大](../theory-to-pseudocode/F07.md#f07-15-v2) | engineering | — | 转折级别变化不能用后验端点回填 |
| [F08.01 供求法则](../theory-to-pseudocode/F08.md#f08-01-v2) | component | — | 解释或分析组件，必须另定义可证伪量价代理；不能单独作为完整策略 |
| [F08.02 因果法则](../theory-to-pseudocode/F08.md#f08-02-v2) | component | — | 解释或分析组件，必须另定义可证伪量价代理；不能单独作为完整策略 |
| [F08.03 努力与结果法则](../theory-to-pseudocode/F08.md#f08-03-v2) | component | — | 解释或分析组件，必须另定义可证伪量价代理；不能单独作为完整策略 |
| [F08.04 吸筹结构](../theory-to-pseudocode/F08.md#f08-04-v2) | engineering | — | 吸筹阶段可量化子事件，但完整阶段识别未接入 |
| [F08.05 派发结构](../theory-to-pseudocode/F08.md#f08-05-v2) | engineering | — | 派发阶段可用于退出，需确认状态机 |
| [F08.06 Spring 与测试](../theory-to-pseudocode/F08.md#f08-06-v2) | new-proxy | `theory-spring-confirm` | 新增Spring确认代理，不称完整吸筹体系；新增规则为独立日线本地代理，最终工程状态由目录绑定检查，不宣称原法复现 |
| [F08.07 UTAD 与上冲失败](../theory-to-pseudocode/F08.md#f08-07-v2) | component | — | 已实现上冲失败退出组件；缺人工派发证据不称完整UTAD，不产生空头入场 |
| [F08.08 SOS 与 SOW](../theory-to-pseudocode/F08.md#f08-08-v2) | existing-proxy | `research-wyckoff` | 已有SOS-JAC日线版本 |
| [F08.09 LPS 与 LPSY](../theory-to-pseudocode/F08.md#f08-09-v2) | new-proxy | `theory-sos-pullback` | 已实现SOS后确认缩量窄幅回撤再转强代理，保留确认延迟、失效及实际成交；非人工LPS/LPSY完整体系 |
| [F08.10 VSA](../theory-to-pseudocode/F08.md#f08-10-v2) | new-proxy | `theory-dryup-breakout` | 新增缩量整理放量突破代理，不代表完整VSA；新增规则为独立日线本地代理，最终工程状态由目录绑定检查，不宣称原法复现 |
| [F08.11 OBV](../theory-to-pseudocode/F08.md#f08-11-v2) | existing-proxy | `obv` | 已有OBV趋势基线 |
| [F08.12 MFI](../theory-to-pseudocode/F08.md#f08-12-v2) | existing-proxy | `mfi` | 已有MFI反转基线 |
| [F08.13 CMF](../theory-to-pseudocode/F08.md#f08-13-v2) | existing-proxy | `cmf` | 已有CMF趋势基线 |
| [F08.14 量价背离](../theory-to-pseudocode/F08.md#f08-14-v2) | new-proxy | `theory-obv-divergence` | 价格确认低点创新低而OBV抬高的颈线突破代理，不等同真实资金流；完整单向入退场已接入，不声明原法等价或有效收益 |
| [F08.15 Market Profile](../theory-to-pseudocode/F08.md#f08-15-v2) | data-gap | — | 日线不足以还原该卡所需会话/分价信息；已有分钟输入需先核验覆盖、单位和市场适配 |
| [F08.16 Volume Profile](../theory-to-pseudocode/F08.md#f08-16-v2) | data-gap | — | 日线不足以还原该卡所需会话/分价信息；已有分钟输入需先核验覆盖、单位和市场适配 |
| [F08.17 VWAP 价格参照](../theory-to-pseudocode/F08.md#f08-17-v2) | new-proxy | `theory-rolling-vwap-reclaim` | 20日滚动典型价量加权回踩代理；不是会话VWAP或执行算法，原会话内量价输入缺口仍保留；完整单向入退场已接入，不声明原法等价或有效收益 |
| [F08.18 AVWAP 价格锚点](../theory-to-pseudocode/F08.md#f08-18-v2) | new-proxy | `theory-month-anchor-reclaim` | 月初机械锚的日线典型价量加权回踩代理；逐笔AVWAP和其他人工锚分支数据/解释仍未齐；完整单向入退场已接入，不声明原法等价或有效收益 |
| [F08.19 Force Index](../theory-to-pseudocode/F08.md#f08-19-v2) | existing-proxy | `classic-force-index` | 已有Force Index基线 |
| [F08.20 NVI](../theory-to-pseudocode/F08.md#f08-20-v2) | existing-proxy | `classic-nvi` | 已有NVI基线 |
| [F09.01 CANSLIM](../theory-to-pseudocode/F09.md#f09-01-v2) | existing-proxy | `research-growth` | 已有98%高点价格代理，完整CANSLIM依赖历史财务与机构证据 |
| [F09.02 SEPA](../theory-to-pseudocode/F09.md#f09-02-v2) | component | — | 已实现SEPA平台价格趋势模板组件：MA50/150/200；319根日线形成120个MA200值，OLS斜率>0且末值>首值；显式52周窗口与平台相对强度；财务/催化剂/VCP 与完整策略未交付，NO_DIRECT_TRADE |
| [F09.03 VCP](../theory-to-pseudocode/F09.md#f09-03-v2) | new-proxy | `theory-vcp-close` | 两次已确认递减回撤、末端价量收紧和放量突破；完整单向入退场已接入，右侧确认滞后保留；本地代理不声明完整原法或有效收益 |
| [F09.04 O'Neil 杯柄与无柄杯](../theory-to-pseudocode/F09.md#f09-04-v2) | component | — | 已实现杯柄/无柄杯确认端点组件：调用方冻结已确认杯沿与柄部端点，突破须在全部结构确认后并使用 available-time 保护；原卡保护/退出规则保留，宿主仓位/风险/执行契约未绑定，不是完整策略，NO_DIRECT_TRADE |
| [F09.05 O'Neil 双底](../theory-to-pseudocode/F09.md#f09-05-v2) | component | — | 已实现双底确认端点组件：L2<L1、M 为枢轴，调用方冻结已确认两低与反弹高点，突破须在 L2 确认后并使用 available-time 保护；原卡保护/退出规则保留，宿主仓位/风险/执行契约未绑定，不是完整策略，NO_DIRECT_TRADE |
| [F09.06 O'Neil 平底与底上底](../theory-to-pseudocode/F09.md#f09-06-v2) | component | — | 已实现平底/底上底确认端点组件：调用方冻结已确认底部端点与首次突破高 P1，突破须在结构确认后并使用 available-time 保护；原卡量价/保护规则保留，宿主仓位/风险/执行契约未绑定，不是完整策略，NO_DIRECT_TRADE |
| [F09.07 O'Neil 升底与高紧旗](../theory-to-pseudocode/F09.md#f09-07-v2) | component | — | 已实现升底/高紧旗确认端点组件：调用方冻结三组已确认高低点或旗形端点，突破须在全部结构确认后并使用 available-time 保护；原卡保护/退出规则保留，宿主仓位/风险/执行契约未绑定，不是完整策略，NO_DIRECT_TRADE |
| [F09.08 O'Neil 市场方向](../theory-to-pseudocode/F09.md#f09-08-v2) | component | — | 已实现 O'Neil 市场方向组件：rally 尝试、跟进日确认与分布日计数仅用完成 bar，缺失窗口/成交量显式 UNKNOWN，并使用 available-time 保护；原卡风险降低规则保留，宿主仓位/风险/执行契约未绑定，不是完整策略，NO_DIRECT_TRADE |
| [F09.09 Darvas 箱体](../theory-to-pseudocode/F09.md#f09-09-v2) | new-proxy | `theory-darvas-close` | 逐步3根封顶/封底和MA120/成交量确认的本地代理；完整单向入退场已接入，右侧确认滞后保留；本地代理不声明完整原法或有效收益 |
| [F09.10 成长与机构领涨股](../theory-to-pseudocode/F09.md#f09-10-v2) | data-gap | — | 当时机构持仓/成长披露和历史领涨池未齐备 |
| [F10.01 时序动量](../theory-to-pseudocode/F10.md#f10-01-v2) | existing-proxy | `momentum120`、`momentum250`、`skip-momentum` | 已有120/250日时序动量，日数不等价原月度 |
| [F10.02 横截面动量](../theory-to-pseudocode/F10.md#f10-02-v2) | existing-proxy | `rank-momentum` | 复用跳过最近20根的动量排名；月末/总回报/并列保留旧仓规则不同，不能称原法等价 |
| [F10.03 绝对动量](../theory-to-pseudocode/F10.md#f10-03-v2) | component | — | 已实现绝对动量零现金比较组件：显式假设现金收益为0；不等同原法T-bill或同币种现金总回报，也不含组合权重/执行，NO_DIRECT_TRADE |
| [F10.04 相对动量](../theory-to-pseudocode/F10.md#f10-04-v2) | existing-proxy | `rank-momentum` | 复用跳过最近20根的动量排名；月末/总回报/并列保留旧仓规则不同，不能称原法等价 |
| [F10.05 双动量](../theory-to-pseudocode/F10.md#f10-05-v2) | data-gap | — | 缺少该卡要求的同币种现金/防御资产总回报或时点成员数据；OHLC代理需另命名 |
| [F10.06 RPS 与 RS](../theory-to-pseudocode/F10.md#f10-06-v2) | component | — | 现有RPS排名和组合预设可复用；排名本身不是买入策略 |
| [F10.07 行业轮动](../theory-to-pseudocode/F10.md#f10-07-v2) | engineering | — | 行业价格容易得，历史成员及可投资载体与轮动时点待补 |
| [F10.08 板块与主题轮动](../theory-to-pseudocode/F10.md#f10-08-v2) | data-gap | — | 板块/主题轮动缺少历史成员、主题首次可知时间和当时可投篮子；不能以当前概念成员回填历史 |
| [F10.09 动量崩溃](../theory-to-pseudocode/F10.md#f10-09-v2) | component | — | 动量崩溃为风险诊断，不是独立入场优势 |
| [F11.01 题材龙头](../theory-to-pseudocode/F11.md#f11-01-v2) | data-gap | — | 题材历史成员和当时龙头认定不可由最终涨幅回填 |
| [F11.02 趋势龙头](../theory-to-pseudocode/F11.md#f11-02-v2) | component | — | 已实现趋势龙头只做多筛选组件：仅限 CN 股票，读取前一完整交易日（asOf 可处当日早晨，使用 core completedBarFilter；冻结主题/基准不晚于 asOf），冻结成员池与基准并显式 L/n/m/k/q/d/a0 参数，池不缩不补缺；原卡候选取消规则保留（已知收盘破 MA_m 或连续 k 次相邻排名出局），仅输出 LEADER/KEEP/NONE/UNKNOWN 选择，不是完整策略、执行或业绩，NO_DIRECT_TRADE |
| [F11.03 连板龙头](../theory-to-pseudocode/F11.md#f11-03-v2) | data-gap | — | 需要每日连板梯队、真实涨跌停状态及成交能力 |
| [F11.04 首板](../theory-to-pseudocode/F11.md#f11-04-v2) | data-gap | — | 首板检测需当日有效涨停价、封板状态与可成交证据 |
| [F11.05 换手板](../theory-to-pseudocode/F11.md#f11-05-v2) | data-gap | — | 需换手自由流通股本时点口径与封板成交 |
| [F11.06 连板接力](../theory-to-pseudocode/F11.md#f11-06-v2) | data-gap | — | 接力需历史梯队、断板及次日受阻成交 |
| [F11.07 分歧转一致](../theory-to-pseudocode/F11.md#f11-07-v2) | data-gap | — | 分歧一致需历史板块成员和成交/封板状态 |
| [F11.08 弱转强](../theory-to-pseudocode/F11.md#f11-08-v2) | data-gap | — | 弱强定义可机械化，但次日可成交和首次可知证据待补 |
| [F11.09 龙头首阴](../theory-to-pseudocode/F11.md#f11-09-v2) | data-gap | — | 首阴需当时龙头而非事后赢家 |
| [F11.10 反包](../theory-to-pseudocode/F11.md#f11-10-v2) | component | — | 已实现全收盘确认的看跌反包参考组件：保留原冻结止损、实际成交、计划风险与 pending 状态；不是完整情绪体系或自动交易，NO_DIRECT_TRADE |
| [F11.11 龙头二波](../theory-to-pseudocode/F11.md#f11-11-v2) | data-gap | — | 二波需此前龙头和调整确认状态，不用最终二波定义 |
| [F11.12 补涨](../theory-to-pseudocode/F11.md#f11-12-v2) | data-gap | — | 补涨需当时同题材成员和先行关系 |
| [F11.13 卡位](../theory-to-pseudocode/F11.md#f11-13-v2) | data-gap | — | 卡位需并行候选和当时排序证据 |
| [F11.14 情绪周期](../theory-to-pseudocode/F11.md#f11-14-v2) | data-gap | — | 情绪状态有现有分析，但历史涨停梯队与版本不足以复现本卡 |
| [F11.15 集合竞价](../theory-to-pseudocode/F11.md#f11-15-v2) | data-gap | — | 需真实集合竞价报价/量和撤单时段，日线不可反推 |
| [F12.01 区间支撑阻力回归](../theory-to-pseudocode/F12.md#f12-01-v2) | new-proxy | `theory-range-reversion` | 已实现冻结区间、拒绝后确认、收盘保护/中点/时间退出，候选实际成交后消费 |
| [F12.02 布林带回归](../theory-to-pseudocode/F12.md#f12-02-v2) | new-proxy | `theory-boll-reentry` | 新增回带确认代理；不同于现有触下轨range；新增规则为独立日线本地代理，最终工程状态由目录绑定检查，不宣称原法复现 |
| [F12.03 RSI](../theory-to-pseudocode/F12.md#f12-03-v2) | existing-proxy | `rsi-trend`、`rsi-reversion` | 已有RSI趋势和反转基线 |
| [F12.04 KDJ](../theory-to-pseudocode/F12.md#f12-04-v2) | existing-proxy | `kdj` | 已有KDJ反转基线 |
| [F12.05 CCI](../theory-to-pseudocode/F12.md#f12-05-v2) | new-proxy | `cci`、`theory-cci-reclaim` | 已有CCI反转及新增重夺代理；新增规则为独立日线本地代理，最终工程状态由目录绑定检查，不宣称原法复现 |
| [F12.06 Williams %R](../theory-to-pseudocode/F12.md#f12-06-v2) | new-proxy | `williams`、`theory-williams-reclaim` | 已有Williams反转及新增重夺代理；新增规则为独立日线本地代理，最终工程状态由目录绑定检查，不宣称原法复现 |
| [F12.07 BIAS](../theory-to-pseudocode/F12.md#f12-07-v2) | new-proxy | `bias`、`theory-bias-reclaim` | 已有BIAS反转及新增重夺代理；新增规则为独立日线本地代理，最终工程状态由目录绑定检查，不宣称原法复现 |
| [F12.08 Z-score 回归](../theory-to-pseudocode/F12.md#f12-08-v2) | new-proxy | `theory-zscore-reentry` | 新增Z-score回归代理；新增规则为独立日线本地代理，最终工程状态由目录绑定检查，不宣称原法复现 |
| [F12.09 短期反转](../theory-to-pseudocode/F12.md#f12-09-v2) | existing-proxy | `short-reversal`、`rank-reversal` | 已有五日反转及横截面短反转 |
| [F12.10 趋势内回调交易](../theory-to-pseudocode/F12.md#f12-10-v2) | existing-proxy | `rsi2`、`pullback` | 已有RSI2趋势低吸和趋势回调 |
| [F12.11 固定网格](../theory-to-pseudocode/F12.md#f12-11-v2) | existing-proxy | `grid` | 现有 `grid` 策略为初始 80% 投入、±4% 锚点买卖 100 股的本地代理（成交股数 75% 作底仓），不是 v2 独立逐格批次；新增网格组件仅作额外证据，不表示旧策略已改或原法完整复现 |
| [F12.12 动态网格](../theory-to-pseudocode/F12.md#f12-12-v2) | component | — | 已实现显式固定/动态网格共用批次组件：只记录宿主实际成交；cancel-requested 在宿主确认前保留买入预留；旧批次保留原成本/目标/保护；成交价等距时按 LOW 选格；全部库存计入 Qmax，现金采用扣除网格预留前的 cashAvailableBeforeGridReservations；动态网格固定 K 重建，失败重建持久暂停新买（A 选择）。宿主执行、固定资金分配、单位与完成证明未绑定，不是完整策略；原动态网格仍 UNVERIFIED_SOURCE，NO_DIRECT_TRADE |
| [F12.13 Connors RSI](../theory-to-pseudocode/F12.md#f12-13-v2) | existing-proxy | `classic-connors-rsi` | 已有Connors RSI中点本地版 |
| [F12.14 IBS](../theory-to-pseudocode/F12.md#f12-14-v2) | existing-proxy | `classic-ibs` | 已有IBS中点本地版 |
| [F12.15 StochRSI](../theory-to-pseudocode/F12.md#f12-15-v2) | existing-proxy | `classic-stoch-rsi` | 已有StochRSI双线本地版 |
| [F13.01 Graham 价值投资与安全边际](../theory-to-pseudocode/F13.md#f13-01-v2) | engineering | — | 安全边际需估值假设和财报时点；现有E/P不等于Graham |
| [F13.02 Graham 净净值与清算价值](../theory-to-pseudocode/F13.md#f13-02-v2) | component | — | 已实现 Graham NCAV 算术、优先股分类与审计可回收性门槛纯组件；原 Graham 法仍为 UNVERIFIED_SOURCE，PIT 财务喂入包装待完成，NO_DIRECT_TRADE |
| [F13.03 Buffett 质量价值与护城河](../theory-to-pseudocode/F13.md#f13-03-v2) | interpretation | — | 仍依赖护城河、管理质量或成长持续性证据解释；已有财务代理不能认证原法 |
| [F13.04 Fisher 定性成长投资](../theory-to-pseudocode/F13.md#f13-04-v2) | interpretation | — | 仍依赖护城河、管理质量或成长持续性证据解释；已有财务代理不能认证原法 |
| [F13.05 Lynch 分类投资与 GARP](../theory-to-pseudocode/F13.md#f13-05-v2) | engineering | — | PEG/分类规则需盈利基期与增长假设，现有成长因子不等价 |
| [F13.06 红利与股东回报](../theory-to-pseudocode/F13.md#f13-06-v2) | data-gap | — | 需时点股息/回购/稀释总回报，不能以当前股息率回填 |
| [F13.07 规模因子](../theory-to-pseudocode/F13.md#f13-07-v2) | existing-proxy | `rank-small-cap` | 已有小市值排名 |
| [F13.08 低波动与低 Beta](../theory-to-pseudocode/F13.md#f13-08-v2) | existing-proxy | `rank-low-volatility`、`rank-low-beta` | 已有低波/低Beta只做多，不等同BAB多空 |
| [F13.09 质量因子](../theory-to-pseudocode/F13.md#f13-09-v2) | existing-proxy | `rank-quality` | 已有ROE质量排序，只是简化代理非QMJ全指标 |
| [F13.10 盈利能力因子](../theory-to-pseudocode/F13.md#f13-10-v2) | existing-proxy | `portfolio-gross-profitability` | 已有毛利/资产盈利能力组合 |
| [F13.11 投资与资产增长因子](../theory-to-pseudocode/F13.md#f13-11-v2) | existing-proxy | `portfolio-conservative-investment` | 已有保守资产增长组合 |
| [F13.12 Piotroski F-score](../theory-to-pseudocode/F13.md#f13-12-v2) | data-gap | — | 九项计算、分项证据与当前筛选已实现；离线财报支持多项，但未发行普通股事件证据不足，完整分数保持未知，不能从股本不变或缺事件倒推 |
| [F13.13 Greenblatt 魔法公式](../theory-to-pseudocode/F13.md#f13-13-v2) | component | — | 已实现EBIT/企业价值及EBIT/投入资本本地排序、年度目标与组合研究；本地四项债务/净固定资产口径独立说明，特殊生产资产不完整者未知，不冒充原法等价 |
| [F13.14 多因子组合](../theory-to-pseudocode/F13.md#f13-14-v2) | existing-proxy | `rank-quality-momentum`、`portfolio-profitability-value` | 已有质量动量和盈利价值本地组合，原多因子模型独立保留 |
| [F14.01 财报后漂移 PEAD](../theory-to-pseudocode/F14.md#f14-01-v2) | data-gap | — | PEAD需原始公告首次时间、当时预期和财务修订版本 |
| [F14.02 业绩预告、快报与盈利惊喜](../theory-to-pseudocode/F14.md#f14-02-v2) | data-gap | — | 预告/快报可免费获得，但完整时点覆盖与盈利惊喜分母待核验 |
| [F14.03 分析师预期修正](../theory-to-pseudocode/F14.md#f14-03-v2) | data-gap | — | 需历史分析师一致预期快照，不是今日预测 |
| [F14.04 公告驱动与回购事件](../theory-to-pseudocode/F14.md#f14-04-v2) | data-gap | — | 需原始增减持/回购公告与实施区别和时间戳 |
| [F14.05 分红公告与除息事件](../theory-to-pseudocode/F14.md#f14-05-v2) | data-gap | — | 需公告日期、除息日期和股息税可实现路径 |
| [F14.06 限售解禁与潜在供给](../theory-to-pseudocode/F14.md#f14-06-v2) | data-gap | — | 需解禁规模、首个公开时点和真实可售约束 |
| [F14.07 并购、重组与事件套利](../theory-to-pseudocode/F14.md#f14-07-v2) | data-gap | — | 并购事件需公告/撤销/条件更新完整事件链 |
| [F14.08 政策催化](../theory-to-pseudocode/F14.md#f14-08-v2) | interpretation | — | 政策/宏观到资产的方向因果仍需事前证据解释；可计算价格过滤不能代替解释 |
| [F14.09 新闻情绪与信息新颖性](../theory-to-pseudocode/F14.md#f14-09-v2) | data-gap | — | 新闻文本可用，但历史首次发布、去重与评分版本待冻结 |
| [F14.10 指数纳入、剔除与调仓](../theory-to-pseudocode/F14.md#f14-10-v2) | data-gap | — | 需官方历史旧新权重和跟踪规模，当前成分不够 |
| [F14.11 季节性、月末与日历效应](../theory-to-pseudocode/F14.md#f14-11-v2) | existing-proxy | `seasonal` | 已有11-4月季节性代理；原卡月末窗口需交易日历和新规则 |
| [F14.12 经济周期与信用周期](../theory-to-pseudocode/F14.md#f14-12-v2) | data-gap | — | 需宏观首次发布版本，今日修订值不可回填 |
| [F14.13 宏观趋势与全球宏观](../theory-to-pseudocode/F14.md#f14-13-v2) | interpretation | — | 政策/宏观到资产的方向因果仍需事前证据解释；可计算价格过滤不能代替解释 |
| [F14.14 战略与战术资产配置](../theory-to-pseudocode/F14.md#f14-14-v2) | component | — | 配置为组件，需用户目标权重和授权资产集合 |
| [F14.15 全天候配置](../theory-to-pseudocode/F14.md#f14-15-v2) | data-gap | — | 全球资产广度超出现有沪深及BTC/ETH现货范围 |
| [F15.01 配对交易与距离价差](../theory-to-pseudocode/F15.md#f15-01-v2) | data-gap | — | 价格对可得，但原配对需要双腿空头/借券和共享执行 |
| [F15.02 协整价差](../theory-to-pseudocode/F15.md#f15-02-v2) | data-gap | — | 协整可估计，仍需双腿空头、稳定窗口及执行成本 |
| [F15.03 因子残差均值回归](../theory-to-pseudocode/F15.md#f15-03-v2) | data-gap | — | 需历史截面因子和残差双腿可交易性 |
| [F15.04 市场中性与风险中性化](../theory-to-pseudocode/F15.md#f15-04-v2) | data-gap | — | 需借券和实时风险暴露对冲，现货只做多不等价 |
| [F15.05 横截面多空与价差组合](../theory-to-pseudocode/F15.md#f15-05-v2) | data-gap | — | 多空组合缺历史借券可得/费用与双腿执行 |
| [F15.06 ETF 折溢价与申赎套利](../theory-to-pseudocode/F15.md#f15-06-v2) | data-gap | — | 需实时IOPV、PCF、申赎资格和最小单位 |
| [F15.07 期现套利](../theory-to-pseudocode/F15.md#f15-07-v2) | data-gap | — | 需期货/现货和交割、保证金执行，超出现货范围 |
| [F15.08 跨期价差](../theory-to-pseudocode/F15.md#f15-08-v2) | data-gap | — | 需同品种历史合约/展期和保证金 |
| [F15.09 可转债相对价值](../theory-to-pseudocode/F15.md#f15-09-v2) | data-gap | — | 需转债条款、正股、借券及违约/赎回事件 |
| [F16.01 利差与外汇 carry](../theory-to-pseudocode/F16.md#f16-01-v2) | data-gap | — | 需外汇利率/融资和可执行双腿，非现货价格即可 |
| [F16.02 展期收益与期限结构 carry](../theory-to-pseudocode/F16.md#f16-02-v2) | data-gap | — | 需历史合约期限结构、交割与换月成本 |
| [F16.03 基差 carry](../theory-to-pseudocode/F16.md#f16-03-v2) | data-gap | — | 需同标的期现及融资/保证金 |
| [F16.04 永续合约资金费率 carry](../theory-to-pseudocode/F16.md#f16-04-v2) | data-gap | — | 需永续资金费率和合约执行，BTC/ETH现货不等同 |
| [F16.05 隐含波动率与实现波动率比较](../theory-to-pseudocode/F16.md#f16-05-v2) | data-gap | — | 需可交易期权链/隐波和同步实现波动 |
| [F16.06 波动率风险溢价](../theory-to-pseudocode/F16.md#f16-06-v2) | data-gap | — | 需期权卖方保证金、尾部和实际成交 |
| [F16.07 期权组合与非线性收益结构](../theory-to-pseudocode/F16.md#f16-07-v2) | data-gap | — | 需合约条款、Greeks、到期/指派和多腿报价 |
| [F16.08 Delta 对冲](../theory-to-pseudocode/F16.md#f16-08-v2) | data-gap | — | 需期权与标的同步报价及动态对冲成本 |
| [F16.09 订单流](../theory-to-pseudocode/F16.md#f16-09-v2) | data-gap | — | 需逐笔主动买卖方向，日线量不能伪造 |
| [F16.10 订单簿失衡与队列](../theory-to-pseudocode/F16.md#f16-10-v2) | data-gap | — | 需完整盘口与订单队列事件，日线无法推导 |
| [F16.11 做市与库存控制](../theory-to-pseudocode/F16.md#f16-11-v2) | data-gap | — | 需盘口/队列、撤单/延迟和库存账户 |
| [F16.12 VWAP 执行](../theory-to-pseudocode/F16.md#f16-12-v2) | component | — | 执行算法不单独产生收益信号；历史细周期输入和执行反馈尚待接入，禁止自动真实下单 |
| [F16.13 TWAP 执行](../theory-to-pseudocode/F16.md#f16-13-v2) | component | — | 执行算法不单独产生收益信号；历史细周期输入和执行反馈尚待接入，禁止自动真实下单 |
| [F16.14 POV 参与率执行](../theory-to-pseudocode/F16.md#f16-14-v2) | component | — | 执行算法不单独产生收益信号；历史细周期输入和执行反馈尚待接入，禁止自动真实下单 |
| [F17.01 固定金额仓位](../theory-to-pseudocode/F17.md#f17-01-v2) | component | — | 固定每笔金额为仓位组件；当前策略对象支持权重/风险/等份，并无固定金额独立配置，需补预算边界而非冒称已有 |
| [F17.02 固定权益比例仓位](../theory-to-pseudocode/F17.md#f17-02-v2) | component | — | 固定权重/金额属于仓位政策，复用现有对象 |
| [F17.03 固定单笔风险](../theory-to-pseudocode/F17.md#f17-03-v2) | component | — | 固定分数风险需已知止损距离和真实数量约束 |
| [F17.04 波动率目标](../theory-to-pseudocode/F17.md#f17-04-v2) | existing-proxy | `vol-target` | 已有目标波动本地版，日线年化口径需分市场 |
| [F17.05 Kelly 与分数 Kelly](../theory-to-pseudocode/F17.md#f17-05-v2) | component | — | Kelly需实测分布与估计误差，不由胜率假设自动分配 |
| [F17.06 金字塔、反金字塔与分层加仓](../theory-to-pseudocode/F17.md#f17-06-v2) | component | — | ATR保护、分批和移动止损复用已有保护/风险服务 |
| [F17.07 马丁与反马丁](../theory-to-pseudocode/F17.md#f17-07-v2) | component | — | 马丁有限资金风险研究，不作为优先alpha或无限加仓实现 |
| [F17.08 分批投入与定期定额 DCA](../theory-to-pseudocode/F17.md#f17-08-v2) | existing-proxy | `dca` | 已有12个月分批代理，不含外部入金 |
| [F17.09 价值平均](../theory-to-pseudocode/F17.md#f17-09-v2) | component | — | 价值平均需目标资产轨迹和外部现金边界，未实现 |
| [F17.10 再平衡与恒定权重](../theory-to-pseudocode/F17.md#f17-10-v2) | existing-proxy | `constant-mix` | 已有恒定比例本地版 |
| [F17.11 均值方差配置](../theory-to-pseudocode/F17.md#f17-11-v2) | component | — | 均值方差需预期收益估计与协方差求解，不等同反波动 |
| [F17.12 风险平价](../theory-to-pseudocode/F17.md#f17-12-v2) | existing-proxy | `allocation-risk-parity` | 已有协方差风险平价，不等同反波动 |
| [F17.13 CPPI 组合保险](../theory-to-pseudocode/F17.md#f17-13-v2) | existing-proxy | `cppi` | 已有固定底线CPPI，无保本承诺 |
| [F17.14 回撤控制与风险预算停机](../theory-to-pseudocode/F17.md#f17-14-v2) | component | — | 已有回撤刹车与风险预算组件 |
| [F17.15 交易心理、纪律与决策日志](../theory-to-pseudocode/F17.md#f17-15-v2) | component | — | 已有复盘/日志流程，非独立策略 |
| [F18.01 线性模型与正则化](../theory-to-pseudocode/F18.md#f18-01-v2) | engineering | — | OHLCV特征和已完成标签可得，需正则化求解/训练和时间隔离接入 |
| [F18.02 树模型](../theory-to-pseudocode/F18.md#f18-02-v2) | engineering | — | OHLCV可得，需固定树分裂、最小叶和训练时点 |
| [F18.03 集成学习](../theory-to-pseudocode/F18.md#f18-03-v2) | engineering | — | 需先实现基础学习器及过去训练产生的预测，不能在测试集调集成 |
| [F18.04 状态切换与 HMM](../theory-to-pseudocode/F18.md#f18-04-v2) | engineering | — | OHLCV可得，需HMM拟合和状态到策略映射冻结 |
| [F18.05 元标签与二级交易过滤](../theory-to-pseudocode/F18.md#f18-05-v2) | engineering | — | 需已有基础策略真实事件标签及交叠清除 |
| [F18.06 机器学习排序](../theory-to-pseudocode/F18.md#f18-06-v2) | engineering | — | 需截面时点特征与排序标签，不能随机拆分 |
| [F18.07 深度学习](../theory-to-pseudocode/F18.md#f18-07-v2) | engineering | — | 需训练依赖、架构和样本量；不手写替代训练框架 |
| [F18.08 强化学习](../theory-to-pseudocode/F18.md#f18-08-v2) | engineering | — | 需可复现环境/奖励和训练协议，历史收益最大化不等于有效 |
| [F18.09 混合策略与环境切换](../theory-to-pseudocode/F18.md#f18-09-v2) | component | — | 已实现 `composeLongOnlyStrategies` 只做多组合组件：使用实际已知子目标/实际贡献与可追踪退出；非法或未知的新权重不会吞掉已知旧退出；缺失现金/权重返回 UNKNOWN 而不填 0；显式单品种上限 c 与总敞口上限 G。宿主完整策略与业绩未绑定，NO_DIRECT_TRADE |
