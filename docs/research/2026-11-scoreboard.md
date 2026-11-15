# 2026-11 R2a-4 策略研究成绩单

晋级 0 项。已完成引擎核账、主口径重跑、旧对照重评、终止覆盖敏感性和真实共享账户组合。统计全族共 369 个实际试验，统一DSR，不按市场或口径拆分。未登记任何新的live候选。提醒live模式未开启，真实通知/交易均为0。

这是带高偏差的规则研究，不是可信可投资业绩。当前成分、历史执行、公司行动/财务版本与历史交易所过滤器均有未认证部分；正收益和程序测试不能消除这些缺口。

## 口径与来源

A股800成分来自只读的 「E:\new_tdx64\T0002\hq_cache\infoharbor_block.dat」，观察时间 2026-11-15T05:32:18.877Z；正式快照生效日未知。源SHA256 「4bdb2384d2b54852cd51b0518f0d8bfdfe5567d4289cfa860da17422a31959d1」，排序名单SHA256 「47f11f7539f50002dd2a4a4cdcabfa10ab2c28cc7f5e7d15f94f14091047f321」。800只中258只通过冻结的执行审查，542只（541只非现金公司行动、1只sz000831尾部行情覆盖异常）的逐项理由见 .test-data/r2a4/csi800.json。这是中证800可执行子集，覆盖不足不可忽略。基准000906：2007-01-15—2026-11-13，4815根，hash 「2a3c92e4aef37c4e5e9f41393e84fdead4b1f8ce4bd3bfa93599431dd4624419」。RPS仍为5564只冻结全市场横截面。

主口径使用2025-06起留出段作为主要参考；中证800实际首交易日2025-06-03，数字货币2025-06-01。high `current-constituents-lookahead`始终保留：越早窗口前视偏差越严重，留出也不是无偏。全市场1638只和20币对沿用R2a-3窗口（A股留出2023-06-29起；20币对按原2020年起区间），不得把不同窗口差值当作纯换池效果。

数字货币主口径BTC/ETH从最早官方归档开始，五周期分别使用原生文件；研究截止UTC2026-11-14 00:00，下载官方日文件截至2026-11-13。分钟/小时bar按结束时刻标记并按此切窗（日线沿用官方开盘日），因此末尾可能显示11-14 00:00；这是11-13最后一根已完成bar，不是读取11-14未来行情。基准从窗内首根观测bar的开盘价建仓；分钟/小时周期的这个开盘可能在名义日期边界之前一个原生周期，不能把它当作日线窗口的完全相同时刻。基准BTC持有；每个窗口重新按初始本金50/50买入BTC/ETH的基准并列列出，基准不收费。

官方ZIP和CHECKSUM根目录：「D:\github\nextjs-quant\.test-data\r2a4\data\market-data\binance-public-data」。合计 139.4 MiB，高于最初几十MB估计。归档是持久原始输入，不随BarStore缓存清理。manifest记录真缺口和隔离异常时间行；没有插值。

| 品种/原生周期 | 起止（结束标记） | bar数 | ZIP数 | 缺口处数 | MiB |
|---|---|---:|---:|---:|---:|
| BTCUSDT/1d | 2017-08-17—2026-11-13 | 3376 | 124 | 0 | 0.2 |
| BTCUSDT/4h | 2017-08-17T08:00:00+00:00—2026-11-14T00:00:00+00:00 | 20219 | 124 | 20 | 1.2 |
| BTCUSDT/1h | 2017-08-17T05:00:00+00:00—2026-11-14T00:00:00+00:00 | 80836 | 124 | 31 | 4.6 |
| BTCUSDT/15m | 2017-08-17T04:15:00+00:00—2026-11-14T00:00:00+00:00 | 323422 | 124 | 32 | 17.2 |
| BTCUSDT/5m | 2017-08-17T04:05:00+00:00—2026-11-14T00:00:00+00:00 | 970280 | 124 | 33 | 48.7 |
| ETHUSDT/1d | 2017-08-17—2026-11-13 | 3376 | 124 | 0 | 0.2 |
| ETHUSDT/4h | 2017-08-17T08:00:00+00:00—2026-11-14T00:00:00+00:00 | 20219 | 124 | 20 | 1.2 |
| ETHUSDT/1h | 2017-08-17T05:00:00+00:00—2026-11-14T00:00:00+00:00 | 80836 | 124 | 31 | 4.3 |
| ETHUSDT/15m | 2017-08-17T04:15:00+00:00—2026-11-14T00:00:00+00:00 | 323422 | 124 | 32 | 16.1 |
| ETHUSDT/5m | 2017-08-17T04:05:00+00:00—2026-11-14T00:00:00+00:00 | 970280 | 124 | 33 | 45.6 |

应用设置→数据与连接提供保存目录、可选1m和“回填/补齐 BTC、ETH 历史”按钮，任务中心显示进度和取消。启动只读索引并提示；已有历史时图表读取才按已完成bar补最近REST尾部，禁止隐式历史大批下载。官方替换先验证live一致，冲突保留。全部真实下载仅在本任务隔离目录，生产目录由用户自行触发。

## 执行核查与差异解释

A股双突破ATR1006笔、时间止损1128笔，20币对15m共17368笔，分别独立重算原始bar价格、次bar开盘、固定/ATR保护、跳空、取整、费用和现金；每组20个展示样本（各至少10笔买与卖）差异为0。原8只低位共76笔，展示20笔含5笔追加档位，价格、复权、份额/分批差异为0。T+1、一字/涨跌停、缺行情、无效保护、共享资金拒单和零值估值另有固定输入控制。逐笔证据及每个拒单的分类在engine-audit与gzip审计产物；没有把非零拒单说成实现缺陷。

与`cc934c7`的8只证券、原窗口2017-01-03—2026-11-13，9个双突破含邻域候选在训练、各滚动窗及留出全部数值一致（0差异）。原留出实际2024-11-22起，时间变体绝对+9.285%、原始超额+8.481%；不是同一个2023-06-29起全市场留出。全市场时间变体绝对−42.662%、原始超额−47.342%。证券池由8到1638、共用现金下入场竞争及窗口同时改变，不能把两结果相减归因为一个因素。双突破不读RPS，因此横截面变化不是该项差异来源；参数未改，8只原数据/原执行路径精确复现，审计的全市场原留出也与冻结成绩一致，未发现需要修正的引擎缺陷。

| 原8只变体 | 原留出起日 | 绝对收益 | 原始超额 | 重放数值差异 |
|---|---|---:|---:|---:|
| r2a-cn-equity-double-breakout-atr | 2024-11-22 | 2.75% | 1.95% | 0 |
| r2a-cn-equity-double-breakout-atr-neighbor-90 | 2024-11-22 | 4.11% | 3.30% | 0 |
| r2a-cn-equity-double-breakout-atr-neighbor-110 | 2024-11-22 | 1.95% | 1.14% | 0 |
| r2a-cn-equity-double-breakout-trailing | 2024-11-22 | 1.17% | 0.36% | 0 |
| r2a-cn-equity-double-breakout-trailing-neighbor-90 | 2024-11-22 | 2.97% | 2.17% | 0 |
| r2a-cn-equity-double-breakout-trailing-neighbor-110 | 2024-11-22 | -0.30% | -1.10% | 0 |
| r2a-cn-equity-double-breakout-time | 2024-11-22 | 9.29% | 8.48% | 0 |
| r2a-cn-equity-double-breakout-time-neighbor-90 | 2024-11-22 | 6.34% | 5.54% | 0 |
| r2a-cn-equity-double-breakout-time-neighbor-110 | 2024-11-22 | 9.89% | 9.09% | 0 |

下表是固定实际成交路径的现金归因，不是零费用重新下单的反事实回测。毛收益含末期未实现浮盈亏；净额=毛收益−手续费−滑点，独立核账剩余误差见delivery。20币对的毛收益本身为正，但费用和滑点合计超过毛收益；这证明该路径的换手成本足以造成巨亏，不能据此证明无成本策略可投资。BTC/ETH按同一方法复核。

| 15m ATR留出 | 毛损益 | 手续费 | 滑点 | 净损益 |
|---|---:|---:|---:|---:|
| prior20Pairs | 610915.43 | 1071871.29 | 535935.80 | -996891.66 |
| btcEth | 418979.42 | 767280.52 | 383640.36 | -731941.47 |

拒单 prior20Pairs（尝试次数，重复重试可大于信号数）：
- 滑点成交价超出可观察价格范围：9417
- sleeve持仓上限：12628
- 一字行情，保守不成交：174
- 停牌或缺少可交易行情：41
- 缺失或无效初始止损：3

拒单 btcEth（尝试次数，重复重试可大于信号数）：
- 滑点成交价超出可观察价格范围：1547

## 低位检测与收益贡献

当前检测器与冻结沪深300全部5309行完全一致。指数数据2005起，2008没有最低5年预热。2012–2014价格分位最低25.352%、2016最低55.674%、2018–2019最低42.869%，都没有达到既定20%低位阈值；2019-01-03回撤虽达−44.621%，也不能替代价格分位条件。原R2a提及2008、2018的是个股示例，其沪深300指数同样只有2024-01-17—09-30一轮；没有为了凑周期修改阈值。

收益很高不等于指数周期证据充分。以下按原连续账户的每日净值损益在唯一指数低位周期内/外归属，含期间持仓和个股触发，二者严格相加；这不是把周期内独立复利收益与周期外收益相加。原冻结ATR全期实际为+1504.46%；派单中的243–329%对应inSample训练段（9变体实际范围243.47%—329.20%），不是连续全期。ATR/移动/时间三基础变体的训练收益分别313.55%、274.77%、243.47%；连续全期分别1504.46%、1124.92%、1833.56%。

| 全市场低位变体 | 全期收益 | 指数周期内损益 | 周期外损益 | 合计损益 |
|---|---:|---:|---:|---:|
| r2a-cn-equity-historical-low-atr | 1504.46% | 1643624.09 | 13401020.16 | 15044644.25 |
| r2a-cn-equity-historical-low-atr-neighbor-90 | 1179.22% | 247174.03 | 11545045.01 | 11792219.04 |
| r2a-cn-equity-historical-low-atr-neighbor-110 | 1443.24% | -710734.92 | 15143124.96 | 14432390.04 |
| r2a-cn-equity-historical-low-trailing | 1124.92% | -174290.08 | 11423445.56 | 11249155.48 |
| r2a-cn-equity-historical-low-trailing-neighbor-90 | 1161.59% | 26521.17 | 11589361.99 | 11615883.17 |
| r2a-cn-equity-historical-low-trailing-neighbor-110 | 1659.87% | 243850.30 | 16354878.59 | 16598728.88 |
| r2a-cn-equity-historical-low-time | 1833.56% | -164638.16 | 18500221.30 | 18335583.14 |
| r2a-cn-equity-historical-low-time-neighbor-90 | 1637.73% | 541802.48 | 15835539.25 | 16377341.73 |
| r2a-cn-equity-historical-low-time-neighbor-110 | 1123.52% | -42501.88 | 11277666.90 | 11235165.02 |

低位一律保留“不足3完整指数周期”和“历史温度/财务版本置信度不足”阻断，个股很多次触发不能冒充多个独立市场周期。337只恢复证券若缺少冻结PIT估值，保持缺失/价量观察，不补造估值；敏感性结果仍有输入置信度限制。

换为中证800指数后，同一阈值识别2个完整周期：2012-01-16—2014-11-25；2023-12-15—2024-09-30。该指数从2007-01-15起，与沪深300从2005起的历史分位分布不同，2012年是否触发随输入而异，不是调整阈值。下表是每个周期独立本金的真实执行，另列两项压力；日历滚动窗仍并列展示，不能把6个滚动窗当作6个独立市场周期。

| 主口径低位变体/指数周期 | 扣费收益/原始超额/夏普差 | 成本×2收益/夏普差 | 延迟收益/夏普差 | 闭合交易/回撤 |
|---|---|---|---|---|
| r2a-cn-equity-historical-low-atr/2012-01-16—2014-11-25 | 53.25% / 29.14% / 0.396 | 52.87% / 0.388 | 51.40% / 0.374 | 24 / 29.03% |
| r2a-cn-equity-historical-low-atr/2023-12-15—2024-09-30 | 36.41% / 21.16% / 0.738 | 35.57% / 0.706 | 36.31% / 0.717 | 19 / 12.82% |
| r2a-cn-equity-historical-low-atr-neighbor-90/2012-01-16—2014-11-25 | 57.36% / 33.25% / 0.451 | 54.10% / 0.425 | 49.02% / 0.362 | 28 / 28.00% |
| r2a-cn-equity-historical-low-atr-neighbor-90/2023-12-15—2024-09-30 | 24.94% / 9.69% / 0.394 | 24.86% / 0.370 | 22.89% / 0.272 | 23 / 14.02% |
| r2a-cn-equity-historical-low-atr-neighbor-110/2012-01-16—2014-11-25 | 38.23% / 14.12% / 0.227 | 41.88% / 0.270 | 49.60% / 0.361 | 21 / 26.14% |
| r2a-cn-equity-historical-low-atr-neighbor-110/2023-12-15—2024-09-30 | 31.68% / 16.42% / 0.556 | 33.69% / 0.633 | 38.97% / 0.818 | 18 / 12.83% |
| r2a-cn-equity-historical-low-trailing/2012-01-16—2014-11-25 | 43.48% / 19.37% / 0.274 | 41.86% / 0.252 | 11.81% / -0.194 | 32 / 28.81% |
| r2a-cn-equity-historical-low-trailing/2023-12-15—2024-09-30 | 43.54% / 28.29% / 1.026 | 42.80% / 0.995 | 44.66% / 1.002 | 15 / 12.19% |
| r2a-cn-equity-historical-low-trailing-neighbor-90/2012-01-16—2014-11-25 | 54.04% / 29.94% / 0.430 | 38.89% / 0.216 | 28.63% / 0.095 | 31 / 29.25% |
| r2a-cn-equity-historical-low-trailing-neighbor-90/2023-12-15—2024-09-30 | 32.10% / 16.84% / 0.611 | 31.38% / 0.583 | 42.23% / 0.895 | 15 / 13.09% |
| r2a-cn-equity-historical-low-trailing-neighbor-110/2012-01-16—2014-11-25 | 42.98% / 18.87% / 0.283 | 42.92% / 0.281 | 38.23% / 0.230 | 25 / 28.95% |
| r2a-cn-equity-historical-low-trailing-neighbor-110/2023-12-15—2024-09-30 | 48.91% / 33.66% / 1.096 | 49.12% / 1.092 | 50.67% / 1.088 | 12 / 12.19% |
| r2a-cn-equity-historical-low-time/2012-01-16—2014-11-25 | 41.83% / 17.72% / 0.275 | 55.87% / 0.434 | 49.74% / 0.371 | 16 / 28.60% |
| r2a-cn-equity-historical-low-time/2023-12-15—2024-09-30 | 47.36% / 32.11% / 1.068 | 46.70% / 1.044 | 49.12% / 1.062 | 11 / 12.19% |
| r2a-cn-equity-historical-low-time-neighbor-90/2012-01-16—2014-11-25 | 41.63% / 17.53% / 0.272 | 55.67% / 0.431 | 49.74% / 0.371 | 17 / 28.60% |
| r2a-cn-equity-historical-low-time-neighbor-90/2023-12-15—2024-09-30 | 47.36% / 32.11% / 1.068 | 46.70% / 1.044 | 49.12% / 1.062 | 11 / 12.19% |
| r2a-cn-equity-historical-low-time-neighbor-110/2012-01-16—2014-11-25 | 41.83% / 17.72% / 0.275 | 55.87% / 0.434 | 49.74% / 0.371 | 16 / 28.60% |
| r2a-cn-equity-historical-low-time-neighbor-110/2023-12-15—2024-09-30 | 47.36% / 32.11% / 1.068 | 46.70% / 1.044 | 49.12% / 1.062 | 11 / 12.19% |

## 新旧门槛

新口径：多数OOS窗口夏普差>0且扣费绝对收益>0，留出同样满足；成本×2和延迟1根分别满足多数OOS及留出，二者不要求是同一组正窗口。旧口径保留原始超额>0（原压力正窗使用二者同时通过的交集）。回撤≤25%、闭合交易≥30、OOS≥3、正窗≥60%、邻域≥50%、DSR≥0.95不变；低位另须≥3完整周期及可靠输入。邻域仍按冻结训练段原始超额>0判定，不借新门槛调整参数。

全族试验 369 项：主/对照所有变体、337只两种终值及实际组合/条件分仓统一分布。不同日历与长度不能拼成一个均匀CSCV收益矩阵，因此不伪造全族PBO；DSR按共同试验夏普分布及各候选OOS观察计算。计数/方差/逐试验夏普在scoreboard产物。重放相同参数和相同输入不重复算成新的策略试验。
试验夏普可估369/369，共同日频夏普方差0.007，紧缩日频夏普门槛0.242。条件分仓的无资金日为不适用，不纳入该分仓观察；并未删除试验，也未将其填0或把账户缺失行情当成无资金日。首次汇总误把两个分仓的无资金日当缺失而导致全族DSR不可估，已纠正并重评；逐项数字与验证见scoreboard-dsr-correction.json。

修改口径是在看过阶段结果之后，数据挖掘偏差不能靠事后DSR消除。规则统一、参数不动，新旧字段同时披露；两种主池变化属用户另行明确授权，不能写成整批“证券池未变”。

## A股主口径：当前中证800可执行258只

共63行。留出范围2025-06-03—2026-11-13。收益、超额、夏普差均为扣费策略对同窗基准；压力列为绝对收益/夏普差；最大DD跨OOS、留出和两项压力取最坏值。正窗列新/旧均保留，原始超额不是新口径晋级条件。

| 候选 | 留出收益/超额/夏普差 | 成本×2 收益/夏普差 | 延迟 收益/夏普差 | 新正窗/旧正窗·闭合交易 | 最坏DD/邻域/DSR | 新/旧判定 |
|---|---|---|---|---|---|---|
| r2a-cn-equity-rps-multi-atr | 61.29% / 54.02% / 0.923 | 63.99% / 0.958 | 71.45% / 1.078 | 5/6 / 5/6 · 1308 | 43.03% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-rps-multi-atr-neighbor-90 | 37.20% / 29.93% / 0.544 | 34.42% / 0.489 | 42.53% / 0.630 | 4/6 / 4/6 · 1372 | 53.87% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-rps-multi-atr-neighbor-110 | 77.03% / 69.76% / 1.175 | 82.27% / 1.239 | 56.23% / 0.883 | 5/6 / 5/6 · 1267 | 46.22% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-rps-multi-trailing | 106.32% / 99.05% / 1.430 | 109.14% / 1.445 | 32.52% / 0.477 | 3/6 / 3/6 · 2474 | 51.28% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-rps-multi-trailing-neighbor-90 | 61.09% / 53.82% / 0.896 | 61.02% / 0.892 | 50.11% / 0.803 | 3/6 / 3/6 · 2763 | 52.39% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-rps-multi-trailing-neighbor-110 | 78.71% / 71.44% / 1.097 | 67.55% / 0.953 | 64.46% / 0.920 | 3/6 / 3/6 · 2256 | 50.12% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-rps-multi-time | 57.23% / 49.96% / 0.782 | 69.07% / 0.926 | 110.34% / 1.435 | 3/6 / 4/6 · 1684 | 50.63% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-rps-multi-time-neighbor-90 | 90.85% / 83.58% / 1.191 | 95.21% / 1.208 | 31.60% / 0.425 | 4/6 / 4/6 · 1815 | 50.74% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-rps-multi-time-neighbor-110 | 39.23% / 31.96% / 0.541 | 61.81% / 0.868 | 84.61% / 1.159 | 4/6 / 4/6 · 1560 | 47.63% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-atr | 24.82% / 17.55% / 0.471 | 15.92% / 0.237 | 28.00% / 0.600 | 2/6 / 3/6 · 1196 | 35.79% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-atr-neighbor-90 | 24.46% / 17.19% / 0.472 | 18.85% / 0.329 | 30.76% / 0.686 | 3/6 / 4/6 · 1237 | 33.26% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-atr-neighbor-110 | 10.10% / 2.83% / 0.080 | 17.90% / 0.307 | 17.00% / 0.303 | 3/6 / 4/6 · 1176 | 37.57% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-trailing | 19.66% / 12.39% / 0.441 | 16.78% / 0.342 | 20.00% / 0.445 | 3/6 / 4/6 · 1404 | 29.35% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-trailing-neighbor-90 | 21.75% / 14.48% / 0.517 | 15.32% / 0.294 | 17.85% / 0.397 | 3/6 / 4/6 · 1487 | 35.03% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-trailing-neighbor-110 | 42.39% / 35.11% / 1.078 | 37.55% / 0.940 | 34.31% / 0.848 | 4/6 / 4/6 · 1369 | 28.06% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-time | 20.19% / 12.92% / 0.390 | 14.48% / 0.216 | 11.47% / 0.136 | 2/6 / 3/6 · 1246 | 37.34% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-time-neighbor-90 | 31.34% / 24.07% / 0.678 | 25.50% / 0.525 | 59.31% / 1.351 | 4/6 / 5/6 · 1315 | 32.96% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-time-neighbor-110 | 20.07% / 12.80% / 0.405 | 33.18% / 0.755 | 1.16% / -0.216 | 1/6 / 2/6 · 1170 | 31.73% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-atr | 13.43% / 6.16% / 0.204 | 6.12% / -0.042 | -10.89% / -0.681 | 3/6 / 4/6 · 1899 | 35.22% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-atr-neighbor-90 | 9.27% / 2.00% / 0.067 | 5.11% / -0.078 | -10.19% / -0.654 | 5/6 / 5/6 · 1909 | 30.77% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-atr-neighbor-110 | 8.56% / 1.29% / 0.042 | 5.58% / -0.061 | -9.39% / -0.598 | 3/6 / 3/6 · 1891 | 32.68% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-trailing | 16.37% / 9.10% / 0.352 | 6.95% / -0.005 | 9.65% / 0.100 | 5/6 / 5/6 · 2164 | 30.11% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-trailing-neighbor-90 | 2.08% / -5.19% / -0.205 | 1.22% / -0.243 | 12.26% / 0.192 | 2/6 / 4/6 · 2291 | 25.77% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-trailing-neighbor-110 | 26.94% / 19.67% / 0.686 | 15.39% / 0.303 | 16.47% / 0.335 | 4/6 / 4/6 · 2098 | 25.13% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-time | 35.72% / 28.45% / 0.871 | 31.78% / 0.755 | 11.45% / 0.136 | 4/6 / 4/6 · 1945 | 28.25% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-time-neighbor-90 | 21.84% / 14.57% / 0.462 | 9.76% / 0.080 | 6.72% / -0.022 | 3/6 / 3/6 · 2024 | 29.10% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-time-neighbor-110 | 1.46% / -5.81% / -0.210 | 2.42% / -0.172 | 8.07% / 0.021 | 4/6 / 4/6 · 1860 | 30.64% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-atr | 25.66% / 18.39% / 0.484 | 32.17% / 0.653 | 19.88% / 0.327 | 3/6 / 3/6 · 1372 | 41.14% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-atr-neighbor-90 | 18.75% / 11.47% / 0.294 | 19.76% / 0.337 | 19.20% / 0.322 | 1/6 / 1/6 · 1451 | 39.93% / 50.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-atr-neighbor-110 | 16.63% / 9.36% / 0.266 | 29.26% / 0.598 | 2.43% / -0.154 | 2/6 / 2/6 · 1317 | 40.76% / 50.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-trailing | 7.06% / -0.21% / -0.007 | 7.97% / 0.024 | 12.29% / 0.176 | 4/6 / 5/6 · 1896 | 37.43% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-trailing-neighbor-90 | 0.54% / -6.73% / -0.260 | 2.72% / -0.171 | 6.14% / -0.039 | 2/6 / 2/6 · 2040 | 39.74% / 50.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-trailing-neighbor-110 | 18.22% / 10.95% / 0.347 | 51.45% / 1.172 | 23.75% / 0.516 | 4/6 / 4/6 · 1783 | 40.52% / 50.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-time | 21.80% / 14.53% / 0.387 | 22.66% / 0.402 | 20.67% / 0.399 | 4/6 / 6/6 · 1499 | 38.90% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-time-neighbor-90 | -5.43% / -12.71% / -0.444 | -21.37% / -1.120 | 23.53% / 0.460 | 2/6 / 3/6 · 1613 | 40.95% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-time-neighbor-110 | 35.73% / 28.46% / 0.720 | 53.26% / 1.053 | -2.78% / -0.366 | 4/6 / 4/6 · 1370 | 34.17% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-atr | 9.86% / 2.59% / 0.081 | 5.34% / -0.070 | -10.39% / -0.671 | 3/6 / 3/6 · 1344 | 36.52% / 50.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-atr-neighbor-90 | 11.09% / 3.82% / 0.123 | 18.21% / 0.345 | -9.84% / -0.601 | 3/6 / 4/6 · 1383 | 37.05% / 50.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-atr-neighbor-110 | 15.13% / 7.86% / 0.241 | 11.37% / 0.126 | -3.20% / -0.365 | 1/6 / 2/6 · 1290 | 31.79% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-trailing | -12.19% / -19.46% / -0.823 | -18.59% / -1.152 | -7.71% / -0.612 | 2/6 / 3/6 · 1759 | 34.25% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-trailing-neighbor-90 | -9.93% / -17.20% / -0.732 | -12.74% / -0.885 | -13.77% / -0.892 | 3/6 / 4/6 · 1886 | 29.97% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-trailing-neighbor-110 | -5.35% / -12.62% / -0.473 | -19.58% / -1.143 | -16.13% / -1.017 | 3/6 / 4/6 · 1681 | 36.80% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-time | -15.37% / -22.64% / -0.905 | -17.58% / -1.001 | 2.46% / -0.176 | 2/6 / 2/6 · 1479 | 39.43% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-time-neighbor-90 | 14.94% / 7.67% / 0.284 | 16.46% / 0.316 | 6.34% / -0.035 | 4/6 / 5/6 · 1587 | 31.46% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-time-neighbor-110 | -1.76% / -9.03% / -0.322 | -2.64% / -0.362 | 27.32% / 0.651 | 1/6 / 2/6 · 1366 | 40.75% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-atr | -8.90% / -16.17% / -0.589 | -12.66% / -0.762 | -8.89% / -0.574 | 4/6 / 4/6 · 152 | 35.72% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-atr-neighbor-90 | -8.18% / -15.45% / -0.576 | -10.80% / -0.681 | -3.58% / -0.398 | 3/6 / 3/6 · 164 | 33.62% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-atr-neighbor-110 | -12.58% / -19.85% / -0.720 | -17.32% / -0.914 | -8.88% / -0.594 | 4/6 / 4/6 · 132 | 37.52% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-trailing | -13.67% / -20.94% / -0.800 | -14.53% / -0.856 | -1.70% / -0.336 | 4/6 / 4/6 · 136 | 36.29% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-trailing-neighbor-90 | -8.86% / -16.13% / -0.624 | -9.91% / -0.680 | -4.71% / -0.445 | 4/6 / 4/6 · 144 | 32.74% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-trailing-neighbor-110 | -10.25% / -17.52% / -0.677 | -12.66% / -0.785 | -9.12% / -0.631 | 3/6 / 3/6 · 123 | 35.07% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-time | -16.45% / -23.72% / -0.932 | -18.84% / -1.042 | -10.33% / -0.677 | 3/6 / 3/6 · 114 | 39.26% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-time-neighbor-90 | -16.45% / -23.72% / -0.932 | -18.84% / -1.042 | -10.33% / -0.677 | 3/6 / 3/6 · 114 | 39.26% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-time-neighbor-110 | -16.45% / -23.72% / -0.932 | -18.84% / -1.042 | -10.33% / -0.677 | 3/6 / 3/6 · 114 | 39.26% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-atr | 8.11% / 0.84% / 0.213 | 7.35% / 0.152 | 6.79% / 0.119 | 3/6 / 3/6 · 209 | 13.49% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-atr-neighbor-90 | 7.14% / -0.13% / 0.152 | 6.41% / 0.091 | 6.76% / 0.136 | 3/6 / 3/6 · 209 | 13.32% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-atr-neighbor-110 | 8.66% / 1.39% / 0.254 | 7.86% / 0.191 | 6.61% / 0.103 | 3/6 / 3/6 · 209 | 14.19% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-trailing | 12.25% / 4.98% / 0.676 | 12.03% / 0.645 | 7.40% / 0.255 | 2/6 / 3/6 · 212 | 10.53% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-trailing-neighbor-90 | 11.92% / 4.65% / 0.652 | 11.16% / 0.580 | 7.73% / 0.296 | 2/6 / 3/6 · 212 | 9.13% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-trailing-neighbor-110 | 12.60% / 5.33% / 0.659 | 11.81% / 0.588 | 9.50% / 0.402 | 2/6 / 3/6 · 212 | 11.07% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-time | 11.48% / 4.21% / 0.504 | 10.71% / 0.442 | 7.52% / 0.184 | 2/6 / 3/6 · 211 | 12.64% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-time-neighbor-90 | 6.55% / -0.72% / 0.119 | 6.41% / 0.102 | 8.54% / 0.291 | 2/6 / 3/6 · 213 | 12.48% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-time-neighbor-110 | 10.97% / 3.70% / 0.442 | 10.20% / 0.383 | 8.74% / 0.266 | 2/6 / 3/6 · 210 | 12.98% / 100.00% / 0.000 | 未通过 / 未通过 |

逐项失败代码（完整逐窗和原始字段见scoreboard产物）：

- r2a-cn-equity-rps-multi-atr：新 drawdown-bound, multiple-testing-dsr-0.95；旧 drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-rps-multi-atr-neighbor-90：新 drawdown-bound, multiple-testing-dsr-0.95；旧 drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-rps-multi-atr-neighbor-110：新 drawdown-bound, multiple-testing-dsr-0.95；旧 drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-rps-multi-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-rps-multi-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-rps-multi-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-rps-multi-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-rps-multi-time-neighbor-90：新 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-rps-multi-time-neighbor-110：新 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-trailing-neighbor-110：新 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-time-neighbor-90：新 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-atr-neighbor-90：新 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-trailing：新 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-trailing-neighbor-110：新 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-time：新 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-time-neighbor-110：新 cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-trailing：新 cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-trailing-neighbor-110：新 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-time：新 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-time-neighbor-110：新 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-time-neighbor-90：新 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-atr：新 cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, holdout-positive-excess, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-atr-neighbor-110：新 cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, holdout-positive-excess, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-trailing：新 cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95, cycle-cost-or-delay-stress；旧 cost-or-delay-stress, drawdown-bound, holdout-positive-excess, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-trailing-neighbor-90：新 cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, holdout-positive-excess, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, multiple-testing-dsr-0.95。

## 数字货币主口径：BTC/ETH

共54行。留出范围2025-06-01—2026-11-13；2025-06-01—2026-11-14。收益、超额、夏普差均为扣费策略对同窗基准；压力列为绝对收益/夏普差；最大DD跨OOS、留出和两项压力取最坏值。正窗列新/旧均保留，原始超额不是新口径晋级条件。

| 候选 | 留出收益/超额/夏普差 | 成本×2 收益/夏普差 | 延迟 收益/夏普差 | 新正窗/旧正窗·闭合交易 | 最坏DD/邻域/DSR | 新/旧判定 |
|---|---|---|---|---|---|---|
| r2a-crypto-dual-ma-day-atr | 1.95% / 36.64% / 0.197 | 1.46% / 0.132 | 1.56% / 0.107 | 3/6 / 4/6 · 52 | 6.90% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-day-atr-neighbor-90 | 2.35% / 37.04% / 0.244 | 1.86% / 0.179 | 1.81% / 0.137 | 3/6 / 4/6 · 52 | 7.02% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-day-atr-neighbor-110 | 1.80% / 36.49% / 0.182 | 1.32% / 0.120 | 1.34% / 0.080 | 3/6 / 4/6 · 52 | 7.02% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-day-trailing | 3.49% / 38.18% / 0.384 | 2.99% / 0.313 | 2.52% / 0.210 | 3/6 / 4/6 · 52 | 5.40% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-day-trailing-neighbor-90 | 3.25% / 37.94% / 0.347 | 2.75% / 0.274 | 1.95% / 0.112 | 2/6 / 4/6 · 52 | 5.22% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-day-trailing-neighbor-110 | 2.85% / 37.53% / 0.296 | 2.36% / 0.227 | 2.59% / 0.224 | 3/6 / 4/6 · 52 | 5.98% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-day-time | 2.30% / 36.98% / 0.237 | 1.83% / 0.175 | 1.90% / 0.141 | 3/6 / 4/6 · 52 | 6.56% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-day-time-neighbor-90 | 1.83% / 36.51% / 0.168 | 1.36% / 0.104 | 2.66% / 0.249 | 3/6 / 4/6 · 52 | 6.66% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-day-time-neighbor-110 | 1.54% / 36.22% / 0.142 | 1.07% / 0.080 | 1.41% / 0.077 | 2/6 / 4/6 · 52 | 6.86% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-atr | 1.08% / 35.77% / 0.030 | 0.66% / -0.033 | -2.85% / -0.582 | 3/6 / 4/6 · 55 | 6.41% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-atr-neighbor-90 | 1.58% / 36.26% / 0.098 | 1.15% / 0.035 | -2.25% / -0.505 | 3/6 / 4/6 · 57 | 6.77% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-atr-neighbor-110 | 0.59% / 35.27% / -0.038 | 0.17% / -0.100 | -3.45% / -0.669 | 3/6 / 4/6 · 55 | 6.10% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-trailing | 1.61% / 36.30% / 0.041 | 1.20% / -0.029 | -2.70% / -0.691 | 3/6 / 4/6 · 61 | 6.45% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-trailing-neighbor-90 | 0.28% / 34.96% / -0.196 | -0.16% / -0.271 | -2.97% / -0.784 | 1/6 / 4/6 · 65 | 5.84% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-trailing-neighbor-110 | 1.35% / 36.04% / 0.000 | 0.95% / -0.068 | -3.01% / -0.728 | 3/6 / 4/6 · 60 | 6.68% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-time | 1.71% / 36.40% / 0.120 | 1.31% / 0.060 | -2.04% / -0.425 | 3/6 / 4/6 · 59 | 6.52% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-time-neighbor-90 | 2.33% / 37.01% / 0.209 | 2.14% / 0.181 | -0.50% / -0.216 | 3/6 / 4/6 · 60 | 5.36% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-time-neighbor-110 | -0.05% / 34.64% / -0.124 | -0.44% / -0.181 | -1.89% / -0.381 | 2/6 / 4/6 · 58 | 6.52% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-atr | -5.49% / 29.26% / -0.410 | -6.12% / -0.479 | -2.26% / -0.110 | 0/6 / 4/6 · 382 | 12.91% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-atr-neighbor-90 | -9.06% / 25.69% / -0.832 | -9.68% / -0.906 | -6.63% / -0.586 | 0/6 / 4/6 · 382 | 12.78% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-atr-neighbor-110 | -5.03% / 29.72% / -0.333 | -5.26% / -0.365 | -1.47% / -0.017 | 0/6 / 4/6 · 381 | 12.40% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-trailing | -5.16% / 29.59% / -0.345 | -5.68% / -0.401 | -2.51% / -0.112 | 0/6 / 4/6 · 382 | 12.36% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-trailing-neighbor-90 | -4.85% / 29.90% / -0.316 | -5.38% / -0.373 | -2.36% / -0.097 | 0/6 / 4/6 · 382 | 12.17% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-trailing-neighbor-110 | -5.05% / 29.70% / -0.321 | -5.43% / -0.368 | -2.84% / -0.139 | 0/6 / 4/6 · 381 | 12.84% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-time | -5.08% / 29.68% / -0.322 | -5.58% / -0.379 | -2.95% / -0.148 | 0/6 / 4/6 · 381 | 12.04% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-time-neighbor-90 | -4.80% / 29.95% / -0.298 | -5.30% / -0.354 | -2.84% / -0.138 | 0/6 / 4/6 · 381 | 12.04% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-time-neighbor-110 | -5.13% / 29.62% / -0.326 | -5.63% / -0.383 | -2.94% / -0.145 | 0/6 / 4/6 · 381 | 12.04% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-atr | 0.09% / 34.84% / 0.100 | -1.61% / -0.080 | -0.90% / -0.003 | 2/6 / 4/6 · 171 | 10.65% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-atr-neighbor-90 | 0.72% / 35.47% / 0.158 | -1.01% / -0.024 | -0.82% / -0.003 | 2/6 / 4/6 · 173 | 10.41% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-atr-neighbor-110 | 0.49% / 35.24% / 0.143 | -1.21% / -0.037 | -0.96% / -0.001 | 2/6 / 4/6 · 167 | 10.34% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-trailing | -2.01% / 32.74% / -0.126 | -3.51% / -0.293 | -1.11% / -0.035 | 1/6 / 4/6 · 168 | 11.63% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-trailing-neighbor-90 | -0.92% / 33.83% / -0.027 | -2.54% / -0.206 | -0.31% / 0.034 | 1/6 / 4/6 · 174 | 9.70% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-trailing-neighbor-110 | -3.20% / 31.55% / -0.231 | -4.52% / -0.379 | -2.05% / -0.119 | 1/6 / 4/6 · 162 | 12.45% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-time | -3.99% / 30.76% / -0.236 | -4.85% / -0.334 | -1.40% / -0.008 | 1/6 / 4/6 · 149 | 12.44% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-time-neighbor-90 | -3.32% / 31.43% / -0.177 | -4.78% / -0.334 | -2.74% / -0.131 | 1/6 / 4/6 · 156 | 12.46% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-time-neighbor-110 | -5.61% / 29.14% / -0.367 | -6.44% / -0.469 | -5.16% / -0.328 | 0/6 / 4/6 · 147 | 13.56% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-atr | -17.75% / 16.96% / -0.591 | -41.79% / -2.250 | -28.13% / -1.276 | 0/6 / 2/6 · 2145 | 42.76% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-atr-neighbor-90 | -17.69% / 17.02% / -0.599 | -42.42% / -2.330 | -27.11% / -1.223 | 0/6 / 2/6 · 2170 | 42.42% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-atr-neighbor-110 | -16.77% / 17.94% / -0.511 | -40.21% / -2.072 | -28.93% / -1.321 | 0/6 / 2/6 · 2136 | 44.79% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-trailing | -16.28% / 18.42% / -0.577 | -38.22% / -2.154 | -27.20% / -1.447 | 0/6 / 3/6 · 2153 | 48.79% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-trailing-neighbor-90 | -15.26% / 19.45% / -0.523 | -37.12% / -2.094 | -25.39% / -1.351 | 0/6 / 3/6 · 2173 | 48.48% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-trailing-neighbor-110 | -13.77% / 20.94% / -0.406 | -35.96% / -1.878 | -25.54% / -1.292 | 0/6 / 2/6 · 2138 | 48.49% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-time | -9.62% / 25.09% / -0.101 | -34.15% / -1.522 | -21.85% / -0.759 | 0/6 / 3/6 · 2095 | 49.02% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-time-neighbor-90 | -4.50% / 30.21% / 0.109 | -29.79% / -1.329 | -12.36% / -0.252 | 0/6 / 3/6 · 2160 | 47.93% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-time-neighbor-110 | -10.19% / 24.52% / -0.083 | -34.58% / -1.401 | -23.25% / -0.821 | 0/6 / 2/6 · 2035 | 46.02% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-atr | -73.19% / -38.47% / -6.019 | -87.76% / -9.587 | -65.16% / -5.165 | 0/6 / 1/6 · 7725 | 87.78% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-atr-neighbor-90 | -72.95% / -38.22% / -6.003 | -87.85% / -9.838 | -65.34% / -5.343 | 0/6 / 1/6 · 7783 | 87.88% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-atr-neighbor-110 | -73.61% / -38.89% / -5.958 | -87.66% / -9.598 | -65.40% / -5.067 | 0/6 / 1/6 · 7671 | 87.69% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-trailing | -74.22% / -39.50% / -5.901 | -87.41% / -9.305 | -65.65% / -4.631 | 0/6 / 0/6 · 7537 | 87.42% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-trailing-neighbor-90 | -74.23% / -39.51% / -5.935 | -87.58% / -9.370 | -64.84% / -4.620 | 0/6 / 0/6 · 7548 | 87.59% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-trailing-neighbor-110 | -74.31% / -39.59% / -5.947 | -87.29% / -9.348 | -65.16% / -4.588 | 0/6 / 0/6 · 7532 | 87.30% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-time | -73.78% / -39.06% / -5.683 | -86.90% / -8.958 | -65.29% / -4.522 | 0/6 / 0/6 · 7516 | 86.91% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-time-neighbor-90 | -72.35% / -37.63% / -5.356 | -87.20% / -9.496 | -64.87% / -4.724 | 0/6 / 1/6 · 7714 | 87.21% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-time-neighbor-110 | -70.33% / -35.61% / -4.884 | -85.89% / -8.262 | -65.88% / -4.342 | 0/6 / 0/6 · 7318 | 85.92% / 0.00% / 0.000 | 未通过 / 未通过 |

逐项失败代码（完整逐窗和原始字段见scoreboard产物）：

- r2a-crypto-dual-ma-day-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-day-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-day-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-day-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-day-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-day-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-day-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-day-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-day-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。

### BTC/ETH各50%持有基准并列

Each evaluation window independently invests50% initial capital at each symbol first native open, holds without rebalance or benchmark transaction charges; positive missingness is never filled. Strategy daily returns are reconciled to original return and Sharpe before comparison.

| 候选 | 对50/50留出原始超额 | 对50/50留出夏普差 |
|---|---:|---:|
| r2a-crypto-dual-ma-day-atr | 31.13% | -0.073 |
| r2a-crypto-dual-ma-day-atr-neighbor-90 | 31.53% | -0.025 |
| r2a-crypto-dual-ma-day-atr-neighbor-110 | 30.97% | -0.087 |
| r2a-crypto-dual-ma-day-trailing | 32.67% | 0.115 |
| r2a-crypto-dual-ma-day-trailing-neighbor-90 | 32.43% | 0.077 |
| r2a-crypto-dual-ma-day-trailing-neighbor-110 | 32.02% | 0.026 |
| r2a-crypto-dual-ma-day-time | 31.47% | -0.032 |
| r2a-crypto-dual-ma-day-time-neighbor-90 | 31.00% | -0.101 |
| r2a-crypto-dual-ma-day-time-neighbor-110 | 30.71% | -0.128 |
| r2a-crypto-range-day-atr | 30.26% | -0.239 |
| r2a-crypto-range-day-atr-neighbor-90 | 30.75% | -0.171 |
| r2a-crypto-range-day-atr-neighbor-110 | 29.76% | -0.308 |
| r2a-crypto-range-day-trailing | 30.79% | -0.228 |
| r2a-crypto-range-day-trailing-neighbor-90 | 29.45% | -0.465 |
| r2a-crypto-range-day-trailing-neighbor-110 | 30.52% | -0.269 |
| r2a-crypto-range-day-time | 30.88% | -0.150 |
| r2a-crypto-range-day-time-neighbor-90 | 31.50% | -0.061 |
| r2a-crypto-range-day-time-neighbor-110 | 29.12% | -0.394 |
| r2a-crypto-dual-ma-4h-atr | 23.85% | -0.677 |
| r2a-crypto-dual-ma-4h-atr-neighbor-90 | 20.28% | -1.099 |
| r2a-crypto-dual-ma-4h-atr-neighbor-110 | 24.31% | -0.600 |
| r2a-crypto-dual-ma-4h-trailing | 24.18% | -0.612 |
| r2a-crypto-dual-ma-4h-trailing-neighbor-90 | 24.50% | -0.582 |
| r2a-crypto-dual-ma-4h-trailing-neighbor-110 | 24.30% | -0.588 |
| r2a-crypto-dual-ma-4h-time | 24.27% | -0.589 |
| r2a-crypto-dual-ma-4h-time-neighbor-90 | 24.55% | -0.564 |
| r2a-crypto-dual-ma-4h-time-neighbor-110 | 24.22% | -0.593 |
| r2a-crypto-range-4h-atr | 29.43% | -0.167 |
| r2a-crypto-range-4h-atr-neighbor-90 | 30.06% | -0.109 |
| r2a-crypto-range-4h-atr-neighbor-110 | 29.84% | -0.124 |
| r2a-crypto-range-4h-trailing | 27.34% | -0.393 |
| r2a-crypto-range-4h-trailing-neighbor-90 | 28.43% | -0.294 |
| r2a-crypto-range-4h-trailing-neighbor-110 | 26.15% | -0.498 |
| r2a-crypto-range-4h-time | 25.36% | -0.503 |
| r2a-crypto-range-4h-time-neighbor-90 | 26.03% | -0.443 |
| r2a-crypto-range-4h-time-neighbor-110 | 23.74% | -0.634 |
| r2a-crypto-range-1h-atr | 11.48% | -0.857 |
| r2a-crypto-range-1h-atr-neighbor-90 | 11.54% | -0.865 |
| r2a-crypto-range-1h-atr-neighbor-110 | 12.46% | -0.777 |
| r2a-crypto-range-1h-trailing | 12.94% | -0.843 |
| r2a-crypto-range-1h-trailing-neighbor-90 | 13.97% | -0.790 |
| r2a-crypto-range-1h-trailing-neighbor-110 | 15.46% | -0.672 |
| r2a-crypto-range-1h-time | 19.61% | -0.367 |
| r2a-crypto-range-1h-time-neighbor-90 | 24.73% | -0.157 |
| r2a-crypto-range-1h-time-neighbor-110 | 19.04% | -0.350 |
| r2a-crypto-range-15m-atr | -43.97% | -6.294 |
| r2a-crypto-range-15m-atr-neighbor-90 | -43.72% | -6.278 |
| r2a-crypto-range-15m-atr-neighbor-110 | -44.38% | -6.233 |
| r2a-crypto-range-15m-trailing | -45.00% | -6.176 |
| r2a-crypto-range-15m-trailing-neighbor-90 | -45.00% | -6.210 |
| r2a-crypto-range-15m-trailing-neighbor-110 | -45.08% | -6.222 |
| r2a-crypto-range-15m-time | -44.56% | -5.957 |
| r2a-crypto-range-15m-time-neighbor-90 | -43.12% | -5.630 |
| r2a-crypto-range-15m-time-neighbor-110 | -41.10% | -5.159 |

## 全市场1638只对照（旧冻结输入、同一新旧门槛重评）

共54行。留出范围2023-06-29—2026-11-13。收益、超额、夏普差均为扣费策略对同窗基准；压力列为绝对收益/夏普差；最大DD跨OOS、留出和两项压力取最坏值。正窗列新/旧均保留，原始超额不是新口径晋级条件。

| 候选 | 留出收益/超额/夏普差 | 成本×2 收益/夏普差 | 延迟 收益/夏普差 | 新正窗/旧正窗·闭合交易 | 最坏DD/邻域/DSR | 新/旧判定 |
|---|---|---|---|---|---|---|
| r2a-cn-equity-rps-multi-atr | -21.65% / -26.33% / -0.226 | -33.22% / -0.394 | -37.32% / -0.465 | 1/6 / 1/6 · 1380 | 56.34% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-rps-multi-atr-neighbor-90 | -59.97% / -64.65% / -0.908 | -43.36% / -0.553 | -32.65% / -0.391 | 1/6 / 1/6 · 1441 | 63.45% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-rps-multi-atr-neighbor-110 | -32.82% / -37.50% / -0.414 | -44.91% / -0.635 | -19.87% / -0.225 | 1/6 / 1/6 · 1344 | 51.75% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-rps-multi-trailing | 9.57% / 4.89% / 0.113 | 5.05% / 0.069 | -28.31% / -0.361 | 1/6 / 1/6 · 3181 | 54.64% / 50.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-rps-multi-trailing-neighbor-90 | 10.13% / 5.45% / 0.117 | -10.27% / -0.113 | 8.51% / 0.097 | 1/6 / 1/6 · 3521 | 51.70% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-rps-multi-trailing-neighbor-110 | -7.96% / -12.64% / -0.072 | -24.99% / -0.287 | -22.37% / -0.265 | 0/6 / 0/6 · 2885 | 55.57% / 50.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-rps-multi-time | -29.90% / -34.58% / -0.334 | -57.65% / -0.847 | -23.79% / -0.246 | 0/6 / 0/6 · 1961 | 58.48% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-rps-multi-time-neighbor-90 | -38.42% / -43.10% / -0.461 | -43.41% / -0.533 | -36.50% / -0.442 | 0/6 / 0/6 · 2117 | 54.88% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-rps-multi-time-neighbor-110 | -37.95% / -42.63% / -0.446 | -50.43% / -0.670 | -42.69% / -0.544 | 0/6 / 0/6 · 1860 | 57.80% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-atr | -54.38% / -59.06% / -0.982 | -61.55% / -1.176 | -37.76% / -0.603 | 1/6 / 1/6 · 1444 | 63.84% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-atr-neighbor-90 | -51.48% / -56.16% / -0.890 | -59.64% / -1.115 | -39.21% / -0.624 | 1/6 / 1/6 · 1513 | 60.89% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-atr-neighbor-110 | -63.31% / -67.99% / -1.301 | -58.13% / -1.110 | -43.17% / -0.724 | 1/6 / 1/6 · 1383 | 64.74% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-trailing | -14.95% / -19.63% / -0.276 | -18.95% / -0.343 | -20.16% / -0.377 | 1/6 / 2/6 · 2068 | 39.36% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-trailing-neighbor-90 | 4.58% / -0.10% / 0.017 | -6.34% / -0.145 | 19.56% / 0.216 | 4/6 / 5/6 · 2215 | 36.71% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-trailing-neighbor-110 | -15.98% / -20.66% / -0.285 | -26.56% / -0.479 | -37.80% / -0.730 | 3/6 / 3/6 · 1906 | 41.50% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-time | -42.66% / -47.34% / -0.760 | -45.39% / -0.782 | -36.85% / -0.578 | 1/6 / 1/6 · 1601 | 50.92% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-time-neighbor-90 | -22.75% / -27.43% / -0.334 | -16.59% / -0.234 | -34.61% / -0.541 | 2/6 / 2/6 · 1721 | 51.60% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-double-breakout-time-neighbor-110 | -28.14% / -32.82% / -0.447 | -47.07% / -0.842 | -52.60% / -0.927 | 2/6 / 2/6 · 1478 | 55.65% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-atr | -11.54% / -16.22% / -0.191 | -25.67% / -0.420 | -31.23% / -0.571 | 2/6 / 2/6 · 2035 | 40.28% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-atr-neighbor-90 | -20.35% / -25.03% / -0.340 | -35.24% / -0.618 | -29.80% / -0.534 | 1/6 / 2/6 · 2066 | 42.73% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-atr-neighbor-110 | -14.26% / -18.94% / -0.234 | -37.91% / -0.666 | -24.19% / -0.423 | 2/6 / 2/6 · 2014 | 43.41% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-trailing | 5.16% / 0.48% / 0.016 | -9.26% / -0.221 | 0.27% / -0.063 | 2/6 / 3/6 · 2501 | 32.51% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-trailing-neighbor-90 | 5.60% / 0.92% / 0.020 | -5.87% / -0.169 | -0.93% / -0.084 | 3/6 / 4/6 · 2672 | 37.38% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-trailing-neighbor-110 | -0.30% / -4.98% / -0.063 | -6.33% / -0.158 | 1.75% / -0.038 | 2/6 / 3/6 · 2423 | 35.51% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-time | -8.34% / -13.02% / -0.155 | -27.00% / -0.480 | -27.16% / -0.506 | 2/6 / 2/6 · 2114 | 39.97% / 50.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-time-neighbor-90 | -15.77% / -20.45% / -0.284 | -27.57% / -0.509 | -10.75% / -0.212 | 1/6 / 1/6 · 2261 | 43.39% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-ma-time-neighbor-110 | -2.58% / -7.26% / -0.067 | -13.54% / -0.227 | -28.50% / -0.531 | 1/6 / 1/6 · 2082 | 49.10% / 50.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-atr | -59.57% / -64.25% / -1.094 | -58.09% / -1.083 | -0.31% / -0.025 | 0/6 / 0/6 · 1538 | 60.96% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-atr-neighbor-90 | -48.62% / -53.30% / -0.825 | -47.22% / -0.800 | -23.09% / -0.370 | 0/6 / 0/6 · 1610 | 59.74% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-atr-neighbor-110 | -54.77% / -59.45% / -1.006 | -59.69% / -1.171 | -15.34% / -0.222 | 0/6 / 0/6 · 1473 | 65.25% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-trailing | 9.13% / 4.45% / 0.083 | 2.54% / -0.006 | 58.49% / 0.652 | 1/6 / 1/6 · 2477 | 49.58% / 50.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-trailing-neighbor-90 | 53.99% / 49.31% / 0.593 | 37.53% / 0.423 | 72.49% / 0.799 | 1/6 / 1/6 · 2755 | 47.38% / 50.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-trailing-neighbor-110 | -9.24% / -13.92% / -0.180 | -4.88% / -0.112 | 17.81% / 0.195 | 1/6 / 1/6 · 2311 | 52.45% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-time | -46.77% / -51.45% / -0.821 | -46.73% / -0.828 | -20.81% / -0.354 | 1/6 / 1/6 · 1769 | 60.94% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-time-neighbor-90 | -61.96% / -66.64% / -1.278 | -64.92% / -1.376 | -40.24% / -0.696 | 0/6 / 0/6 · 1919 | 65.73% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-range-time-neighbor-110 | -50.92% / -55.60% / -0.945 | -56.64% / -1.097 | 47.75% / 0.478 | 0/6 / 0/6 · 1635 | 58.86% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-atr | -26.62% / -31.30% / -0.452 | -37.58% / -0.663 | -11.57% / -0.218 | 2/6 / 1/6 · 1373 | 46.28% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-atr-neighbor-90 | -27.80% / -32.48% / -0.454 | -20.82% / -0.335 | -38.02% / -0.720 | 2/6 / 2/6 · 1450 | 51.16% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-atr-neighbor-110 | -14.15% / -18.83% / -0.262 | -26.11% / -0.458 | -6.30% / -0.135 | 0/6 / 0/6 · 1327 | 50.63% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-trailing | 10.21% / 5.53% / 0.093 | 6.52% / 0.038 | 11.64% / 0.112 | 1/6 / 1/6 · 2045 | 40.21% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-trailing-neighbor-90 | 45.72% / 41.04% / 0.536 | 31.08% / 0.364 | 43.43% / 0.517 | 2/6 / 2/6 · 2209 | 34.56% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-trailing-neighbor-110 | 3.03% / -1.65% / -0.016 | -13.51% / -0.291 | 27.20% / 0.317 | 1/6 / 1/6 · 1953 | 37.30% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-time | -22.10% / -26.78% / -0.407 | -42.13% / -0.834 | -18.46% / -0.315 | 1/6 / 1/6 · 1631 | 46.44% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-time-neighbor-90 | -13.27% / -17.95% / -0.231 | -23.45% / -0.409 | -46.19% / -0.864 | 2/6 / 2/6 · 1770 | 50.54% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-formula-pullback-time-neighbor-110 | -3.50% / -8.18% / -0.092 | -10.23% / -0.187 | -31.40% / -0.572 | 1/6 / 1/6 · 1530 | 48.87% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-atr | 64.50% / 59.82% / 0.589 | 61.13% / 0.567 | 69.76% / 0.617 | 4/6 / 4/6 · 244 | 35.43% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-atr-neighbor-90 | 94.74% / 90.06% / 0.825 | 85.31% / 0.751 | 91.31% / 0.793 | 4/6 / 4/6 · 254 | 35.72% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-atr-neighbor-110 | 83.57% / 78.89% / 0.743 | 81.74% / 0.721 | 79.58% / 0.683 | 4/6 / 4/6 · 229 | 34.13% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-trailing | 70.67% / 65.99% / 0.678 | 53.23% / 0.528 | 57.12% / 0.550 | 4/6 / 4/6 · 228 | 38.04% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-trailing-neighbor-90 | 84.54% / 79.86% / 0.772 | 103.62% / 0.910 | 82.11% / 0.754 | 4/6 / 4/6 · 256 | 34.97% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-trailing-neighbor-110 | 86.56% / 81.88% / 0.784 | 84.56% / 0.771 | 69.20% / 0.660 | 4/6 / 4/6 · 223 | 31.05% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-time | 99.43% / 94.75% / 0.827 | 96.87% / 0.818 | 87.57% / 0.805 | 4/6 / 4/6 · 196 | 33.62% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-time-neighbor-90 | 99.43% / 94.75% / 0.827 | 96.87% / 0.818 | 87.57% / 0.805 | 4/6 / 4/6 · 196 | 33.62% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-historical-low-time-neighbor-110 | 99.43% / 94.75% / 0.827 | 96.87% / 0.818 | 87.57% / 0.805 | 4/6 / 4/6 · 196 | 33.62% / 100.00% / 0.000 | 未通过 / 未通过 |

逐项失败代码（完整逐窗和原始字段见scoreboard产物）：

- r2a-cn-equity-rps-multi-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-rps-multi-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-rps-multi-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-rps-multi-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-rps-multi-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-rps-multi-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-rps-multi-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-rps-multi-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-rps-multi-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-trailing-neighbor-90：新 cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-double-breakout-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-ma-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-range-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-formula-pullback-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-atr：新 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-atr-neighbor-90：新 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-atr-neighbor-110：新 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-trailing：新 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-trailing-neighbor-90：新 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-trailing-neighbor-110：新 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-time：新 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-time-neighbor-90：新 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。
- r2a-cn-equity-historical-low-time-neighbor-110：新 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95；旧 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, multiple-testing-dsr-0.95。

## 20币对对照（旧冻结输入、同一新旧门槛重评）

共54行。留出范围2025-06-30—2026-11-13。收益、超额、夏普差均为扣费策略对同窗基准；压力列为绝对收益/夏普差；最大DD跨OOS、留出和两项压力取最坏值。正窗列新/旧均保留，原始超额不是新口径晋级条件。

| 候选 | 留出收益/超额/夏普差 | 成本×2 收益/夏普差 | 延迟 收益/夏普差 | 新正窗/旧正窗·闭合交易 | 最坏DD/邻域/DSR | 新/旧判定 |
|---|---|---|---|---|---|---|
| r2a-crypto-dual-ma-day-atr | -10.62% / 26.33% / 0.293 | -13.20% / 0.227 | -7.95% / 0.379 | 1/6 / 2/6 · 327 | 37.86% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-day-atr-neighbor-90 | -8.71% / 28.25% / 0.337 | -11.19% / 0.274 | -5.83% / 0.424 | 1/6 / 1/6 · 328 | 36.84% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-day-atr-neighbor-110 | -12.00% / 24.95% / 0.254 | -14.21% / 0.195 | -10.10% / 0.328 | 1/6 / 2/6 · 326 | 38.21% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-day-trailing | 2.31% / 39.27% / 0.540 | -0.77% / 0.410 | -2.10% / 0.344 | 0/6 / 1/6 · 364 | 26.32% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-day-trailing-neighbor-90 | 3.89% / 40.84% / 0.601 | 1.14% / 0.478 | 0.25% / 0.435 | 0/6 / 1/6 · 369 | 23.98% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-day-trailing-neighbor-110 | -1.70% / 35.26% / 0.390 | -3.72% / 0.310 | -2.99% / 0.334 | 0/6 / 1/6 · 360 | 26.93% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-day-time | -5.19% / 31.77% / 0.422 | -7.88% / 0.353 | -2.57% / 0.494 | 1/6 / 1/6 · 346 | 34.13% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-day-time-neighbor-90 | -3.96% / 32.99% / 0.448 | -6.40% / 0.385 | -5.29% / 0.418 | 1/6 / 1/6 · 349 | 32.74% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-day-time-neighbor-110 | -2.26% / 34.70% / 0.503 | -6.44% / 0.398 | -1.70% / 0.518 | 2/6 / 2/6 · 342 | 36.38% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-atr | 5.29% / 42.25% / 0.681 | 3.00% / 0.624 | 5.80% / 0.685 | 1/6 / 2/6 · 251 | 32.65% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-atr-neighbor-90 | 6.73% / 43.69% / 0.716 | 4.39% / 0.658 | 7.21% / 0.728 | 1/6 / 2/6 · 255 | 35.01% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-atr-neighbor-110 | 3.36% / 40.32% / 0.633 | 1.70% / 0.590 | 3.06% / 0.599 | 1/6 / 2/6 · 251 | 31.74% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-trailing | -6.71% / 30.24% / 0.046 | -9.32% / -0.094 | 0.13% / 0.402 | 0/6 / 1/6 · 368 | 22.22% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-trailing-neighbor-90 | -5.36% / 31.60% / 0.101 | -8.09% / -0.051 | 1.70% / 0.473 | 0/6 / 1/6 · 375 | 20.29% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-trailing-neighbor-110 | -7.60% / 29.35% / 0.039 | -9.93% / -0.078 | -1.64% / 0.332 | 0/6 / 1/6 · 354 | 22.41% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-time | 4.17% / 41.12% / 0.646 | 2.27% / 0.595 | 3.92% / 0.619 | 1/6 / 1/6 · 297 | 26.82% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-time-neighbor-90 | -0.92% / 36.03% / 0.511 | 2.43% / 0.602 | 5.48% / 0.671 | 0/6 / 1/6 · 311 | 28.16% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-day-time-neighbor-110 | 2.91% / 39.87% / 0.618 | 3.19% / 0.626 | 12.72% / 0.893 | 1/6 / 1/6 · 286 | 26.96% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-atr | -39.48% / -3.77% / -0.144 | -44.52% / -0.271 | -41.41% / -0.200 | 0/6 / 1/6 · 1719 | 62.29% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-atr-neighbor-90 | -39.45% / -3.74% / -0.157 | -43.72% / -0.265 | -37.95% / -0.114 | 0/6 / 1/6 · 1741 | 61.48% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-atr-neighbor-110 | -39.50% / -3.80% / -0.141 | -43.31% / -0.235 | -41.73% / -0.204 | 0/6 / 1/6 · 1710 | 61.62% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-trailing | -24.91% / 10.79% / -0.045 | -32.87% / -0.273 | -31.69% / -0.213 | 0/6 / 1/6 · 1778 | 53.01% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-trailing-neighbor-90 | -26.09% / 9.61% / -0.095 | -33.43% / -0.317 | -30.29% / -0.199 | 0/6 / 1/6 · 1798 | 52.85% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-trailing-neighbor-110 | -22.80% / 12.90% / 0.034 | -29.72% / -0.150 | -30.05% / -0.141 | 0/6 / 1/6 · 1755 | 54.26% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-time | -35.87% / -0.17% / -0.052 | -41.48% / -0.185 | -40.76% / -0.221 | 0/6 / 1/6 · 1701 | 61.24% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-time-neighbor-90 | -35.82% / -0.12% / -0.051 | -41.52% / -0.187 | -40.94% / -0.226 | 0/6 / 1/6 · 1702 | 61.37% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-dual-ma-4h-time-neighbor-110 | -35.56% / 0.15% / -0.044 | -41.29% / -0.180 | -40.56% / -0.214 | 0/6 / 1/6 · 1699 | 61.23% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-atr | -27.70% / 8.00% / 0.039 | -31.33% / -0.054 | -21.21% / 0.187 | 0/6 / 1/6 · 858 | 50.99% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-atr-neighbor-90 | -27.03% / 8.67% / 0.047 | -30.27% / -0.041 | -22.33% / 0.150 | 0/6 / 1/6 · 898 | 51.75% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-atr-neighbor-110 | -31.27% / 4.43% / -0.047 | -34.41% / -0.134 | -24.46% / 0.124 | 0/6 / 1/6 · 830 | 52.16% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-trailing | -19.26% / 16.44% / 0.011 | -21.45% / -0.046 | -11.69% / 0.231 | 0/6 / 1/6 · 995 | 42.03% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-trailing-neighbor-90 | -16.21% / 19.49% / 0.070 | -18.14% / 0.020 | -12.99% / 0.170 | 0/6 / 1/6 · 1049 | 40.62% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-trailing-neighbor-110 | -15.81% / 19.89% / 0.155 | -18.12% / 0.097 | -5.90% / 0.397 | 0/6 / 1/6 · 945 | 44.24% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-time | -33.68% / 2.02% / -0.017 | -36.02% / -0.179 | -20.99% / 0.177 | 0/6 / 1/6 · 763 | 56.31% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-time-neighbor-90 | -32.78% / 2.92% / 0.009 | -38.57% / -0.179 | -24.41% / 0.172 | 0/6 / 1/6 · 800 | 58.77% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-4h-time-neighbor-110 | -32.48% / 3.22% / -0.067 | -31.69% / -0.062 | -25.76% / 0.073 | 0/6 / 1/6 · 732 | 55.80% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-atr | -58.46% / -21.62% / -0.717 | -87.59% / -2.514 | -58.05% / -0.938 | 0/6 / 1/6 · 7127 | 90.85% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-atr-neighbor-90 | -58.50% / -21.65% / -0.693 | -90.17% / -2.910 | -68.77% / -1.628 | 0/6 / 1/6 · 7264 | 91.51% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-atr-neighbor-110 | -55.98% / -19.13% / -0.614 | -87.35% / -2.477 | -62.65% / -1.133 | 0/6 / 1/6 · 7011 | 89.36% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-trailing | -61.86% / -25.01% / -1.041 | -89.20% / -3.295 | -65.09% / -1.502 | 0/6 / 0/6 · 7590 | 90.24% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-trailing-neighbor-90 | -60.73% / -23.88% / -1.029 | -90.21% / -3.531 | -67.78% / -1.747 | 0/6 / 0/6 · 7801 | 91.18% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-trailing-neighbor-110 | -57.90% / -21.05% / -0.810 | -88.73% / -3.113 | -65.25% / -1.431 | 0/6 / 0/6 · 7447 | 89.73% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-time | -57.44% / -20.60% / -0.783 | -86.98% / -2.782 | -73.01% / -1.763 | 0/6 / 1/6 · 6925 | 89.48% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-time-neighbor-90 | -72.99% / -36.14% / -1.662 | -91.73% / -3.632 | -68.00% / -1.336 | 0/6 / 0/6 · 7392 | 93.08% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-1h-time-neighbor-110 | -58.27% / -21.43% / -0.803 | -88.12% / -2.872 | -66.30% / -1.104 | 0/6 / 0/6 · 6558 | 89.99% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-atr | -99.69% / -62.64% / -7.934 | -100.00% / -14.250 | -99.42% / -7.140 | 0/6 / 0/6 · 26619 | 100.00% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-atr-neighbor-90 | -99.73% / -62.68% / -8.061 | -100.00% / -14.466 | -99.44% / -7.673 | 0/6 / 0/6 · 27145 | 100.00% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-atr-neighbor-110 | -99.70% / -62.64% / -8.018 | -100.00% / -14.337 | -99.45% / -7.242 | 0/6 / 0/6 · 26220 | 100.00% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-trailing | -99.40% / -62.35% / -7.222 | -99.99% / -14.674 | -99.11% / -6.758 | 0/6 / 0/6 · 25533 | 99.99% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-trailing-neighbor-90 | -99.42% / -62.37% / -7.437 | -100.00% / -14.956 | -99.14% / -6.919 | 0/6 / 0/6 · 25761 | 100.00% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-trailing-neighbor-110 | -99.36% / -62.31% / -6.916 | -99.99% / -14.161 | -99.10% / -6.652 | 0/6 / 0/6 · 25393 | 99.99% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-time | -99.54% / -62.49% / -7.336 | -100.00% / -14.195 | -99.15% / -6.479 | 0/6 / 0/6 · 24922 | 100.00% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-time-neighbor-90 | -99.72% / -62.67% / -8.197 | -100.00% / -15.685 | -99.28% / -7.010 | 0/6 / 0/6 · 26579 | 100.00% / 0.00% / 0.000 | 未通过 / 未通过 |
| r2a-crypto-range-15m-time-neighbor-110 | -99.41% / -62.36% / -6.854 | -99.99% / -13.390 | -99.14% / -6.698 | 0/6 / 0/6 · 23469 | 99.99% / 0.00% / 0.000 | 未通过 / 未通过 |

逐项失败代码（完整逐窗和原始字段见scoreboard产物）：

- r2a-crypto-dual-ma-day-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-day-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-day-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-day-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-day-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-day-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-day-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-day-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-day-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-range-day-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-crypto-dual-ma-4h-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-range-4h-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-1h-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。
- r2a-crypto-range-15m-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, multiple-testing-dsr-0.95。

## 旧对照组合与分仓（全期描述数据）

以下旧组合没有独立滚动、留出及两项压力的证据。新旧口径均不允许晋级；全期数据不能冒充留出。旧分仓只冻结了条件收益、回撤和有效日数，未记录的夏普差、成交数不填0。它们及所有旧分仓试验向量仍进入同一个DSR试验族。

| 对照/配置/层级 | 份额 | 全期收益/原始超额/夏普差 | 回撤 | 相关性/共同有效日 | 新/旧资格 |
|---|---|---|---|---|---|
| prior20/default/组合 | {"swing":0.75,"breakout":0.25} | 43.60% / -804.08% / -0.443 | 81.98% | 0.393 / 2508 | 缺独立OOS/留出/压力，不晋级 / 同左 |
| prior20/default/swing | 75.00% | 840.03% / 未记录 / 未记录 | 69.24% | 有效日2508 | 缺独立OOS/留出/压力，不晋级 / 同左 |
| prior20/default/breakout | 25.00% | -99.76% / 未记录 / 未记录 | 99.76% | 有效日2508 | 缺独立OOS/留出/压力，不晋级 / 同左 |
| prior20/comparison/组合 | {"swing":0.8,"breakout":0.19999999999999996} | 98.85% / -748.83% / -0.353 | 80.63% | 0.401 / 2508 | 缺独立OOS/留出/压力，不晋级 / 同左 |
| prior20/comparison/swing | 80.00% | 820.01% / 未记录 / 未记录 | 69.11% | 有效日2508 | 缺独立OOS/留出/压力，不晋级 / 同左 |
| prior20/comparison/breakout | 20.00% | -99.81% / 未记录 / 未记录 | 99.81% | 有效日2508 | 缺独立OOS/留出/压力，不晋级 / 同左 |
| prior1638/default/组合 | {"swing":1,"low-zone":0} | -2.57% / -14.37% / -0.023 | 66.72% | 0.528 / 4093 | 缺独立OOS/留出/压力，不晋级 / 同左 |
| prior1638/default/swing | 100.00% | -85.34% / 未记录 / 未记录 | 90.39% | 有效日4094 | 缺独立OOS/留出/压力，不晋级 / 同左 |
| prior1638/default/low-zone | 0.00% | 1159.05% / 未记录 / 未记录 | 47.86% | 有效日4093 | 缺独立OOS/留出/压力，不晋级 / 同左 |
| prior1638/comparison/组合 | {"swing":0.65,"low-zone":0.35} | -12.29% / -24.09% / -0.047 | 66.18% | 0.532 / 4094 | 缺独立OOS/留出/压力，不晋级 / 同左 |
| prior1638/comparison/swing | 65.00% | -85.38% / 未记录 / 未记录 | 90.28% | 有效日4094 | 缺独立OOS/留出/压力，不晋级 / 同左 |
| prior1638/comparison/low-zone | 35.00% | 1245.83% / 未记录 / 未记录 | 47.49% | 有效日4094 | 缺独立OOS/留出/压力，不晋级 / 同左 |

## 固定420序列的已完成前N只原生对照

共9行。留出范围2023-06-29—2026-11-13。收益、超额、夏普差均为扣费策略对同窗基准；压力列为绝对收益/夏普差；最大DD跨OOS、留出和两项压力取最坏值。正窗列新/旧均保留，原始超额不是新口径晋级条件。

| 候选 | 留出收益/超额/夏普差 | 成本×2 收益/夏普差 | 延迟 收益/夏普差 | 新正窗/旧正窗·闭合交易 | 最坏DD/邻域/DSR | 新/旧判定 |
|---|---|---|---|---|---|---|
| r2a-cn-equity-chan-third-buy-atr | -8.27% / -12.95% / -0.364 | -10.85% / -0.435 | -23.96% / -0.798 | 2/6 / 3/6 · 479 | 25.36% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-atr-neighbor-90 | -11.33% / -16.01% / -0.460 | -14.27% / -0.545 | -22.56% / -0.778 | 2/6 / 3/6 · 482 | 25.91% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-atr-neighbor-110 | -10.02% / -14.70% / -0.416 | -13.01% / -0.501 | -26.57% / -0.875 | 1/6 / 2/6 · 475 | 27.68% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-trailing | -3.11% / -7.79% / -0.351 | -9.67% / -0.603 | -15.84% / -0.852 | 0/6 / 1/6 · 512 | 18.50% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-trailing-neighbor-90 | 1.20% / -3.48% / -0.204 | -5.33% / -0.447 | -15.61% / -0.874 | 1/6 / 2/6 · 519 | 16.50% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-trailing-neighbor-110 | -2.73% / -7.41% / -0.308 | -9.66% / -0.554 | -18.34% / -0.911 | 1/6 / 2/6 · 511 | 20.03% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-time | -4.65% / -9.33% / -0.306 | -12.14% / -0.533 | -18.95% / -0.755 | 0/6 / 1/6 · 493 | 24.85% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-time-neighbor-90 | -10.59% / -15.27% / -0.494 | -16.85% / -0.700 | -17.58% / -0.723 | 0/6 / 1/6 · 501 | 25.22% / 100.00% / 0.000 | 未通过 / 未通过 |
| r2a-cn-equity-chan-third-buy-time-neighbor-110 | -6.41% / -11.09% / -0.345 | -16.74% / -0.660 | -15.58% / -0.616 | 0/6 / 1/6 · 485 | 26.84% / 100.00% / 0.000 | 未通过 / 未通过 |

逐项失败代码（完整逐窗和原始字段见scoreboard产物）：

- r2a-cn-equity-chan-third-buy-atr：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-atr-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-atr-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-trailing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-trailing-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-trailing-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-time：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-time-neighbor-90：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。
- r2a-cn-equity-chan-third-buy-time-neighbor-110：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, multiple-testing-dsr-0.95。

原生有效观测总数103：固定420序列的前96只用于全市场对照，另外按预定规则补7只，使中证800完成交集达到30只。累计已落盘采集耗时69.1分钟（含补足，异常退出未落盘工作另记）。完成前缀按原序列，补足按事先固定符号顺序，不看收益选择。子集以2010年前已有足够预热的证券为主，存在年龄及流动性选择偏差，不能推广至整个市场或800成分。v22没有append接口，仍为逐前缀O(n²)；三只全历史逐bar完全一致，仅减少请求表和解码。

## A股共享账户组合与条件分仓

共6行。留出范围2025-06-03—2026-11-13。收益、超额、夏普差均为扣费策略对同窗基准；压力列为绝对收益/夏普差；最大DD跨OOS、留出和两项压力取最坏值。正窗列新/旧均保留，原始超额不是新口径晋级条件。

| 候选 | 留出收益/超额/夏普差 | 成本×2 收益/夏普差 | 延迟 收益/夏普差 | 新正窗/旧正窗·闭合交易 | 最坏DD/邻域/DSR | 新/旧判定 |
|---|---|---|---|---|---|---|
| book-cn-dynamic-0-30-35-40 | 33.57% / 26.29% / 0.703 | 34.26% / 0.720 | 35.05% / 0.739 | 4/6 / 4/6 · 1454 | 32.00% / 100.00% / 0.000 | 未通过 / 未通过 |
| sleeve-cn-dynamic-0-30-35-40-swing | 63.39% / 56.12% / 0.960 | 67.39% / 1.004 | 64.98% / 0.976 | 5/6 / 5/6 · 1302 | 42.67% / 0.00% / 0.000 | 未通过 / 未通过 |
| sleeve-cn-dynamic-0-30-35-40-low-zone | -7.54% / -14.23% / -0.544 | -9.53% / -0.651 | -3.89% / -0.403 | 3/6 / 3/6 · 152 | 31.40% / 0.00% / 0.000 | 未通过 / 未通过 |
| book-cn-static-65-35 | 35.24% / 27.97% / 0.704 | 37.47% / 0.755 | 39.35% / 0.799 | 4/6 / 4/6 · 1457 | 31.91% / 100.00% / 0.000 | 未通过 / 未通过 |
| sleeve-cn-static-65-35-swing | 58.38% / 51.11% / 0.882 | 63.94% / 0.952 | 62.21% / 0.929 | 5/6 / 5/6 · 1309 | 43.09% / 0.00% / 0.000 | 未通过 / 未通过 |
| sleeve-cn-static-65-35-low-zone | -8.47% / -15.74% / -0.610 | -9.47% / -0.675 | -2.05% / -0.344 | 3/6 / 4/6 · 148 | 31.86% / 0.00% / 0.000 | 未通过 / 未通过 |

逐项失败代码（完整逐窗和原始字段见scoreboard产物）：

- book-cn-dynamic-0-30-35-40：新 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95；旧 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。
- sleeve-cn-dynamic-0-30-35-40-swing：新 drawdown-bound, parameter-neighborhood, insufficient-complete-market-cycles, low-zone-input-confidence, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95；旧 drawdown-bound, parameter-neighborhood, insufficient-complete-market-cycles, low-zone-input-confidence, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。
- sleeve-cn-dynamic-0-30-35-40-low-zone：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, insufficient-complete-market-cycles, low-zone-input-confidence, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, insufficient-complete-market-cycles, low-zone-input-confidence, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。
- book-cn-static-65-35：新 drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。
- sleeve-cn-static-65-35-swing：新 drawdown-bound, parameter-neighborhood, insufficient-complete-market-cycles, low-zone-input-confidence, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95；旧 drawdown-bound, parameter-neighborhood, insufficient-complete-market-cycles, low-zone-input-confidence, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。
- sleeve-cn-static-65-35-low-zone：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, insufficient-complete-market-cycles, low-zone-input-confidence, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, drawdown-bound, holdout-positive-excess, parameter-neighborhood, insufficient-complete-market-cycles, low-zone-input-confidence, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。

## BTC/ETH共享账户组合与条件分仓

共9行。留出范围2025-06-01—2026-11-14。收益、超额、夏普差均为扣费策略对同窗基准；压力列为绝对收益/夏普差；最大DD跨OOS、留出和两项压力取最坏值。正窗列新/旧均保留，原始超额不是新口径晋级条件。

| 候选 | 留出收益/超额/夏普差 | 成本×2 收益/夏普差 | 延迟 收益/夏普差 | 新正窗/旧正窗·闭合交易 | 最坏DD/邻域/DSR | 新/旧判定 |
|---|---|---|---|---|---|---|
| book-crypto-75-25 | -10.54% / 24.18% / -1.100 | -14.17% / -1.661 | -7.34% / -0.763 | 0/6 / 4/6 · 2434 | 21.28% / 0.00% / 0.000 | 未通过 / 未通过 |
| sleeve-crypto-75-25-swing | -7.19% / 27.53% / -0.831 | -5.23% / -0.718 | -3.08% / -0.326 | 0/6 / 4/6 · 322 | 12.76% / 0.00% / 0.000 | 未通过 / 未通过 |
| sleeve-crypto-75-25-breakout | -20.45% / 14.27% / -0.752 | -36.69% / -1.857 | -19.63% / -0.710 | 0/6 / 3/6 · 2112 | 43.10% / 0.00% / 0.000 | 未通过 / 未通过 |
| book-crypto-80-20 | -9.87% / 24.85% / -1.085 | -12.44% / -1.542 | -6.50% / -0.710 | 0/6 / 4/6 · 2434 | 19.58% / 0.00% / 0.000 | 未通过 / 未通过 |
| sleeve-crypto-80-20-swing | -7.19% / 27.53% / -0.831 | -5.23% / -0.718 | -3.08% / -0.327 | 0/6 / 4/6 · 322 | 12.75% / 0.00% / 0.000 | 未通过 / 未通过 |
| sleeve-crypto-80-20-breakout | -20.44% / 14.28% / -0.751 | -36.69% / -1.856 | -19.63% / -0.710 | 0/6 / 3/6 · 2112 | 43.10% / 0.00% / 0.000 | 未通过 / 未通过 |
| book-crypto-70-30 | -11.21% / 23.51% / -1.099 | -15.87% / -1.750 | -8.19% / -0.799 | 0/6 / 4/6 · 2434 | 22.94% / 0.00% / 0.000 | 未通过 / 未通过 |
| sleeve-crypto-70-30-swing | -7.20% / 27.52% / -0.832 | -5.24% / -0.718 | -3.08% / -0.326 | 0/6 / 4/6 · 322 | 12.77% / 0.00% / 0.000 | 未通过 / 未通过 |
| sleeve-crypto-70-30-breakout | -20.45% / 14.27% / -0.752 | -36.69% / -1.857 | -19.63% / -0.711 | 0/6 / 3/6 · 2112 | 43.10% / 0.00% / 0.000 | 未通过 / 未通过 |

逐项失败代码（完整逐窗和原始字段见scoreboard产物）：

- book-crypto-75-25：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。
- sleeve-crypto-75-25-swing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。
- sleeve-crypto-75-25-breakout：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。
- book-crypto-80-20：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。
- sleeve-crypto-80-20-swing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。
- sleeve-crypto-80-20-breakout：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。
- book-crypto-70-30：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95；旧 cost-or-delay-stress, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。
- sleeve-crypto-70-30-swing：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95；旧 parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。
- sleeve-crypto-70-30-breakout：新 oos-positive-risk-adjusted-majority, cost-or-delay-stress, drawdown-bound, holdout-positive-risk-adjusted, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95；旧 oos-positive-excess-majority, cost-or-delay-stress, drawdown-bound, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。

组合全部使用看结果前固定ATR预设：A股RPS+低位动态0/30/35/40及静态65/35；加密4h双均线+1h突破，75/25、80/20、70/30，共用原生15m执行时钟，时间止损按周期长度换算、站立止损逐15m监控。分仓为真实共享账户中的条件收益，先扣资金转入转出再算TWR，首次获得资金之前为null；不能把独立回测按权重平均。组合/分仓有独立滚动、留出和压力分数，但分配对照不等于退出参数邻域验证，保守阻断该项晋级。相关性及划拨见books产物。

每个独立验证段初始100万（A股人民币、数字货币USDT），不跨市场换算或合账。冻结等额槽位为波段10、短线3、低位5并分3批；分仓单笔风险上限波段/短线2%、低位10%，还受等额槽位与可用现金约束。这些是研究预设，应用提醒默认风险/份额未修改。只调拨闲置现金：静态配置每20根执行bar到期或偏离5%触发（A股约20交易日，crypto15m时钟约5小时）；动态目标在每个目标输入日也触发，A股动态逐日给目标，因此每日均可调拨。对应条件是 due || drift || target.date===date，不强卖持仓。延迟压力推迟择时信号1根执行bar，站立保护仍执行；组合crypto延迟1根=15分钟，单策略按其原生周期，不混作相同时长。

## 全市场337只终止覆盖敏感性

排除=1638只；最后价和零值=1975只。估值只在终止覆盖日调整会计持仓并释放情景现金，不伪造市场成交或退市回收款。下表完整重跑各候选全期与原留出；不把它描述为已跑两套额外滚动/压力资格。按2b最新指示，这是稳健性参考，不阻断中证800主口径；当前258只执行子集已排除终止覆盖；800原名单仍有sz000831这1个尾部覆盖异常，不能把缺行情当成退市，也不能宣称800数据齐备。当前名单另有历史成分前视。全期/留出差异也受新增证券争用共享现金影响。
恢复的337只中，67只在2010研究起点前已结束行情，没有研究期可交易bar；另270只至少有1根研究期bar。输入名单保留全部337只，没有为无行情证券补造价格。

### 波段敏感性

| 候选 | 排除 全期/留出收益 | 最后价 全期/留出收益 | 零值 全期/留出收益 | 留出敏感区间 |
|---|---|---|---|---|
| r2a-cn-equity-rps-multi-atr | -89.07% / -21.65% | -90.39% / -21.65% | -90.39% / -21.65% | -21.65%—-21.65% |
| r2a-cn-equity-rps-multi-atr-neighbor-90 | -88.67% / -59.97% | -89.42% / -59.97% | -89.42% / -59.97% | -59.97%—-59.97% |
| r2a-cn-equity-rps-multi-atr-neighbor-110 | -96.13% / -32.82% | -91.11% / -32.82% | -91.11% / -32.82% | -32.82%—-32.82% |
| r2a-cn-equity-rps-multi-trailing | -83.24% / 9.57% | -83.24% / 9.57% | -83.24% / 9.57% | 9.57%—9.57% |
| r2a-cn-equity-rps-multi-trailing-neighbor-90 | -54.18% / 10.13% | -53.31% / 10.13% | -53.31% / 10.13% | 10.13%—10.13% |
| r2a-cn-equity-rps-multi-trailing-neighbor-110 | -86.06% / -7.96% | -86.01% / -7.96% | -86.01% / -7.96% | -7.96%—-7.96% |
| r2a-cn-equity-rps-multi-time | -95.86% / -29.90% | -95.89% / -29.90% | -95.89% / -29.90% | -29.90%—-29.90% |
| r2a-cn-equity-rps-multi-time-neighbor-90 | -97.34% / -38.42% | -98.41% / -38.42% | -98.41% / -38.42% | -38.42%—-38.42% |
| r2a-cn-equity-rps-multi-time-neighbor-110 | -96.90% / -37.95% | -96.90% / -37.95% | -96.90% / -37.95% | -37.95%—-37.95% |
| r2a-cn-equity-double-breakout-atr | -49.63% / -54.38% | -50.51% / -46.51% | -62.72% / -46.51% | -54.38%—-46.51% |
| r2a-cn-equity-double-breakout-atr-neighbor-90 | -64.30% / -51.48% | -62.89% / -48.67% | -71.17% / -48.67% | -51.48%—-48.67% |
| r2a-cn-equity-double-breakout-atr-neighbor-110 | -46.40% / -63.31% | -54.59% / -54.94% | -65.77% / -54.94% | -63.31%—-54.94% |
| r2a-cn-equity-double-breakout-trailing | 97.40% / -14.95% | 100.82% / -16.98% | 52.88% / -16.98% | -16.98%—-14.95% |
| r2a-cn-equity-double-breakout-trailing-neighbor-90 | 187.32% / 4.58% | 71.86% / -7.25% | 17.60% / -7.25% | -7.25%—4.58% |
| r2a-cn-equity-double-breakout-trailing-neighbor-110 | 128.47% / -15.98% | 4.52% / -33.64% | -22.39% / -33.64% | -33.64%—-15.98% |
| r2a-cn-equity-double-breakout-time | -63.22% / -42.66% | -62.22% / -47.71% | -69.63% / -47.71% | -47.71%—-42.66% |
| r2a-cn-equity-double-breakout-time-neighbor-90 | -51.39% / -22.75% | -11.35% / -19.85% | -38.61% / -19.85% | -22.75%—-19.85% |
| r2a-cn-equity-double-breakout-time-neighbor-110 | 6.83% / -28.14% | -47.78% / -40.71% | -62.69% / -40.71% | -40.71%—-28.14% |
| r2a-cn-equity-formula-ma-atr | -36.03% / -11.54% | -78.63% / -9.01% | -84.40% / -9.01% | -11.54%—-9.01% |
| r2a-cn-equity-formula-ma-atr-neighbor-90 | -45.80% / -20.35% | -83.74% / -29.87% | -90.47% / -29.87% | -29.87%—-20.35% |
| r2a-cn-equity-formula-ma-atr-neighbor-110 | -45.71% / -14.26% | -79.09% / -29.34% | -87.56% / -29.34% | -29.34%—-14.26% |
| r2a-cn-equity-formula-ma-trailing | -31.39% / 5.16% | -60.22% / -13.92% | -68.69% / -13.92% | -13.92%—5.16% |
| r2a-cn-equity-formula-ma-trailing-neighbor-90 | 1.37% / 5.60% | -68.46% / -0.57% | -76.21% / -0.57% | -0.57%—5.60% |
| r2a-cn-equity-formula-ma-trailing-neighbor-110 | -22.02% / -0.30% | -52.02% / -5.62% | -67.73% / -5.62% | -5.62%—-0.30% |
| r2a-cn-equity-formula-ma-time | -60.92% / -8.34% | -90.45% / -33.86% | -93.85% / -33.86% | -33.86%—-8.34% |
| r2a-cn-equity-formula-ma-time-neighbor-90 | -63.28% / -15.77% | -86.43% / -26.29% | -92.00% / -26.29% | -26.29%—-15.77% |
| r2a-cn-equity-formula-ma-time-neighbor-110 | -72.08% / -2.58% | -87.91% / -29.47% | -90.95% / -29.47% | -29.47%—-2.58% |
| r2a-cn-equity-formula-range-atr | -93.38% / -59.57% | -93.33% / -60.32% | -93.33% / -63.40% | -63.40%—-59.57% |
| r2a-cn-equity-formula-range-atr-neighbor-90 | -95.74% / -48.62% | -97.56% / -56.11% | -97.56% / -59.19% | -59.19%—-48.62% |
| r2a-cn-equity-formula-range-atr-neighbor-110 | -89.03% / -54.77% | -90.91% / -56.04% | -92.07% / -56.04% | -56.04%—-54.77% |
| r2a-cn-equity-formula-range-trailing | -61.34% / 9.13% | -38.19% / -5.27% | -38.19% / -5.27% | -5.27%—9.13% |
| r2a-cn-equity-formula-range-trailing-neighbor-90 | -38.10% / 53.99% | -42.37% / 36.66% | -42.37% / 36.66% | 36.66%—53.99% |
| r2a-cn-equity-formula-range-trailing-neighbor-110 | -71.60% / -9.24% | -82.89% / -2.18% | -86.24% / -11.61% | -11.61%—-2.18% |
| r2a-cn-equity-formula-range-time | -89.99% / -46.77% | -97.37% / -43.23% | -97.67% / -43.23% | -46.77%—-43.23% |
| r2a-cn-equity-formula-range-time-neighbor-90 | -96.93% / -61.96% | -96.86% / -54.11% | -97.00% / -53.47% | -61.96%—-53.47% |
| r2a-cn-equity-formula-range-time-neighbor-110 | -94.48% / -50.92% | -97.21% / -43.17% | -97.30% / -49.50% | -50.92%—-43.17% |
| r2a-cn-equity-formula-pullback-atr | -84.87% / -26.62% | -81.27% / -33.74% | -83.10% / -33.74% | -33.74%—-26.62% |
| r2a-cn-equity-formula-pullback-atr-neighbor-90 | -72.97% / -27.80% | -81.29% / -38.84% | -87.96% / -38.84% | -38.84%—-27.80% |
| r2a-cn-equity-formula-pullback-atr-neighbor-110 | -74.22% / -14.15% | -78.10% / -25.27% | -81.92% / -25.27% | -25.27%—-14.15% |
| r2a-cn-equity-formula-pullback-trailing | -65.88% / 10.21% | -66.49% / 15.36% | -77.74% / 15.36% | 10.21%—15.36% |
| r2a-cn-equity-formula-pullback-trailing-neighbor-90 | -46.67% / 45.72% | -50.75% / 43.55% | -63.80% / 43.55% | 43.55%—45.72% |
| r2a-cn-equity-formula-pullback-trailing-neighbor-110 | -52.59% / 3.03% | -42.28% / 8.47% | -58.38% / 8.47% | 3.03%—8.47% |
| r2a-cn-equity-formula-pullback-time | -73.38% / -22.10% | -80.92% / -27.91% | -83.11% / -27.91% | -27.91%—-22.10% |
| r2a-cn-equity-formula-pullback-time-neighbor-90 | -76.17% / -13.27% | -82.26% / -26.75% | -85.89% / -26.75% | -26.75%—-13.27% |
| r2a-cn-equity-formula-pullback-time-neighbor-110 | -82.60% / -3.50% | -75.55% / -15.50% | -79.97% / -15.50% | -15.50%—-3.50% |

### 低位长线敏感性（单列）

| 候选 | 排除 全期/留出收益 | 最后价 全期/留出收益 | 零值 全期/留出收益 | 留出敏感区间 |
|---|---|---|---|---|
| r2a-cn-equity-historical-low-atr | 1504.46% / 64.50% | 90.90% / 7.71% | 61.50% / 18.67% | 7.71%—64.50% |
| r2a-cn-equity-historical-low-atr-neighbor-90 | 1179.22% / 94.74% | 93.64% / 42.37% | 67.56% / 21.41% | 21.41%—94.74% |
| r2a-cn-equity-historical-low-atr-neighbor-110 | 1443.24% / 83.57% | 161.87% / 23.51% | 96.43% / 30.96% | 23.51%—83.57% |
| r2a-cn-equity-historical-low-trailing | 1124.92% / 70.67% | 310.18% / 11.67% | 156.66% / -7.41% | -7.41%—70.67% |
| r2a-cn-equity-historical-low-trailing-neighbor-90 | 1161.59% / 84.54% | 259.81% / 39.13% | 74.91% / 10.14% | 10.14%—84.54% |
| r2a-cn-equity-historical-low-trailing-neighbor-110 | 1659.87% / 86.56% | 337.50% / 43.36% | 107.82% / 15.84% | 15.84%—86.56% |
| r2a-cn-equity-historical-low-time | 1833.56% / 99.43% | 274.25% / 40.70% | 153.53% / 2.35% | 2.35%—99.43% |
| r2a-cn-equity-historical-low-time-neighbor-90 | 1637.73% / 99.43% | 365.03% / 40.70% | 217.60% / 2.35% | 2.35%—99.43% |
| r2a-cn-equity-historical-low-time-neighbor-110 | 1123.52% / 99.43% | 356.14% / 40.70% | 233.94% / 2.35% | 2.35%—99.43% |

完整三情景回撤、交易数、夏普差与各终值结算条目见scoreboard与sensitivity产物；价量低位的财富效应不构成去除幸存者偏差后的盈利证据。若某变体终止日没有持仓，两种终值可能相同；0次终值结算不能证明没有幸存者偏差。新增证券改变共享现金竞争，即使从未持有至终止日，也可能改变收益路径。
低位ATR例：排除口径全期1504.46%，恢复后最后价90.90%、零值61.50%，高收益对筛选口径敏感。留出最后价7.71%、228笔成交/64笔闭合交易；零值18.67%、235笔成交/66笔闭合交易。两个恢复情景的信号计数均为入场7974/离场404582，但实际成交路径不同。零值收益并非必然最差；这是共享资金重跑，不是固定成交后只减一笔终值的单调对照，不能将两个情景作线性损失分解。

## 最接近的五项与份额建议

先按未满足的规则代码数排序，再按留出夏普差降序、ID兜底；组合代码可能包含多个条件，逐项差距见下表。

- **csi800/r2a-cn-equity-rps-multi-atr-neighbor-110**：drawdown-bound, multiple-testing-dsr-0.95。差距（严格大于0，null为不可得）：

| 条件 | 实际 | 门槛 | 缺口 |
|---|---|---|---|
| OOS窗口 | 6 | ≥3 | 0 |
| 新口径正窗口 | 5/6 (83.33%) | ≥60% | 0.00% |
| 成本×2正窗口 | 66.67% | ≥60% | 0.00% |
| 延迟正窗口 | 83.33% | ≥60% | 0.00% |
| OOS闭合交易 | 1267 | ≥30 | 0 |
| 最坏回撤 | 46.22% | ≤25% | 21.22% |
| 训练邻域 | 100.00% | ≥50% | 0.00% |
| 全族DSR | 0.000 | ≥0.95 | 0.950 |
| 留出扣费收益 | 77.03% | >0 | 0 |
| 留出夏普差 | 1.175 | >0 | 0 |
| 留出成本×2扣费收益 | 82.27% | >0 | 0 |
| 留出成本×2夏普差 | 1.239 | >0 | 0 |
| 留出延迟扣费收益 | 56.23% | >0 | 0 |
| 留出延迟夏普差 | 0.883 | >0 | 0 |


- **csi800/r2a-cn-equity-rps-multi-atr**：drawdown-bound, multiple-testing-dsr-0.95。差距（严格大于0，null为不可得）：

| 条件 | 实际 | 门槛 | 缺口 |
|---|---|---|---|
| OOS窗口 | 6 | ≥3 | 0 |
| 新口径正窗口 | 5/6 (83.33%) | ≥60% | 0.00% |
| 成本×2正窗口 | 66.67% | ≥60% | 0.00% |
| 延迟正窗口 | 83.33% | ≥60% | 0.00% |
| OOS闭合交易 | 1308 | ≥30 | 0 |
| 最坏回撤 | 43.03% | ≤25% | 18.03% |
| 训练邻域 | 100.00% | ≥50% | 0.00% |
| 全族DSR | 0.000 | ≥0.95 | 0.950 |
| 留出扣费收益 | 61.29% | >0 | 0 |
| 留出夏普差 | 0.923 | >0 | 0 |
| 留出成本×2扣费收益 | 63.99% | >0 | 0 |
| 留出成本×2夏普差 | 0.958 | >0 | 0 |
| 留出延迟扣费收益 | 71.45% | >0 | 0 |
| 留出延迟夏普差 | 1.078 | >0 | 0 |


- **csi800/r2a-cn-equity-rps-multi-atr-neighbor-90**：drawdown-bound, multiple-testing-dsr-0.95。差距（严格大于0，null为不可得）：

| 条件 | 实际 | 门槛 | 缺口 |
|---|---|---|---|
| OOS窗口 | 6 | ≥3 | 0 |
| 新口径正窗口 | 4/6 (66.67%) | ≥60% | 0.00% |
| 成本×2正窗口 | 66.67% | ≥60% | 0.00% |
| 延迟正窗口 | 83.33% | ≥60% | 0.00% |
| OOS闭合交易 | 1372 | ≥30 | 0 |
| 最坏回撤 | 53.87% | ≤25% | 28.87% |
| 训练邻域 | 100.00% | ≥50% | 0.00% |
| 全族DSR | 0.000 | ≥0.95 | 0.950 |
| 留出扣费收益 | 37.20% | >0 | 0 |
| 留出夏普差 | 0.544 | >0 | 0 |
| 留出成本×2扣费收益 | 34.42% | >0 | 0 |
| 留出成本×2夏普差 | 0.489 | >0 | 0 |
| 留出延迟扣费收益 | 42.53% | >0 | 0 |
| 留出延迟夏普差 | 0.630 | >0 | 0 |


- **csi800/r2a-cn-equity-rps-multi-time-neighbor-90**：cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。差距（严格大于0，null为不可得）：

| 条件 | 实际 | 门槛 | 缺口 |
|---|---|---|---|
| OOS窗口 | 6 | ≥3 | 0 |
| 新口径正窗口 | 4/6 (66.67%) | ≥60% | 0.00% |
| 成本×2正窗口 | 66.67% | ≥60% | 0.00% |
| 延迟正窗口 | 33.33% | ≥60% | 26.67% |
| OOS闭合交易 | 1815 | ≥30 | 0 |
| 最坏回撤 | 50.74% | ≤25% | 25.74% |
| 训练邻域 | 100.00% | ≥50% | 0.00% |
| 全族DSR | 0.000 | ≥0.95 | 0.950 |
| 留出扣费收益 | 90.85% | >0 | 0 |
| 留出夏普差 | 1.191 | >0 | 0 |
| 留出成本×2扣费收益 | 95.21% | >0 | 0 |
| 留出成本×2夏普差 | 1.208 | >0 | 0 |
| 留出延迟扣费收益 | 31.60% | >0 | 0 |
| 留出延迟夏普差 | 0.425 | >0 | 0 |


- **csi800/r2a-cn-equity-double-breakout-trailing-neighbor-110**：cost-or-delay-stress, drawdown-bound, multiple-testing-dsr-0.95。差距（严格大于0，null为不可得）：

| 条件 | 实际 | 门槛 | 缺口 |
|---|---|---|---|
| OOS窗口 | 6 | ≥3 | 0 |
| 新口径正窗口 | 4/6 (66.67%) | ≥60% | 0.00% |
| 成本×2正窗口 | 50.00% | ≥60% | 10.00% |
| 延迟正窗口 | 66.67% | ≥60% | 0.00% |
| OOS闭合交易 | 1369 | ≥30 | 0 |
| 最坏回撤 | 28.06% | ≤25% | 3.06% |
| 训练邻域 | 100.00% | ≥50% | 0.00% |
| 全族DSR | 0.000 | ≥0.95 | 0.950 |
| 留出扣费收益 | 42.39% | >0 | 0 |
| 留出夏普差 | 1.078 | >0 | 0 |
| 留出成本×2扣费收益 | 37.55% | >0 | 0 |
| 留出成本×2夏普差 | 0.940 | >0 | 0 |
| 留出延迟扣费收益 | 34.31% | >0 | 0 |
| 留出延迟夏普差 | 0.848 | >0 | 0 |


### A股份额依据

- book-cn-dynamic-0-30-35-40：留出净收益33.57%、夏普差0.703；成本×2净收益34.26%，延迟净收益35.05%。新口径未通过，失败：drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。
- book-cn-static-65-35：留出净收益35.24%、夏普差0.704；成本×2净收益37.47%，延迟净收益39.35%。新口径未通过，失败：drawdown-bound, insufficient-complete-market-cycles, low-zone-input-confidence, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。

### BTC/ETH份额依据

- book-crypto-75-25：留出净收益-10.54%、夏普差-1.100；成本×2净收益-14.17%，延迟净收益-7.34%。新口径未通过，失败：oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。
- book-crypto-80-20：留出净收益-9.87%、夏普差-1.085；成本×2净收益-12.44%，延迟净收益-6.50%。新口径未通过，失败：oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。
- book-crypto-70-30：留出净收益-11.21%、夏普差-1.099；成本×2净收益-15.87%，延迟净收益-8.19%。新口径未通过，失败：oos-positive-risk-adjusted-majority, cost-or-delay-stress, holdout-positive-risk-adjusted, parameter-neighborhood, allocation-comparison-not-exit-parameter-neighborhood, multiple-testing-dsr-0.95。

BTC/ETH组合的三组份额均未解决留出亏损，不能因80/20相对少亏就宣称最佳配置。15m突破毛收益41.90万，被费用76.73万及滑点38.36万吞噬，净亏73.19万（固定实际成交归因）。建议短线突破研究份额暂设0或仅影子观察；限BTC/ETH不足以解决高周转成本。0份额本身未做组合回测，不给它虚构收益，也不把释放资金自动转入4h波段；后者仍须独立通过资格与前向观察。

A股动态与静态组合的实际留出数列如上；单段静态65/35表现不能证明低位35%有可靠优势。低位只有2轮完整中证800周期，且缺可靠时点输入，不因高历史收益建议真实加仓。BTC/ETH仍沿用冻结的波段10槽位，两品种最多占两个等额槽，份额上限不等于满仓暴露；没有事后改成2槽。所有份额只是研究建议，应用默认设置未修改。

## 重放、校验与边界

引擎核验见`.test-data/r2a4/engine-audit-gate.json`；逐候选进度指针和gzip SHA随delivery交接。原R2a3的94个gzip均通过原hash/build/JSON验证，没有坏检查点；原95文件先无损重包，保留原压缩字节SHA与映射，不放宽100文件/4GiB/256MiB/8GiB上限。native、CSI、官方源、337只输入均单独冻结；代码计算身份不混用历史结果build。

研究脚本必须设置绝对QUANT_DATA_DIR为本任务data；不得使用默认生产库。单文件校验、非法数据与毫秒/微秒、已完成live/归档替换、零值/最后价、T+1/跳空等已做固定输入验证。真实七阶段检查、desktop:prepare、P0浏览器和BarStore计时以delivery.gates最终记录为准，不以本段代替退出码。无数据库迁移；不替换正式包、不发通知、不下单、不提交或推送。任务清理脚本默认预演，持久归档和重放输入保留。

## 本次交付检查与清理

七阶段 pnpm check --build 全部退出0；主工程6509通过、27既有跳过，四个包分别104/19/69/14通过。desktop:prepare退出0；P0浏览器16/16通过。最终静态检查全部0。完整失败、断言调整理由及退出码见delivery.gates，保留首次失败日志。

同一5921证券/18350108根完整历史基准：无研究任务并发时，原价8.284秒（限8.4），前复权13.465秒（限13.5），原价信号一致、无读取错误。前复权距上限仅约35毫秒，这是无研究并发时的单次实测。并发研究时首测超限已单列保留；不把脚本退出0冒充性能通过，也未放宽预算。

最终研究产物89/100个、1.014GiB/4GiB，最大展开文件198.5MiB/256MiB；官方1240对ZIP/CHECKSUM全部再核验。清理预演后实际移除4015个一次性文件、581.4MiB，包括测试夹具、可再生BarStore缓存和过时中间件；保留原始官方归档、冻结输入、检查点、原生观测、隔离成绩单库及简短校验证据，未动正式包、共享输入或凭证。

成绩单仅发布至隔离研究库；真实通知、交易、提交、推送、正式打包均为0。没有改提醒live模式或应用默认份额。

另清理验证包装脚本生成的一次性系统临时目录：1994个文件、405.8MiB；以及本轮收尾辅助脚本2个。默认预演清理脚本及精确目标/执行结果保留在任务目录。
