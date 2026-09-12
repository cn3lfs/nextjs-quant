# 任务书 V2：回测过拟合概率（PBO / CSCV）

V 系列第 2 批，依赖 [V1](v1-deflated-sharpe.md) 的候选试验矩阵。

口径权威来源：Bailey, Borwein, López de Prado & Zhu，
*The Probability of Backtest Overfitting*（CSCV，2015）与
*Pseudo-Mathematics and Financial Charlatanism*（Notices of the AMS 61(5), 2014）。
**公式以论文为准。**

## 1. 问题

V1 的 DSR 回答的是「这个夏普在 N 次试验下有多可能是运气」。它没有回答另一个问题：
**「按训练期表现挑参数」这个流程本身，在样本外还站不站得住。**

这两件事不一样。DSR 修正的是单个数字，PBO 检验的是**选择规则**：
如果用训练期第一名去预测样本外表现，它落到样本外中位数以下的概率有多大？
PBO 接近 0.5 意味着这套选参流程等于抛硬币——即便某次结果很好看。

`walkForward` 目前完全依赖「训练净收益第一名」这条规则（`walk-forward.ts:83` 的排序），
从未检验过这条规则本身。

## 2. 交付

### 2.1 `src/lib/backtest-overfit.ts`（新建，纯函数，无 IO）

`combinatoriallySymmetricCv({ returns, splits, metric })`：

输入 `returns: (number | null)[][]`（N 个候选 × T 个同期日收益，即 V1
`candidateTrialMatrix` 的 `returns`，**直接复用，不得重新跑回测**）。

> 类型按 V1 交付事实修正（管理者 2026-09-13）：V1 的 `equityDailyReturns` 对非正分母
> 与非法净值返回 `null`，矩阵因此允许 `null`。CSCV 的处理规则：**任一候选在某子段内
> 含 null，则该子段对全部候选整体作废**并计入 `discardedPeriods` 的独立字段
> `nullPeriods`——只对部分候选作废会让排名建立在不同样本上，那比丢掉整段更糟。
> 作废后剩余子段数若为奇数则再丢最后一段（S 必须偶数），这一步要有测试。

算法（逐条实现，不许简化）：

1. 按时间顺序把 T 期切成 `S` 个等长不重叠子段，`S` 必须为偶数，默认 **10**。
   T 不能整除 S 时，**末尾余数丢弃并记入 `discardedPeriods`**，不做拉伸或补齐
2. 枚举全部 `C(S, S/2)` 种「取一半作训练集」的组合（S=10 → 252 组）。
   组合内的子段按原时间顺序拼接；**补集即为样本外**
3. 每个组合：在训练集上按 `metric` 取最优候选 `n*`（默认 metric = 同频夏普，
   复用 V1 的 `sharpeDaily`，**不写第二份**）
4. 求 `n*` 在样本外全部 N 个候选中的升序排名 `rank ∈ [1, N]`，
   相对排名 `ω = rank / (N + 1)`，逻辑值 `λ = ln(ω / (1 − ω))`
5. `pbo = #{λ ≤ 0} / #组合数`

同时输出（成本几乎为零，信息量大）：

- `lambdas: number[]`：完整分布，供页面画直方图
- `performanceDegradation`：样本外表现对训练期表现的一元线性回归
  `{ slope, intercept, r2 }`——斜率 ≤ 0 意味着训练期越好、样本外越差
- `probabilityOfLoss`：`n*` 的样本外 metric < 0 的组合占比

退化，全部 null + reason，**不许给一个看起来正常的数**：

| 情形 | reason |
| --- | --- |
| `N < 2` | 候选不足，无法排名 |
| `S` 为奇数或 < 4 | 子段数必须是不小于 4 的偶数 |
| `T / S` < 20 | 每个子段少于 20 个观测，排名不稳定 |
| 某组合内训练集绩效全部相同 | 训练集无法区分候选 |
| 任一输入非有限 | 输入含非有限数 |

**并列处理**必须显式：训练集最优并列时取候选序号最小者（与 `walkForward` 的
并列排序方向一致）；样本外排名并列时取平均排名。两条都要有测试。

### 2.2 接入

`walkForward` 的 `multipleTesting` 下新增 `overfit` 子对象（仍是只增不改）：

```ts
overfit: {
  splits: number;
  combinations: number;
  discardedPeriods: number;
  pbo: ReviewValue;
  performanceDegradation: { slope: ReviewValue; r2: ReviewValue };
  probabilityOfLoss: ReviewValue;
  lambdas: number[];
}
```

`assumptions` 追加：PBO 检验的是**本系统这条选参规则**（训练净收益第一名），
不是「策略是否有效」；候选集合固定为均线半值/原值/双值，换一组候选 PBO 会变。

### 2.3 页面

`backtest-view.tsx` 「过拟合修正」块内追加一行 PBO 与一行性能衰减斜率。
结论文案同样焊死：

- `pbo ≤ 0.2` →「选参规则在样本外基本保持排序（PBO=x%，仅限当前候选集合）」
- `0.2 < pbo < 0.5` →「选参规则部分失效」
- `pbo ≥ 0.5` →「选参规则在样本外不优于随机，训练期第一名不具备预测力」
- null →「无法判定」+ 原因原文

λ 分布**不画图**（本批不引图表新形态），只给 `pbo` 与三个数字。
`lambdas` 输出保留供导出，但不进页面响应载荷——R13 的载荷教训。

## 3. 测试（`tests/backtest-overfit.test.ts` 新建）

- **组合数**：S=10 → 252；S=4 → 6；断言枚举无重复、每个组合的训练/样本外互补且并集 = 全部子段
- **构造 PBO ≈ 1**：N 个候选，其中一个在前半段人为最优、在后半段人为最差（反相关构造），
  断言 PBO 显著高于 0.5。注释写清构造意图
- **构造 PBO ≈ 0**：一个候选在所有子段一致最优，断言 PBO = 0
- **随机无信息**：同分布独立随机序列（固定种子，自实现线性同余，不引依赖），
  断言 PBO 落在 0.3–0.7，**不断言精确值**
- **性能衰减回归**：给定可手算的 6 点数据，断言 slope/r2 到 1e-9
- **并列**：训练并列取小序号、样本外并列取平均排名，各一条
- **退化五项**：§2.1 表格逐项
- **余数丢弃**：T=105、S=10 → 每段 10、`discardedPeriods = 5`，断言未被拉伸
- **复用锚点**：断言 CSCV 内部用的夏普与 `sharpeDaily` 同值（防第二份实现）
- **特征化护栏**：`walk-forward.test.ts` 既有数值仍逐项相等

## 4. 验收

- 不重新跑 `backtest`，矩阵完全来自 V1
- PBO 与 DSR 在页面上分列，不合成单一"评分"——两者回答不同问题，合成会丢信息
- 文案写明 PBO 绑定当前候选集合
- 不新增依赖、不新增迁移
- `invariants.md` 补一条：CSCV 的子段余数处置与两处并列规则
- `pnpm typecheck` / `pnpm test` / 改动文件 prettier 通过
