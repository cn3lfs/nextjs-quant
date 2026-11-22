# 五标的回测诊断协议

本批检验数据、信号、订单、成交、费用和账本能否逐项对上。验收依据为逐笔字段核对、独立手算和账本守恒，不设哈希或黄金结果门槛。样本和运行范围见[五标的选样记录](2026-11-22-five-symbol-selection.md)。

## 标准流程

| 步骤 | 执行口径 |
| --- | --- |
| 策略定义 | 运行前写明证券池、频率、入场与退出、预热、仓位、风控、对照和观察窗口。 |
| 数据准备 | 按决策时点取当时已知的数据（PIT），保留财务披露时间、历史成分及退市记录。记录数据截止日、缺口和公司行动，分开使用复权信号价与未复权成交价。 |
| 信号与执行 | 常规入场与退出信号在日 K 线收盘后确认，最早可在下一交易日开盘成交。按 T+1、停牌、涨跌停和一字板规则处理受阻订单，计入滑点和费用。模拟成交价须处于当日高低价及有效涨跌停区间内。 |
| 绩效与归因 | 从成交、现金、持仓和期末估值重建权益，核对日收益、回撤和换手，区分信号、拒单、费用和公司行动的影响。持有对照用于检查账本与公司行动。 |
| 验证 | 先检查截断后历史信号是否一致、逐笔费用和账本是否闭合，再做按时间切分的样本外验证（OOS）、滚动前推（walk-forward）及成本、滑点和执行延迟压力测试。首批固定参数，只做流程诊断。 |

保护性退出（止损、止盈目标、跟踪止损）走独立的订单路径。引擎用已完成日 K 线的高低价判断当根 K 线内是否触及预设触发价，以触发价作为当根模拟撮合的基准价，若开盘已跳过触发价则以开盘价为基准。诊断单独统计此类成交，排除在常规信号当日成交违规项之外。同根 K 线撮合仅为研究情景，日线数据无法验证盘中可成交价格或委托排队优先级。[引擎实现](../../packages/quant-backtest/src/portfolio/close-signals.ts)

## 六类常见偏差

| 偏差 | 检查办法 |
| --- | --- |
| 未来信息 | 按可见时点取数，截断未来行情后复算历史信号，核对信号日和成交日。 |
| 幸存者偏差 | 用历史成分和退市样本重建证券池，缺失时披露现存样本偏差。 |
| 过拟合与数据窥探 | 记录尝试过的规则和参数，保留未参与选参的样本外窗口。 |
| 低估交易成本 | 逐笔核对税费和滑点，单独披露容量与冲击成本的证据缺口。 |
| 挑选有利区间 | 提前固定全程窗口和分段，报告不同市场阶段的表现。 |
| 公司行动与复权错位 | 按日期核对原始价、信号价、股数和现金，避免未来除权重标信号或重复计入分红。 |

## A 股日线撮合与成本

| 项目 | 规则 |
| --- | --- |
| 交收与停牌 | 股票实行 T+1，当日买入的股份下一交易日方可卖出。停牌期间不可成交。 |
| 涨跌幅 | 常规竞价主板 10%、创业板和科创板 20%、北交所 30%。创业板自 2020-08-24 起切换至 20%。沪深主板 ST、*ST 历史常规口径为 5%，自 2026-07-06 起调整为 10%。上市初期等例外按板块和日期核对。[深交所创业板规则](https://www.szse.cn/aboutus/trends/news/t20200821_580924.html)、[上交所交易规则](https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/exchange/c/c_20260424_10816482.shtml)、[北交所交易规则](https://www.bse.cn/jygl_list/200028217.html)、[沪深主板 ST 调整](https://www.csrc.gov.cn/shanghai/c105566/c7643909/content.shtml) |
| 申报数量 | 沪深主板和创业板买入按 100 股整数倍，科创板买入 200 股起，北交所竞价买入 100 股起。卖出可含零股，低于适用起点的余额一次卖出。 |
| 税费 | 印花税自 2023-08-28 起按成交额的 0.05% 向卖方收取，紧邻此前口径为卖方 0.1%。股票过户费自 2022-04-29 起双边各 0.001%。A 股佣金费率上限为 0.3%，每笔最低 5 元。全历史费率按日期和适用规则核对。[印花税公告](https://shanghai.chinatax.gov.cn/tax/zcfw/zcfgk/yhs/202308/t468451.html)、[过户费调整](https://jrj.wuhan.gov.cn/ynzx_57/xwzx/202204/t20220429_1964160.shtml)、[证监会佣金规定](https://www.csrc.gov.cn/csrc/c100024/c1492350/1492350/files/928bdd362fa24b79bdadb0072d67acee.pdf) |

## 仓库对应路径

| 入口 | 职责与诊断口径 |
| --- | --- |
| [`prepareLabBacktest`](../../src/server/research/lab-backtest.ts) | 冻结明确的标的名单，装载原价、信号价、公司行动、逐日执行条件和费用。现有入口按策略选择价格口径，并拒绝形成中或曾修复的行情。 |
| [`causalResearchPrices`](../../src/server/research/causal-price-basis.ts) | 以首根原始价为锚，按公司行动生效日向后调整信号价。诊断用前缀截断复算检查未来数据是否影响既有信号。 |
| [`researchCorporateActions`、`researchExecutionEvidence`](../../src/server/research/corporate-actions.ts) | 将 GBBQ 映射为除权日研究情景，按板块、日期和除权参考价推算逐日交易限制。仓库现有规则对有当日证据的主板 ST 套用 5% 研究情景，未编码 2026 年切换。[板块研究规则](../../packages/trading-strategy-core/src/market-rules.ts) |
| [`quant-backtest` 的 `runPortfolio`](../../packages/quant-backtest/src/portfolio/run.ts) | 按事件顺序在共享现金下模拟订单、成交和拒单，由成交更新持仓与现金并形成权益曲线。 |
| [`quant-performance`](../../packages/quant-performance/README.md) | 从冻结结果独立计算日收益、回撤和分期报告，评价与撮合相互独立。 |

本批缺少历史证券池、逐日 ST、IPO 特殊限制及盘口排队证据。GBBQ 是事后文件，派息到账日和送转股份上市日未核实，统一按除权日入账与可卖的研究情景处理。引擎用成交量判断能否参与模拟，未建模成交容量、参与率或市场冲击。运行数据只读，任何可能打开数据库的验证均先设置隔离 `QUANT_DATA_DIR`。[数据来源](../data-sources.md)、[运行隔离](../operations.md)、[仓库约束](../invariants.md)

## 外部参考

- 策略定义、历史模拟和验证流程。[Numerix 白皮书](https://www.numerix.com/resources/white-paper/testing-strategy-how-backtesting-shapes-systematic-fixed-income-performance)、[Algo Lab《量化回测完整指南》](https://algolabhk.com/zh-TW/blogs/quant-backtesting-complete)
- 回测偏差与评价方法。[Daniel P. Palomar《Portfolio Optimization》第 8 章课件](https://portfoliooptimizationbook.com/slides/slides-backtesting.pdf)
- 回测平台的撮合、交易限制和费用配置。[RQAlpha Plus 参数配置](https://www.ricequant.com/doc/rqalpha-plus/api/config)、[同花顺 SuperMind 回测引擎](https://quant.10jqka.com.cn/view/help/12?from=ifind)
- 向量式回测与按信号、订单、成交推进的事件式回测。[Interactive Brokers 文章](https://www.interactivebrokers.com/campus/ibkr-quant-news/a-practical-breakdown-of-vector-based-vs-event-based-backtesting/)
