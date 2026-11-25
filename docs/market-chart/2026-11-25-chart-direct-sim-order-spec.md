# 看盘直接模拟下单 — 功能规格说明（Feature Spec）

> **规模定级**：**M**（跨 A 股 / 数字货币 / 期货三大看盘视图的统一模拟下单流，涉及新增期货模拟轻账本与统一看盘下单弹窗，沿用仓库 `docs/<模块>/YYYY-MM-DD-<主题>.md` 文档规范）。
> **参与角色**：产品经理（`product-delivery`）、系统设计（实体与接口契约）、交互与界面设计（复用 `DESIGN.md` / 现有组件库）、测试设计（用例矩阵）。架构师跳过原因：复用既有 `sim-accounts` 本地模拟账本、`mock-trading-service` 同花顺模拟通道及现有 `records` 存储，不引入新进程、外部服务或 SQLite 表结构破坏性变更。

---

## 1. 背景与目标

- **当前痛点**：用户在「A 股看盘」「数字货币」「期货行情」盯盘看到买点/卖点时，无法在图表页直接下模拟单，必须切走去「持仓复盘 / 本地模拟盘」重新手输代码、价格、数量；且「期货行情」完全没有模拟账本承接双向开平仓。
- **成功指标**：
  - 用户在三大看盘页点击 1 次「模拟下单」即可弹出预填好**当前标的 + 最新参考价**的下单弹窗；
  - 30 秒内可完成「选账户 → 填/点选仓位 → 预览费用/资金/风控校验 → 确认成交」闭环；
  - 所有模拟成交即时沉淀至模拟账本（可在「持仓复盘 / 模拟账户」完整查看持仓、资金与成交记录），且**绝不误触实盘通道**。
- **范围边界（MoSCoW）**：
  - **Must**：
    - `R1` A 股看盘直接模拟下单（支持本地模拟账户，且开启同花顺模拟时可同窗切换同花顺模拟账户）
    - `R2` 数字货币看盘直接模拟下单（对接本地 USDT 模拟账户，支持小数数量与 7×24 T+0）
    - `R3` 期货看盘直接模拟下单（新增轻量期货模拟账本，支持双向开多/平多/开空/平空、按合约币种 CNY/USD 隔离、保证金与盈亏结算）
    - `R4` 统一安全交互：两步确认（预览 → 确认）、快捷仓位换算、无模拟账户时窗内一键创建默认模拟账户、防重复提交幂等键
  - **Should**：下单弹窗展示当前标的在所选账户的现有持仓、可卖/可平数量与可用资金；支持快捷键/一键回填最新价。
  - **Won't（本期不做）**：看盘直接下真实实盘单（实盘仍严格隔离并须人工授权）、止盈止损条件单自动撮合引擎、期货跨期移仓换月自动结算。

---

## 2. 需求与验收标准（Requirements）

### `R1` A 股看盘直接模拟下单
作为 A 股交易者，我希望在「A 股看盘」工具栏直接发起当前股票的模拟买入/卖出，以便看到缠论/双突破/形态突破买点时立即模拟建仓或止盈止损。
- `R1.1` **GIVEN** 在「A 股看盘」加载了一只可交易 A 股（`sh/sz/bj` 6 位代码，非大盘指数/板块）**WHEN** 点击工具栏「模拟下单」**THEN** 打开下单弹窗，自动预填当前股票代码、中文名与最新收盘/实时参考价，且默认选中本地模拟通道。
- `R1.2` **GIVEN** 当前看盘标的为大盘指数或板块代码 **WHEN** 查看工具栏 **THEN**「模拟下单」按钮禁用并提示「指数与板块不支持下单」。
- `R1.3` **GIVEN** 选定本地 A 股模拟账户并输入买入/卖出数量与价格 **WHEN** 点击「预览模拟成交」**THEN** 严格校验 100 股整数倍、可用资金/T+1 可卖数量，展示预估佣金/过户费/印花税/滑点及成交后资金；点击「确认模拟成交」后写入账本并刷新持仓与可用资金。
- `R1.4` **GIVEN** 已开启同花顺模拟盘 **WHEN** 在弹窗通道切换选择「同花顺模拟」**THEN** 可走同花顺模拟两步流程（预览 60 秒过期 → 确认发送远程模拟委托并展示委托号）；未开启时给出明确引导链接。

### `R2` 数字货币看盘直接模拟下单
作为数字货币观察者，我希望在「数字货币」看盘页直接对当前交易对下 USDT 现货模拟单。
- `R2.1` **GIVEN** 在「数字货币」看盘加载了 `BTCUSDT` 等交易对 **WHEN** 点击「模拟下单」**THEN** 打开弹窗，自动预填当前交易对与最新 K 线收盘价，仅列出 `crypto / USDT` 活跃模拟账户。
- `R2.2` **GIVEN** 输入小数数量（最多 8 位小数）或点击快捷比例按钮（25%/50%/100%）**WHEN** 预览并确认成交 **THEN** 按 T+0 现货规则扣除/增加 USDT 资金与持仓并记录明细。

### `R3` 期货看盘直接模拟下单
作为商品期货观察者，我希望在「期货行情」页对当前连续合约下双向（多/空）模拟单并跟踪模拟持仓与保证金。
- `R3.1` **GIVEN** 在「期货行情」加载了国内（如 `fuAUM` 沪金，CNY）或境外（如 `fuGC00Y` COMEX 黄金，USD）合约 **WHEN** 点击「模拟下单」**THEN** 打开期货模拟下单弹窗，自动预填当前合约名称、价格单位、币种（CNY/USD）与最新参考价。
- `R3.2` **GIVEN** 选择方向「开多 / 平多 / 开空 / 平空」、手数/数量（正整数）与保证金比例（默认 10%，可调 5%–100%）**WHEN** 点击「预览模拟委托」**THEN** 清晰计算合约名义价值、占用/释放保证金、手续费（默认万分之 1）及平仓预估实现盈亏；校验可用保证金与可平持仓。
- `R3.3` **GIVEN** 点击「确认模拟成交」**THEN** 按 `clientRequestId` 幂等写入期货模拟账本（支持 T+0 当日开平），刷新当前合约多/空持仓与可用资金，并可在「持仓复盘 / 本地模拟盘」中查看期货模拟账户明细。

### `R4` 统一零死胡同与安全底线
- `R4.1` **GIVEN** 当前市场尚未创建任何活跃模拟账户 **WHEN** 打开看盘「模拟下单」弹窗 **THEN** 弹窗内直接提供「一键创建默认模拟账户」（A 股 1,000,000 CNY / 数字货币 10,000 USDT / 期货 1,000,000 CNY 或 100,000 USD），创建后自动选中，无需跳离图表页。
- `R4.2` **GIVEN** 用户在预览后修改了价格、数量、方向或账户 **WHEN** 未重新预览 **THEN**「确认成交」按钮自动失效，防止按旧预览误下单。
- `R4.3` **GIVEN** 任何看盘下单操作 **THEN** 仅限模拟通道，明确标注「模拟盘 · 非真实券商委托」，绝不触发实盘通道或绕过实盘总开关。

---

## 3. 系统与接口设计（System Design）

### 实体与存储（`E1`–`E3`）
- **A 股 & 数字货币**：完全复用现有 `sim_accounts` / `sim_orders` / `sim_fills` / `sim_cash_flows` 与 `mock-trading-service.ts`，零表结构改动。
- **期货模拟轻账本（`E1: FuturesSimAccount`, `E2: FuturesSimPosition`, `E3: FuturesSimTrade`）**：
  - 存储在既有 SQLite `records` 表（`kind = "futures-sim-account"` / `"futures-sim-ledger"`），无需破坏性 DDL 迁移，完全隔离于 `sim_accounts` 的 `CHECK(market IN ('cn-equity','crypto'))`；
  - 账户按币种隔离（`currency: "CNY" | "USD"`），记录 `initialCapital`、`cash`（可用资金）、`frozenMargin`（占用保证金）、`realizedPnl`；
  - 持仓按 `(symbol, side: "long" | "short")` 独立记录 `quantity`（整数手/单位）、`avgEntryPrice`、`margin`、`marginRate`；
  - 所有金额与价格使用 `Big`（十进制精确计算，杜绝浮点精度误差），`clientRequestId` 去重防双击重复成交。

### 业务规则（`BR1`–`BR4`）
- `BR1` 币种严格隔离：国内期货（单位含 `元/`）仅允许 `CNY` 期货模拟账户；境外期货（单位含 `美元/`）仅允许 `USD` 期货模拟账户。
- `BR2` 保证金与平仓校验：开仓（`buy_open` / `sell_open`）要求 `cash >= requiredMargin + fee`；平仓（`sell_close` 平多 / `buy_close` 平空）要求对应方向持仓 `quantity >= orderQuantity`，平仓按加权均价释放比例保证金并结算盈亏 `(price - avgEntryPrice) * qty * (long ? 1 : -1) - fee`。
- `BR3` 两步确认防漂移：客户端维护输入快照键 `currentKey`，任何表单字段变化立即清空预览状态。
- `BR4` A 股复权价防呆：A 股看盘若处于前/后复权视图，下单弹窗默认优先带入「原始未复权最新价 / 实时盘口价」，若仅可见复权价则显式标注提示用户核对原价。

### tRPC 接口扩展（`A1`–`A4`，挂载于 `src/server/api/routers/sim-accounts.ts`）
- `A1` `futuresSimAccountsList` (`portfolio/read`)：返回期货模拟账户列表与持仓汇总。
- `A2` `futuresSimAccountCreate` (`portfolio/configure`)：创建 CNY 或 USD 期货模拟账户（含初始资金）。
- `A3` `futuresSimOrderPreview` (`portfolio/read`)：校验合约/币种/保证金/可平仓位并返回预览明细。
- `A4` `futuresSimOrderConfirm` (`portfolio/configure`)：幂等执行期货模拟成交并更新账户与持仓。

---

## 4. 交互与界面设计（UI/UX）

- **入口位置（零占空、不破坏主图布局）**：
  - `F1` **A 股看盘**（`src/components/workbench/market-view.tsx`）：在图表顶部工具栏「加入自选」旁放 1 个紧凑按钮 `模拟下单`（`size="sm"`, `variant="default"` 或 `outline`）；
  - `F2` **数字货币看盘**（`src/components/market/crypto-view.tsx`）：在 `panel-toolbar` 周期切换旁放紧凑按钮 `模拟下单`；
  - `F3` **期货行情**（`src/components/market/futures-view.tsx`）：在 `panel-toolbar` 周期切换旁放紧凑按钮 `模拟下单`；
- **统一下单弹窗（`ChartSimOrderDialog`）**：
  - 顶部展示标的中文名/代码、最新参考价（点击可一键回填价格框）及显著 `模拟交易` 标签；
  - A 股模式顶部支持在「本地模拟账户」与「同花顺模拟账户」之间一键切换；
  - 提供快捷数量按钮：A 股支持 `100股 / 500股 / 1/4仓 / 1/2仓 / 全仓`（自动向下取整到 100 股整数倍；卖出支持 `1/2 / 全卖`）；数字货币支持 `25% / 50% / 100%`；期货支持 `1手 / 5手 / 10手` 与四向选择（`开多 / 平多 / 开空 / 平空`）；
  - 无可用账户时显示内联快捷建户按钮；
  - 底部固定「预览模拟成交」→ 预览摘要卡 →「确认模拟成交」两步流，成功后展示成交回执并提供「查看模拟账户 →」链接。

---

## 5. 测试计划（Test Plan）

- `TC1` (`R1.1`, `R1.2`, `R1.3`)：A 股看盘对 `sh600519` 打开下单弹窗预填标的与未复权价；对 `sh000300` 指数禁用下单；100 股快捷仓位向下取整正确。
- `TC2` (`R2.1`, `R2.2`)：数字货币看盘对 `cxBTCUSDT` 打开弹窗过滤仅显示 `crypto/USDT` 账户并支持小数快捷仓位计算。
- `TC3` (`R3.1`, `R3.2`, `R3.3`)：期货模拟服务完整闭环——创建 CNY/USD 账户、开多 → 部分平多盈利、开空 → 平空亏损、保证金不足拒绝、超平拒绝、跨币种（CNY 账户买 COMEX USD 合约）拒绝、`clientRequestId` 重放幂等不重复扣款。
- `TC4` (`R4.1`, `R4.2`, `R4.3`)：无模拟账户时展示一键建户；修改输入后旧预览失效；不含任何实盘下单路径。

---

## 6. 任务拆解（Tasks → Wave 8）

- `T1` (`futures-sim-backend` → `R3`, `BR1–BR2`, `A1–A4`)：新增 `src/lib/portfolio/futures-sim.ts`、`src/server/portfolio/futures-sim-service.ts`，扩展 `src/server/api/routers/sim-accounts.ts`。
- `T2` (`chart-sim-order-ui` → `R1`, `R2`, `R3`, `R4`, `F1–F3`)：新增 `src/components/market/chart-sim-order-dialog.tsx`（并增强 `SimOrderForm` 支持快捷仓位与一键建户），接入 `market-view.tsx`、`crypto-view.tsx`、`futures-view.tsx` 以及在 `parallel-accounts-hub.tsx` 增设期货模拟持仓查看入口。
- `T3` (`wave8-tests` → `TC1–TC4`)：新增 `tests/portfolio-ledger/futures-sim-service.test.ts` 与 `tests/market-chart/chart-sim-order-dialog.test.ts`。
- `T4` (`wave8-sol-review`)：只读全面 Review（财务精确计算、防重放幂等、币种隔离、复权价提示、无实盘旁路）。
