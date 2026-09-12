# 任务书 V5：留出集与研究使用台账

V 系列第 5 批，依赖 [V1](v1-deflated-sharpe.md)、[V2](v2-backtest-overfit.md)
——"一次试验"的定义由它们确定。

## 1. 问题

V1 的 DSR 用 `trials = 候选数`，并在文案里承认这是**下界**：人工反复换参数、
换标的、换窗口重跑的次数，系统一次都没记过。这个下界有多松，现在无从得知。

留出集是同一个问题的另一面：调研结论要求"最近 10–20% 的数据在研究完成前不许碰"，
但只要没有任何机制记录谁碰过、碰了几次，"留出集"就只是一个口头约定，
而口头约定在自己跟自己较劲时从来不成立。

本批不禁止任何操作。它只做一件事：**把已经发生的研究次数变成可查的数字**，
让 V1 的"下界"至少有个可观测的替代值。

## 2. 交付

### 2.1 存储：复用既有 records KV，不加迁移

用 `put("research-usage", id, record)` / `list("research-usage", n)`
（`src/server/db/index.ts`）。**不新增表、不新增迁移。**

> `list` 默认 `limit = 200`，U6b 踩过这个坑（`research-store.ts` 的 `LIMIT 100`
> 让最早记录查不到）。本批统计必须遍历完整集合：显式传足够大的 limit **并**
> 加一条 ≥ 300 条记录的护栏测试，断言统计结果不随条数截断而变。

记录结构（一次研究运行一条，不可变）：

```ts
{
  id: string;              // 内容哈希，重复运行同一配置也各记一条
  at: number;              // 记录时间
  kind: "walk-forward" | "backtest" | "formula-screen" | "sample-research";
  symbols: string[];       // 涉及标的；全市场用 ["*"] 并记 universeSize
  universeSize: number | null;
  range: { start: string; end: string };
  /** V1/V2 口径：本次运行内部评估了多少个候选 */
  candidateCount: number;
  configHash: string;      // 参数指纹，排除日期窗口（U6b 的做法，理由同）
}
```

**写入时机**：在既有运行路径上追加一次 `put`，不改任何返回值、不阻塞主流程。
写入失败只记日志，**不得让研究本身失败**——台账是观测工具，不是闸门。

### 2.2 `src/lib/research-usage.ts`（新建，纯函数）

给定记录集合与查询区间，输出：

| 字段 | 含义 |
| --- | --- |
| `runs` | 覆盖该区间的运行次数 |
| `distinctConfigs` | 不同 `configHash` 的个数 |
| `candidateSum` | 各次 `candidateCount` 之和 |
| `trialLowerBound` | `max(candidateSum, distinctConfigs)` |
| `firstRunAt` / `lastRunAt` | 首末时间 |
| `byKind` | 按 kind 的分项计数 |

**`trialLowerBound` 仍然是下界**，且理由要写进输出的 `reason` 字段：
台账建立之前的运行没有记录；在应用外做的思考与筛选不可观测。
**任何页面都不得把它叫做"试验次数"**，只能叫"已记录的试验次数（下界）"。

### 2.3 留出集

设置项（存 settings，不加迁移）：`holdoutStart: string | null`。
默认 `null` = 未启用。启用后：

- 任何研究运行，若 `range.end >= holdoutStart`，记录里标 `touchedHoldout: true`
- 汇总输出 `holdout: { start, touches, firstTouchAt, distinctConfigs }`
- 页面在研究结果区显示：「留出集已被 k 次运行覆盖」。`k ≥ 1` 时追加固定文案：
  「留出集的样本外意义已随使用次数递减，k 次之后它与样本内没有本质区别」
- **不拦截、不弹确认框。** 拦截会让人把留出集起点往后调，那比记录下来更糟

留出集起点**由用户设置，系统不自动推荐"最近 20%"**：自动推荐会让它随数据增长
自动平移，那样永远有一段"从没被碰过"的假象，而实际上它昨天还是样本内。

### 2.4 接入 V1

`multipleTesting` 新增 `recordedTrials: ReviewValue`（来自 §2.2 的
`trialLowerBound`，取当前运行区间）。**DSR 的计算不自动改用它**——
两个数并列显示，各自标注口径：

- `trials`：本次运行内部候选数（V1 现有口径，DSR 用的就是它）
- `recordedTrials`：该区间历史累计已记录试验数（下界）

若 `recordedTrials > trials`，页面追加一行：
「DSR 按本次候选数计算；该区间历史上已记录 m 次试验，实际紧缩应更严」。
**不要自作主张用 m 重算 DSR**：m 包含不同标的、不同配置的运行，
直接代入论文公式的 N 不成立（公式假设 N 次试验作用于同一被检验对象）。
这一条是口径正确性问题，执行者不要"优化"。

## 3. 测试（`tests/research-usage.test.ts` 新建）

- **区间重叠**：记录区间与查询区间部分重叠/包含/不相交，各一条，断言计数
- **下界字段**：`trialLowerBound = max(candidateSum, distinctConfigs)`，含两者互为最大的两例
- **截断护栏**：写入 300+ 条记录，断言统计与遍历全量一致（§2.1）
- **留出集**：`holdoutStart` 启用/未启用；`range.end` 恰等于 `holdoutStart` 算触碰（边界）
- **写入不阻塞**：`put` 抛错时研究主流程仍返回正常结果，有断言
- **不可变**：同配置重复运行产生两条记录，不去重、不覆盖
- **文案锚点**：断言输出里 `trialLowerBound` 的 reason 非空（防止哪天被简化掉）

## 4. 验收

- 无迁移、无新依赖、无新表
- 台账写入失败不影响研究结果，有测试
- `recordedTrials` 与 `trials` 并列且各自标注口径；**DSR 未被 m 重算**
- 留出集不拦截操作
- `list` 截断护栏测试存在
- `invariants.md` 补一条：试验数永远是下界、留出集只记录不拦截、m 不代入 DSR
- `pnpm typecheck` / `pnpm test` / 改动文件 prettier 通过
