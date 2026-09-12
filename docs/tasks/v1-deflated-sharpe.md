# 任务书 V1：试验计数与紧缩夏普

V 系列第 1 批，无依赖。排期见 [next-plan §7](../next-plan.md)。

口径权威来源：Bailey & López de Prado，*The Deflated Sharpe Ratio*（JPM 40(5), 2014，
[PDF](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)）；
PSR 出自同作者 *The Sharpe Ratio Efficient Frontier*（2012）。
**公式以论文为准，不照抄任何第三方库实现。**

## 1. 问题

`src/server/walk-forward.ts:62` 起，每个 fold 做的事是：

1. 在训练段对 `walkForwardCandidates(base)` 产生的 N 个候选各跑一次 `backtest`
2. 按训练净收益排序取第一名
3. 用这个第一名跑测试段，记入 `folds[].test`

`summary` 汇总测试段收益的均值/中位数/最差。**整个链路没有一处考虑"第一名是从 N 个里挑出来的"。**
在 N 个纯噪声候选里取最大值，其期望值严格大于零——这是选择偏差，不是策略收益。
现有 `assumptions` 末尾那句"人工反复修改参数仍可能对整个历史过拟合"方向正确，
但它是文案，读者无法据此判断"这个结果距离运气有多远"。

本批把这件事变成数字。

## 2. 交付

### 2.1 `src/lib/multiple-testing.ts`（新建，纯函数，无 IO）

统一返回 `ReviewValue`（`{ value, reason }`，见 `src/lib/trade-review.ts`）风格，
不可得时 `value: null` + 中文 reason，**不 clamp、不返回 0**。

**正态分布**（自实现，不新增依赖）：

- `normalCdf(x)`：用 erf 有理近似，绝对误差 ≤ 1e-7
- `normalInv(p)`：Acklam 逆 CDF 有理近似，`p ∈ (0,1)` 之外抛错

**矩**（全部 ddof=0，与 U1 `sharpeWbt` 同源口径）：

- `sharpeDaily(returns)`：`mean / std`，**不年化**、rf = 0
- `skewness(returns)`：三阶标准化矩
- `kurtosis(returns)`：四阶标准化矩，**非超额峰度**（正态 = 3）

**PSR**（论文 §2）：

```
PSR(SR*) = Φ( (SR̂ − SR*) · √(n−1) / √(1 − γ₃·SR̂ + (γ₄−1)/4 · SR̂²) )
```

`SR̂`、`SR*` 均为**同频（日）**夏普，`n` 为观测数，`γ₃` 偏度，`γ₄` 峰度（正态 = 3）。
根号内 ≤ 0 时返回 null + reason「PSR 分母非正，序列矩退化」。

**试验修正门槛**（论文 §3）：

```
SR₀ = √V[SR] · [ (1−γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e)) ]
```

`γ` 为 Euler–Mascheroni 常数 0.5772156649015329，`e` 自然常数，`N` 为试验次数，
`V[SR]` 为**各试验夏普的方差**（ddof=1，试验是样本）。

**DSR**：`deflatedSharpe(...)` = `PSR(SR₀)`。

退化必须逐项明确，全部返回 null + reason，不许静默给数：

| 情形 | reason |
| --- | --- |
| `N < 2` | 试验次数不足，无法估计选择偏差 |
| `V[SR] = 0`（全部候选夏普相同） | 试验间夏普无差异，紧缩门槛退化为零 |
| `n < 3` | 观测数不足 |
| PSR 分母非正 | 见上 |
| 任一输入非有限 | 输入含非有限数 |

### 2.2 候选试验矩阵

`src/server/walk-forward.ts` 新增导出 `candidateTrialMatrix(source, base, initial, costs, options)`：

- 候选**必须**来自现有 `walkForwardCandidates(base)`，不得另写一套生成逻辑
- 每个候选在**同一评估窗口、同一预热 `warmupBars`、同一 costs** 下跑一次 `backtest`
- 由 `backtest` 返回的 `equity` 差分出日收益：`r[0] = equity[0].value / initial − 1`，
  `r[i] = equity[i].value / equity[i−1].value − 1`。**这是小数不是百分数**，
  与 `dailyPerformance` 的入参口径一致
- 输出：`{ candidates, returns: number[][], sharpes: number[], dates: string[] }`
- 评估窗口与 `walkForward` 的可用区间一致（`warmupBars` 之后的全部行情），
  **不是各 fold 的测试段拼接**——这条矩阵的用途是估计 `V[SR]`，需要所有候选在同一段上可比

### 2.3 接入 `WalkForwardResult`

**只增字段，现有字段与计算路径一行不改。** `src/lib/walk-forward.ts` 的类型新增：

```ts
multipleTesting: {
  trials: number;              // = candidates.length
  trialSharpes: number[];      // 同频日夏普，与 candidates 同序
  sharpeVariance: ReviewValue; // ddof=1
  selected: {
    /** 各 fold 测试段日收益按时间顺序拼接；这才是滚动检验的实际成果 */
    observations: number;
    sharpeDaily: ReviewValue;
    sharpeAnnual: ReviewValue;   // × √yearlyDays，仅供阅读
    skewness: ReviewValue;
    kurtosis: ReviewValue;
    psr: ReviewValue;            // 基准 SR* = 0
    dsr: ReviewValue;
    threshold: ReviewValue;      // SR₀
  };
  yearlyDays: number;            // 252，参数化并回显（roadmap §2 多品种约束）
}
```

**被检验对象的定义写死在这里，执行者不要自行改**：DSR 作用于**各 fold 测试段日收益的
时间顺序拼接**。理由：walk-forward 每 fold 选不同参数，不存在单一"最终策略"，
拼接序列才是这套流程真正交付的东西。拼接处不做任何平滑或跨 fold 复利归一——
各 fold 以独立初始资金起算（`walk-forward.ts` 现有 assumption 第 3 条），
拼接的是收益率序列而非账户净值，这一点要写进 assumptions。

`assumptions` 追加三条：

1. 试验次数 N = 本次候选数，**是实际试验数的下界**；人工反复调整参数、更换标的、
   改窗口的次数不可观测，不计入 N，因此 DSR 是**乐观估计**
2. `V[SR]` 由同一区间上 N 个候选的日夏普方差估计，候选高度相关时该估计偏小、DSR 偏乐观
3. 拼接序列跨 fold 换参数，不是一个连续账户的收益

### 2.4 页面

`src/components/workbench/backtest-view.tsx` 的滚动检验结果区新增「过拟合修正」块：

- 显示 trials、`sharpeDaily`（并标注年化值）、`threshold`、`dsr`
- 结论三档，**文案焊死出处与局限**，代码里造不出裸露的"有效"：
  - `dsr ≥ 0.95` →「在记录到的 N 次试验下未被选择偏差解释（Bailey & López de Prado 2014；N 为下界，不构成业绩证据）」
  - `0.5 ≤ dsr < 0.95` →「不足以排除选择偏差」
  - `dsr < 0.5` →「更可能是选择偏差的产物」
  - 任一输入为 null →「无法判定」+ 原因原文
- 不做颜色告警语义之外的视觉强调；颜色只用既有 token

## 3. 测试（`tests/multiple-testing.test.ts` 新建）

- **正态函数对照**：`Φ(0)=0.5`、`Φ(1)≈0.8413447461`、`Φ(1.96)≈0.9750021049`、
  `Φ⁻¹(0.975)≈1.9599639845`、`Φ⁻¹(0.5)=0`，容差 1e-6；`normalInv(0)` / `(1)` 抛错
- **PSR 手算**：给定 SR̂/n/γ₃/γ₄ 的一组值，注释写出算式，断言到 1e-9
- **DSR 单调性**：同一序列，`trials` 从 2 → 10 → 100，DSR **严格下降**
- **偏度惩罚**：负偏 + 高峰度序列的 PSR 低于同 SR 的正态基线
- **口径交叉校验**：同一 returns 上 `sharpeDaily(r) × √252` 与
  `dailyPerformance({returns: r}).sharpeWbt.value` 相等到 1e-12。
  **这条是防第二份实现漂移的锚点，必须有**
- **退化五项**：§2.1 表格逐项断言 null + 对应 reason
- **矩阵**：候选数 = `walkForwardCandidates` 长度；所有候选 returns 长度相同；
  日收益差分与 equity 一致（手算 2 根 bar）
- **特征化护栏**：现有 `tests/walk-forward.test.ts` 的既有断言与数值全部保持通过；
  另加一条断言 `summary` 各字段在接入前后逐项相等（用同一 fixture 跑，硬编码期望值）

## 4. 验收

- `walkForward` 现有字段数值零漂移，有特征化断言
- DSR 只在 `multipleTesting` 下出现，不混入 `summary`
- N 是下界这句话同时出现在 `assumptions` 与页面，不只在其中一处
- 正态 CDF/逆 CDF 自实现且有对照测试；`package.json` / `pnpm-lock.yaml` 未改
- 不新增迁移
- `invariants.md` 补一条：DSR/PSR 的输入为同频夏普、N 为下界、退化返回 null 的规则
- `pnpm typecheck` / `pnpm test` / 改动文件的 prettier 通过
