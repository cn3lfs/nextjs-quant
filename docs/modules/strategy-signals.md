# 策略与信号

## 职责与非职责

策略域按流派运行研究或确定性规则；监控域比较订阅策略与基线、判断新鲜度并产生订阅信号；全市场 signal ledger 形成每日观察样本。它们不拥有原始行情解析或账本成交事实，也不自动下单。两条信号路线保持分离：监控可走已授权通知 outbox，signal ledger 只记录与回填。

## 入口与消费者

Workbench 的监控连接表单通过 `src/components/signals/notification-policy-fields.tsx` 配置通知策略；字段组件由 strategy-signals 持有，工作台负责连接状态组装。

- UI：策略/信号页面，`src/components/signals/`、`src/components/intraday/`。
- 服务：`src/server/strategies/{breakout,chan,canslim,wyckoff,value,...}/`、`src/server/monitoring/`。
- API：`breakout`、`czsc`、`chanAnalyze/History/Report`、`canslimAnalyze/History/Report`、`wyckoff*`、`monitors`、`signals`、`intraday*`、`signal-ledger*` 等 procedure 目前位于总 router。
- 包边界：`packages/trading-strategy-core` 仅放无 IO 核心；`packages/trading-strategies` 放九方向代表与证据元数据。完整运行编排仍在 server。

## 契约与依赖

策略输入明确证券、日期、周期、规则版本和数据来源；缺少必要证据时保留“数据不足”。method ID、preset ID、代表策略 ID 不可互换。CZSC 需经单一宿主进程的串行队列访问 DLL。策略依赖行情与纯规则；监控/ledger 依赖 strategy、jobs 和各自 store；通知只由显式启用订阅授权。

## 状态、副作用与验证

写入订阅配置、信号、观测、结果和 outbox；可能调用 CZSC worker、数据源和授权通知渠道。代表测试：[czsc](../../tests/strategy-signals/methods/chan/czsc.test.ts)、[breakout](../../tests/strategy-signals/methods/breakout/breakout.test.ts)、[m4-monitor](../../tests/strategy-signals/monitoring/m4-monitor.test.ts)、[signal-ledger-worker](../../tests/strategy-signals/signals/signal-ledger-worker.test.ts)、[intraday-worker](../../tests/strategy-signals/intraday/intraday-worker.test.ts)。不得从回测/台账规则正确推断策略盈利；关键约束见 [invariants](../invariants.md)。

## 维护指南

方法/预设变更需同步 strategy catalog、来源证据和固定样本；调整通知必须保留显式订阅与零外发测试；不得并发打开 DLL，也不得把模型解释接为执行信号。
