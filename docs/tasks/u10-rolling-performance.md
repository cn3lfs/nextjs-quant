# 任务书 U10：滚动绩效

依赖 [U1](u1-daily-performance.md)（已合入）。排期第 2 位，成本低、复用度高。

来源：[wbt](https://github.com/zengbin93/wbt) `src/core/rolling_daily_performance.rs`。

## 1. 问题

我们现在所有绩效数字都是**单一全样本**的：一个夏普、一个最大回撤、一个 IR。
U2 补了 8 个固定分段，但那些是「过去 N 天」的锚定窗口，
回答不了「这个策略是一直这样，还是最近才变好/变坏的」。

单一全样本数字最容易骗人的地方在于：一段极好的行情 + 一段平庸，
和全程稳定，可以给出**完全相同**的夏普。滚动窗口把这两者分开。

U1 已经把 17 项指标收敛成一个入口，滚动只是换一批输入反复调它，
所以这批的实现成本很低——不要因为便宜就把口径做松。

## 2. 交付

新建 `src/lib/rolling-performance.ts`（纯函数，无 IO）。

### 2.1 窗口用交易日，不用自然日

wbt 用 `edt - Duration::days(window)` 再 `partition_point`，是**自然日**窗口。
我们沿用 U2 已定的口径：**交易日**（`aSharePeriodTradingDays` 那套思路），
默认窗口 **60 个交易日**（约一季度），可配。

理由与 U2 §2.1 相同，写进 `invariants.md` 时引用那一条，不要重复论证。

### 2.2 不要把缺失当零

**wbt 这一行不能照抄**：

```rust
.map(|(d, r)| (d, if r.is_nan() { 0.0 } else { r }))
```

它把 NaN 直接当 0，等于宣称「这天不赚不亏」。
我们的规则是 `invariants.md §5`「宁可留空，不可给假数」。

做法：

- null 日**不参与**计算，直接透传给 U1 由它剔除并计入 `coverage`
- 每个窗口返回自己的 `coverage`（观察日数 / 可得日数 / null 日数）
- 窗口内可得日占比低于 **60%** 时，整窗标 `insufficientCoverage: true`；
  指标照算但页面必须显示这个标记。阈值放具名常量，不硬编码在组件里

### 2.3 输出

```ts
export type RollingPoint = {
  endDate: string;
  startDate: string;
  tradingDays: number;
  insufficientCoverage: boolean;
  // U1 的完整 17 项 + coverage，直接内嵌，不做第二份指标实现
};
```

- 前 `minPeriods` 个点跳过（默认等于窗口长度，即第一个点就是满窗）
- 允许 `minPeriods < window`，此时前几个点是不满窗的，
  必须在 `tradingDays` 里如实反映，**不要补齐、不要外推**
- 指标全部来自 U1（`invariants.md §1`），`grep` 不到第二份实现

### 2.4 接入

- `/trade-review`：账户日收益的滚动绩效
- `/research`：策略样本的滚动绩效；与 U6 的三段并存，不互相替代

图表优先展示**夏普 / 最大回撤 / 年化**三条随时间的曲线（复用 `chart.tsx`
已有能力，不新增图表库）；完整 17 项走表格，**服务端分页**
（1265 个交易日会产生上千个滚动点，沿用 U2/U3 已建的分页模式）。

## 3. 测试

`tests/rolling-performance.test.ts`：

- **窗口边界**：手算一组 10 日序列、窗口 3，逐点核对 `startDate` / `endDate` /
  `tradingDays`，注释写出算式。
- **跨周末与长假**：断言窗口按交易日数而非自然日推进。
- **null 不当零**：构造窗口内含 null 的序列，断言
  ①该窗口指标与「剔除 null 后直接调 U1」逐项相等；
  ②`coverage.nullDays` 正确；
  ③**不存在任何路径把 null 变成 0**（对照 wbt 的做法写一条反例断言）。
- **覆盖率门槛**：可得占比 59% / 60% / 61% 三个边界，断言 `insufficientCoverage`。
- **指标同源**：任取一个窗口，与直接对同一子序列调 U1 的结果逐项相等。
- **不满窗**：`minPeriods < window` 时前几点的 `tradingDays` 如实小于窗口长度。

## 4. 验收

- 窗口按交易日推进，跨周末/长假有测试。
- null 全程不被当作 0，有对照 wbt 做法的反例断言。
- 指标全部来自 U1。
- 滚动点走服务端分页，页面无障碍树不因点数增长而爆炸。
- `invariants.md` 补一条：滚动窗口口径、覆盖率门槛、以及
  「与 wbt 的差异：它把 NaN 当 0，我们留空」。
- 不新增迁移、不新增依赖。
- `pnpm typecheck` / `pnpm test` / `pnpm format:check` 通过。

## 5. 明确不做

- 不做滚动窗口的自动最优长度搜索——那是对历史的曲线拟合。
- 不用滚动结果驱动任何判定（U8 的准入只看全样本与三段，不看滚动）。
- 不新增图表库。
