# quant-backtest

纯TypeScript组合事件回放，不依赖应用、数据库、文件、网络或UI。

- `runPortfolio(request)`：版本化策略对象、多标的共享资金、市场规则、sleeve份额/单笔风险/持仓数、分批建仓、闲置现金再平衡。
- 次根开盘成交；保护单按bar内触发，跳空取open；同bar止损与止盈先止损。T+1按批次，数字货币按已知venue步长；缺bar/停牌/涨跌停明确拒绝，退出保留。
- 输出orders/fills/positions/equity（总账与各分仓）/curve/rejections/transfers；评价由quant-performance独立计算。
- `replayFiveMinute`、`replayDailyStudy`、`replayAllocationStudy`是现有页面/研究的具名政策与结果适配，使用共同portfolio-account账本与事件时钟。中证800显式收盘竞价风控实验保留原假设，不宣称标准次开盘成交。
- 应用取数走BarStore：信号前复权，成交原价；纯包消费冻结序列。旧研究输入沿自身记录的现金因果调整或经济权益口径回放。
- 所有输出固定rule-check-only，工程对拍不证明策略盈利。

测试入口：根tests/research-backtest/backtest/portfolio-event.test.ts（跨市场手算/因果/违规反例）、portfolio-parity.test.ts（冻结326d5c7的成交与权益逐笔一致）；包内tests保护原有政策。

费用模板已移至trading-strategy-core/costs，市场规则表归trading-strategy-core/market-rules。旧runBacktest/runMaBaseline/runClassicStudy/runCsi800Study/runStrategyExperiment不再导出。
