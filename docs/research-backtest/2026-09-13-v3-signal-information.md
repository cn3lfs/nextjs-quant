# 任务书 V3：信号台账的信息含量

V 系列第 3 批。与 V1/V2 无耦合，不依赖回测链路。

## 1. 问题

信号台账已经积累了两样东西：连续评分 `LedgerSignal.score` 和 T+5/10/20 的
`Outcome.returnPct`（`src/lib/signal-ledger.ts`）。`aggregateLedger` 目前按
`strategy:quality` 分组给中位数、胜率、盈亏比。

这回答了「这一组信号后来涨了没有」，**没有回答「评分高的是不是真的更好」**。
后者才决定评分值不值得信：如果评分与后续收益毫无单调关系，那么 `score`
就是个装饰数字，据它排序选股与随机挑没有区别。

同理，5/10/20 三个持有期现在是三张独立的表，看不出**信息衰减**的形状——
而衰减形状直接决定持有期该设多长。

## 2. 交付

### 2.1 `src/lib/signal-information.ts`（新建，纯函数，无 IO）

输入 `readonly LedgerRow[]`，输出分组结果。**分组键必须是
`strategy × direction × horizon`**，理由见 §2.4。

**（a）横截面 RankIC**

按 `observedDate` 分横截面。每个截面内：

- 参与样本 = 该截面内 `settled === true` 且 `returnPct !== null` 的行
- 截面样本数 `< 5` → 该日留空 + reason「截面样本不足」，**不并入相邻日**
- `rankIC` = score 与 returnPct 的 **Spearman 相关**（先转秩再求 Pearson），
  并列取平均秩
- 截面内 score 全同或 returnPct 全同 → 留空 + reason「截面内取值无差异」

IC 序列汇总：

| 字段 | 定义 |
| --- | --- |
| `icMean` | IC 均值 |
| `icStd` | IC 标准差（ddof=1） |
| `icir` | `icMean / icStd` |
| `icTStat` | `icMean / (icStd / √k)`，k 为有效截面数 |
| `positiveRatio` | IC > 0 的截面占比 |
| `sections` | 有效截面数 / 总截面数 |

`k < 10` 时 `icTStat` 仍算但必须带 reason 字段说明「截面数不足，t 值不可靠」。
**不要因为样本少就返回 null**——这里有数字比没数字有用，但必须带警告。

**（b）评分分层**

按 score 升序分 `Q` 组（默认 5）。样本不足时按规则降级并明示：
每组期望样本 `< 10` 则 Q 降为 3；仍 `< 10` 则整组留空 + reason。
输出每组：`count`、`meanReturn`、`medianReturn`、`winRate`、`scoreRange`。

单调性：组序号与组均值收益的 Spearman 相关 `monotonicity`，以及
`topMinusBottom`（最高组均值 − 最低组均值）。

**分组边界必须用全样本分位数，不是等宽区间**；score 并列跨越边界时，
并列值整体归入较低组，并记 `tiedBoundary: true`。

**（c）持有期衰减**

同一 `strategy × direction` 下，把 5/10/20 的 `icMean` 与 `topMinusBottom`
并排输出为 `decay` 数组。**不做拟合、不外推**——三个点拟合衰减常数是假精确。

### 2.2 排除与计数（必须逐类可见）

以下样本**不参与**计算，且每类的被排除条数必须出现在输出里：

- `settled === false`（未到期）
- `returnPct === null`（含除权、停牌、价格缺失等，按 `reasons` 分类计数）
- `action === "含除权，收益不可比"`
- 同一 `symbol × observedDate × strategy` 重复信号（取 `id` 最小者，计数重复条数）

### 2.3 口径红线

- **不把 short 信号的 returnPct 取反。** `signal-ledger.ts:103` 的注释已经写明：
  空头观察不是可执行的做空组合，取反就是虚构一条不存在的盈亏。
  分方向出结果，`direction === "short"` 的解释文案必须写「价格变化方向，
  不是做空收益」
- 不做任何显著性结论文案（"有效/无效"）。只给 IC、t 值、分层表和衰减，
  判断留给人
- 不引入行业/市值中性化——本仓库没有可信的时点行业归属（V4 会说明为什么）

### 2.4 为什么分方向分组

多空混在一个截面里算 IC，会把「空头信号评分高 → 价格跌 → returnPct 为负」
算成负相关，从而抵消多头的正相关。混算出来的数接近零，但它什么都没说明。

### 2.5 接入

信号台账页面新增「信息含量」区块：IC 汇总表、分层表、衰减三点表。
沿用既有服务端分页模式；排除计数与 reason 分布必须同屏可见，
不折叠进 tooltip——这些数字决定上面那些指标能不能信。

## 3. 测试（`tests/signal-information.test.ts` 新建）

- **Spearman 手算**：5 对 (score, return)，含一组并列，注释写出秩与算式，1e-12
- **完全单调**：构造评分与收益完全同序的样本，断言 `rankIC = 1`、
  `monotonicity = 1`、`topMinusBottom > 0`
- **完全无关**：构造 IC 期望为 0 的对称样本，断言 |icMean| < 1e-12
- **截面门槛**：4 条的截面留空 + reason；5 条的截面参与
- **方向隔离**：同一批样本，long 正相关、short 也"正相关"（价格跌、评分高→
  returnPct 负），断言两组分别输出且**合并后的数不出现在任何字段里**
- **除权排除**：含除权样本不进分子且在排除计数里可见
- **重复信号**：同 symbol+date+strategy 两条，断言只取一条并计数
- **分层降级**：样本 40 条 → Q=5 每组 8 < 10 → 降为 Q=3；样本 20 条 → 整组留空
- **并列边界**：score 大量并列跨越分位点，断言整体归低组且 `tiedBoundary = true`
- **k<10 警告**：断言 t 值有值且带 reason

## 4. 验收

- 三个分组维度齐全（strategy × direction × horizon），无任何混方向聚合
- 排除四类计数全部可见
- 不新增依赖、不新增迁移
- `aggregateLedger` 一行不改（新模块并存，不替换）
- `invariants.md` 补一条：空头 returnPct 不取反、截面门槛、分层降级规则
- `pnpm typecheck` / `pnpm test` / 改动文件 prettier 通过
