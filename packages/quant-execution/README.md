# quant-execution

纯 TypeScript 执行账本：订单、成交、费用、持仓批次与公司行动。无应用、数据库、网络或 UI 依赖。

- `ExecutionLedger` 接收已定数量的 `OrderIntent`，默认次根开盘成交，按 T+1、整手、涨跌停、停牌与成交量规则拒绝。
- 金额与数量使用整数原子（bigint）；A 股 money=2/quantity=0，加密 money=8/quantity=8，price=8。
- `CostRates` 分项记录佣金、过户费、印花税；滑点体现为成交价格冲击，不另记现金费用。
- `applyExternalFill` 供真实成交/交割单对账；不模拟成交。
