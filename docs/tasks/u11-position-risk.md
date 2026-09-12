# 任务书 U11：持仓集中度与敞口

依赖 [U1](u1-daily-performance.md)。排期第 3 位。

来源：[wbt](https://github.com/zengbin93/wbt) `src/core/position_risk.rs`
与 `docs/position_risk.md`。

## 1. 问题

复盘现在能回答「赚了多少、回撤多深、执行差多少」，
但回答不了一个同样致命的问题：**这些收益是不是压在一两个票上赌出来的。**

两个账户可以有一模一样的夏普和最大回撤，一个常年分散在 8 个标的，
另一个 90% 仓位全在一只票上——后者的历史业绩不可复制，
因为它测的是运气不是方法。现有指标一个都区分不了。

## 2. 交付

### 2.1 前置：`NavDay` 补每标的市值（只增不改）

`NavDay` 现在有 `positions: Record<string, number>`（股数）和聚合
`marketValue`，但没有**每标的市值**，算不出权重。

`reviewTradeNav` 内部本来就在逐标的算市值再求和，只是没暴露。做法与 U1 §2.5 相同：

- 新增 `positionValues: Record<string, ReviewValue>`（每标的当日市值）
- 现有 `positions` / `marketValue` / `nav` 的**计算路径一行不改**
- **特征化护栏**：改动前用现有合成 fixture 跑 `reviewTradeNav`，
  把 `marketValue` / `nav` 的数值快照写死，改动后断言逐项完全相等。
  R4–R13 已验收的数字不能因为加字段而漂移
- 缺行情的标的市值为 `null` + 原因，**不要用 0 顶替**（`invariants.md §5`）

### 2.2 指标

新建 `src/lib/position-risk.ts`（纯函数）。逐交易日计算：

| 指标                 | 定义                                                 |
| -------------------- | ---------------------------------------------------- |
| `grossExposure`      | `Σ 持仓市值 / nav`                                   |
| `maxSingleWeight`    | `max(单标的市值) / nav`                              |
| `herfindahl`         | `Σ (单标的市值 / nav)²`，**分母是总资产**            |
| `herfindahlInvested` | `Σ (单标的市值 / 持仓市值合计)²`，**分母是持仓市值** |
| `effectivePositions` | `1 / herfindahlInvested`，即「等效持仓只数」         |
| `positionCount`      | 当日非零持仓标的数                                   |

**两个赫芬达尔都要，不能只留一个**：`herfindahl` 含现金稀释，
回答「相对全部资金有多集中」；`herfindahlInvested` 剔除现金，
回答「买进去的那部分有多集中」。90% 现金 + 单只满仓在两个口径下差别极大，
只给一个会误导。页面必须标明各自分母。

`effectivePositions` 是最好读的一个：等效持仓 1.0 就是全压一只，
8 只等权则是 8.0。优先展示它。

### 2.3 A 股与本仓库的适配

- **纯多头**：`shortRisk` / `longShortRatio` 恒为 0 或无定义，
  **不要输出这两个字段**（wbt 有，是因为它支持多空）。
  也不要为将来做空预留枚举——`roadmap` 明确多市场不预建机制。
- **逆回购排除**：沿用 R10/R11 口径，未到期本金计入 `nav` 分母，
  但**不计入持仓集中度的分子**——它不是方向性持仓。
  这条要有测试。
- **缺行情**：任一持仓标的市值不可得时，当日集中度指标整体留空 + 原因，
  **不要用可得的那部分算一个偏低的集中度**——那会系统性低估风险。

### 2.4 展示

`/trade-review` 新增「持仓集中度」区块：

- 曲线：`effectivePositions` 与 `maxSingleWeight` 随时间（复用 `chart.tsx`，
  null 处断线不桥接，沿用 U10 已建的 `rollingCurveSegments` 做法）
- 表格：逐日全部指标，**服务端分页**（1265 天），沿用 U2/U3/U10 模式
- 摘要：区间内 `maxSingleWeight` 的最大值与出现日期、
  `effectivePositions` 的中位数

不做阈值告警——多少算集中是用户的风险偏好，本批只呈现事实。

## 3. 测试

`tests/position-risk.test.ts`：

- **手算**：3 标的、已知市值与 nav，逐项手算核对，注释写出算式。
  含等权（HHI = 1/n）与单只满仓（HHI = 1）两个锚点。
- **两个分母**：90% 现金 + 单只满仓的用例，断言
  `herfindahl` 远小于 `herfindahlInvested`（= 1.0）。
- **逆回购**：持有未到期逆回购时，它进 `nav` 分母但不进分子，有断言。
- **缺行情**：一个标的缺市值 → 当日指标整体 `null` + 原因，
  **断言不会用剩余标的算出一个数**。
- **特征化护栏**（§2.1）：`marketValue` / `nav` 快照逐项相等。
- 空仓日：`positionCount = 0`，集中度指标留空而非 0。

## 4. 验收

- 两个赫芬达尔都输出且页面标明分母。
- 逆回购不进分子、进分母，有测试。
- 缺行情不部分计算。
- `NavDay` 只增字段，既有数值快照不变。
- 不输出 `shortRisk` / `longShortRatio`。
- 服务端分页；颜色只用 token；不新增图表库。
- `invariants.md` 补一条：两个赫芬达尔的分母定义、逆回购处置、缺行情整体留空。
- 不新增迁移、不新增依赖。
- `pnpm typecheck` / `pnpm test` / `pnpm format:check` 通过。
