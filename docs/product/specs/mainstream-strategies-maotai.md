# 主流策略库与茅台十年横向实验

2026-11-08用户取消五种策略限制，要求使用主流常用量化策略并沿用上次茅台回测。本轮扩展独立quant-backtest包的离线日线规则，不改变应用菜单、弃用策略生命周期、数据库或发布目录。

## 范围与覆盖

数量不作为永久上限。当前实现39项规则和2项持有对照，覆盖趋势、通道突破、时序动量、趋势回调、超卖反转、量价、仓位管理和季节性。每项为固定可复现的代表实现，不声称所有历史策略存在一个有限清单，也不把不同均线参数算成不同流派。

完整名称、公式、参数及预热声明见[策略目录](../../../packages/trading-strategies/src/study-catalog.ts)，信号见[规则模块](../../../packages/trading-strategies/src/study-rules.ts)。报告逐项输出规则及缺口表，并导出strategies.csv。

| 流派 | 本轮规则 |
| --- | --- |
| 趋势 | 原MA5/20、MA200、MA50/200、EMA12/26、三均线20/60/120、MACD12/26/9、DMI/ADX14、Supertrend10×3、SAR、一目均衡、吊灯ATR退出 |
| 突破 | 原唐奇安55/20、海龟20/10简化、布林趋势突破、肯特纳通道、Dual Thrust日线确认 |
| 时序动量 | 120日、250日、250日跳过近20日、RSI14动量 |
| 回调与反转 | 原趋势回调、原布林横盘回归、RSI14超卖、RSI2趋势低吸、KDJ低位交叉、CCI20、Williams %R14、5日反转、BIAS20 |
| 量价 | MFI14反转、OBV趋势、放量20日突破、Chaikin资金流20 |
| 仓位 | 原底仓网格、15%目标波动、80/20恒定比例、CPPI、12个月分批建仓 |
| 日历 | 11月至次年4月持有 |
| 对照 | 100%持有、80%持有加20%现金 |

横截面选股/多因子、配对/统计套利、市场中性、期现/期权/转债套利、carry、跨资产配置、事件驱动、机器学习及高频需要不同标的、数据和执行模型，目录studyCoverageGaps逐项列出所缺证据。单只茅台无法检验横截面选股，单资产波动控制不是风险平价。既有缠论、威科夫、CANSLIM、SEPA仍保留原实现及弃用状态，本轮不将其简化为指标并宣称完整复活。

## 统一实验口径

沿用[上次实验](classic-strategies-maotai.md)的2016-11-08至2026-11-06、100万元初始本金、双边佣金万一/最低5元、卖出税费万五。只做多、无借款、100股整手；收盘请求，下一交易日开盘撮合；每日最多一个方向。分红隔离、税前经济权益、不复投；未复权价格成交，现金后复权价格产生信号；收盘确认止损，不模拟盘中价或保证止损成交价。

新规则用300日预热，原七组对照仍裁出原140日起点，保留递推种子及原成交路径。输入冻结完整300日预热；每项回显实际预热数。先固定规则再运行，不按结果调参或删除差策略。保留5/10bp重撮合、固定路径额外费用和统一20%分红税敏感性。旧档案不覆盖；不足300日的旧冻结输入不能静默执行长周期策略。

### 公式和变体

- MA、EMA、RSI、BOLL、ATR、MACD、KDJ和OBV复用共享指标。RSI为既定Wilder递推首个价差种子；BOLL用样本标准差；ATR用完整TR算术均值。新CCI用典型价及平均绝对偏差，MFI用典型价涨跌分类的价格乘原始量，%R与CMF见目录。CMF零振幅日乘数0；无量窗口留空。MFI/CMF不是可观测机构资金流。
- DMI用完整14日TR及方向变动均值初始化，再以1/14平滑；ADX从完整14个有效DX开始。Supertrend使用算术ATR，初始有效状态为多头，再按最终上下带延续/反转。SAR用前两日高低钳位、AF0.02至0.20。云层在t只引用t-26计算的先行带，不反向使用未来绘图位置或迟行线。
- 海龟为日线只做多20/10与入场时2ATR止损代表，不含原系统加仓、组合风险预算或失败突破跳过规则。Dual Thrust为排除本日的前4日范围、当日收盘确认，下一日开盘交易，不冒称原日内反手系统。250/20为交易根数近似12减1月；单股正负择时与横截面动量组合不同。
- 二元择时无加仓；实际入场后记录复权成本，退出全卖。吊灯退出使用入场以来最高收盘减3ATR22，不是最高盘中价或日内止损版本。没有通用止损的趋势规则不额外叠加8%止损。

### 仓位与资金

目标股数在已完成收盘用未复权价和可投资资产计算，向下取100股整手；下一开盘跳空使实际权重偏离，买入仍受实际现金及费用约束，不提前用下一日价格产生信号。可投资资产仅现金加股票，不计隔离分红。实际成交才改账户，0整手调整不记拒单。

- 目标波动：初次决策及每周五收盘调整；年化显式252，目标15%，最高100%；波动0时100%，未知不下单。不替代真实节假日周末前调仓日历。
- 恒定比例：初始及每个自然月首次观察时股票目标80%；受阻且仍有差额则下个观察日重算重试，成交后当月不重复。80%持有不调仓单列对照。
- CPPI：固定现金底线为初始本金80%，乘数3；股票金额为min(资产,3×max(资产-底线,0))，每日观察；底线无利息、不滚动上调，跳空可能跌破，不承诺保本。
- 分批建仓：100万元期初全部在账户，无外部入金。每月最多花初始本金1/12（含佣金），每月最多一笔成功、最多12笔；无整手或开盘受阻则重试，不把失败算作已投入。余款继续为现金，分红不用于建仓。

## 复现与验收

backtest-maotai-classics.ts --suite mainstream --out 新目录只读通达信；--suite classic保留旧七项集合。--replay input.json完全离线；输出目录存在即拒绝，避免覆盖冻结实验。输入/代码/结果哈希、规则、逐日净值/回撤、逐笔成交、拒绝请求、逐年及敏感性保存在仓库外。

报告复用Lightweight Charts，默认显示原五项及两项对照，可按流派/逐项选择或显示全部；表格按本段历史收益排序，仅为浏览，不作为优选依据。独立十进制账本逐日验证费用、资金、持股、分红、净值、总收益和回撤；真实浏览器检查控件及页面错误。持久用例覆盖全部策略未来追加、非法预热、下一开盘及仓位/指标手算。

结果始终rule-check-only：历史公司行动、状态/成交容量及分红支付时点未全部认证。单股事后选样和同段比较不是样本外验证，更多规则会增加多重比较偏差。结果及实际检查见[交付](../../research-backtest/2026-11-08-maotai-mainstream-strategies.md)。

## 公开参照

以下支持范式与指标定义，不为本次固定阈值或收益背书。本地平滑/只做多/日频改编如上，不承诺平台默认数值一致。

- [QuantConnect策略库](https://www.quantconnect.com/docs/v2/writing-algorithms/strategy-library)、[动量与反转](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/behavioral-finance)
- [AQR：Time Series Momentum](https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum)
- [DMI/ADX](https://www.quantconnect.com/docs/v2/writing-algorithms/indicators/supported-indicators/average-directional-index)、[Supertrend](https://www.quantconnect.com/docs/v2/writing-algorithms/indicators/supported-indicators/super-trend)
- [CCI](https://www.quantconnect.com/docs/v2/writing-algorithms/indicators/supported-indicators/commodity-channel-index)、[MFI](https://www.quantconnect.com/docs/v2/writing-algorithms/indicators/supported-indicators/money-flow-index)
