# 组合与交易账本

## 职责与非职责

portfolio 持有用户导入/录入的成交、现金流和组合复盘；trade ledger 与 signal ledger 是不同事实域。研究回测不写入真实账本；同花顺模拟盘动作只经显式用户请求，不能由信号触发。

## 入口与消费者

- 页面：`src/app/trade-ledger/page.tsx`、`trade-review/page.tsx`、`signal-ledger/page.tsx`；组件在 `src/components/portfolio/` 与相关工作台组件。
- 服务：`src/server/portfolio/` 包含交割单导入、持仓、风险、成本/执行质量、交易复盘和 discipline；存储依赖 `DeliveryStore`、账本 store 与 `src/server/db/`。
- API：`delivery*`、`tradeReview*`、`discipline*`、`signal-ledger*` 和现金/执行质量 procedure 目前装配在 root router。
- 影响账本的公司行动读取来自行情/数据源层；同花顺模拟盘适配器是显式外部边界。

## 契约与依赖

成交/现金流水及导入批次是事实；信号关联是可选来源说明。复权、成本、可卖数量、红利和费用不得通过 UI 复制行或默认值丢失。账号、文件 hash、导入/撤销、分页和导出是可观察契约。portfolio 可读 market/calendar 与纯计算，不反向依赖页面状态。

## 状态、副作用与验证

SQLite 表包括 `trade_ledger`、`trade_adjustments`、`trade_fills`、`cash_flows`、`import_batches` 等；模拟盘会产生第三方请求，仅在用户明确动作中发生。代表测试：[p1-trade-ledger](../../tests/portfolio-ledger/p1-trade-ledger.test.ts)、[delivery-store](../../tests/research-backtest/delivery-store.test.ts)、[trade-review-service](../../tests/portfolio-ledger/trade-review-service.test.ts)、[cash-adjusted-signals](../../tests/portfolio-ledger/cash-adjusted-signals.test.ts)。

## 维护指南

新持仓字段要贯穿导入/更新、store、服务端计算、UI 和导出；保留来源与审计信息。任何 DB schema 改动需独立迁移、隔离验证并报告打包应用需更新；无授权不调用真实/模拟交易外部动作。
