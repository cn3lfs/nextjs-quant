# 任务书 U3：Top-N 回撤明细表

依赖 [U1](u1-daily-performance.md)。工作量最小的一批，可与 U2 并行。

来源：[wbt](https://github.com/zengbin93/wbt)（MIT，v0.9.1）
`src/core/top_drawdowns.rs` 与 `daily_performance.rs` 里的
`calc_underwater` / `calc_underwater_valley` / `calc_underwater_peak` /
`calc_underwater_recovery`；czscflow 前端另有一份可读的 TS 实现
`apps/web-antd/src/utils/stats.ts:topDrawdowns`。

**wbt 的 Top-N 提取算法值得照抄**：不是「找出所有回撤段再排序取前 N」，
而是**迭代剥离**——每轮在 underwater 序列上找全局谷底，
回溯到最近的 0 点作为前高，向前找到下一个 0 点作为修复日，
然后把 `[peak, recovery)` 整段置零，再进入下一轮。
这样天然避免了嵌套回撤被重复统计。我们现有的 `drawdowns()` 是单趟扫描，
逻辑不同但结果对「不嵌套的顺序回撤」是一致的；
本批**不替换现有实现**，但要加一条测试证明两者在真实账户上给出相同的最深段。

## 1. 问题

`trade-review-nav.ts` 里已经有一个 `drawdowns()`，返回
`peakDate / troughDate / recoveryDate / recovered / underwaterTradingDays / drawdown`。
数据其实已经够了，但：

1. 它没有排序，也没有 Top-N 截断——真实账户几百段回撤全丢给页面
2. 少了 **恢复天数**（从谷底到修复）这一列，只有「水下总天数」
3. 页面上根本没展示，只在导出 JSON 里
4. czscflow 还多一个 **新高间隔** 列（这项 U1 已经出，此处只需引用）

「最大回撤 30.16%」是一个数字；「哪一段、从哪天跌到哪天、跌了多久、
花了多久修复、还是至今没修复」才是能用来复盘的东西。

## 2. 交付

### 2.1 扩展现有 `drawdowns()`，不新建

`trade-review-nav.ts` 里的实现是对的（包括那个处理浮点 ulp 的
`Math.abs(point.value - peak.value) <= Number.EPSILON * 8 * peak.value`，
别动它）。只做三件事：

1. 每段补 `recoveryTradingDays`（谷底 → 修复日的交易日数，未修复为 `null`）
   和 `drawdownTradingDays`（前高 → 谷底）。
   现有的 `underwaterTradingDays` 保留，语义不变。
2. 返回前按 `drawdown` 降序排序。
3. 未修复的段（`recovered: false`）**永远排在最前**，无论深浅——
   正在水下的那一段才是当前风险。

不做 Top-N 截断：截断在服务端分页层做，数据层给全量。

### 2.2 页面

`/trade-review` 净值卡片下方加「回撤明细」表，用 `DataTable`，
**服务端排序分页**（`conventions.md §4`，沿用 R13 已建的分页入参）。

列：前高日 / 谷底日 / 修复日 / 回撤幅度 / 下跌交易日 / 恢复交易日 / 水下交易日 / 状态。

- 修复日为空时状态显示「未修复」，不显示空白
- 幅度按 U1 的 `basis` 标注口径（compound 是比例，simple 是绝对值）
- 默认只显示 Top 10，「共 N 段，展开查看」用 `ui/collapsible`（R13 已建的模式）

### 2.3 与 U1 的分工

U1 出的「新高间隔」「新高占比」「最大回撤」是**汇总标量**，
U3 出的是**逐段明细**。两者必须互相印证：
U3 里最深那一段的 `drawdown` 必须等于 U1 的「最大回撤」。
这条写成断言，不是写成注释。

注意 U1 §2.6 有**两个**最大回撤（现有基线 / 含 t=0 本金基线）。
U3 的明细沿用**现有基线**，与 `maxDrawdown` 对齐，不与 `maxDrawdownFromCapital` 对齐。

## 3. 测试

`tests/trade-review-nav.test.ts` 里补（不新建文件，回撤是净值的一部分）：

- 手算 fixture：一段完整回撤（跌→谷→修复）、一段未修复回撤、
  连续两段回撤中间只碰到一次新高、单调上涨（零段回撤）。
- 未修复段排在最前的顺序断言。
- **U3 最深段 == U1 最大回撤** 的一致性断言。
- 现有回撤测试一条都不许删或跳过（`conventions.md §6`）。

## 4. 验收

- 真实账户回撤明细可导出、可分页、可折叠，页面无障碍树不因段数增长而爆炸。
- 最深段幅度与已验收的 30.16% 一致。
- 未修复段在最前。
- `pnpm check` 通过；浏览器验收由管理者用真实账户执行。
- 本批不新增迁移。
