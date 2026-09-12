# 任务书 U8：策略准入判定

依赖 [U1](u1-daily-performance.md)。这是 U 系列里唯一会**改变决策方式**的一批——
其余几批都只是把已有数据换个角度展示。

来源：[wbt](https://github.com/zengbin93/wbt)（MIT，v0.9.1，commit `39bb1e8`）
`src/core/is_good_strategy.rs`（2061 行）与 `python/wbt/backtest.py:404`。

## 1. 问题

`roadmap.md` 反复写「程序正确不代表策略赚钱」，
`next-plan.md` E3 写「未经验证的旧回测只能作为规则自检，不能称为可信策略业绩」。
方向是对的，但目前**只有约束，没有判据**——
我们能算出夏普 1.2、最大回撤 18%，然后呢？多少算够？

现状是这个判断留在人脑里，每次凭感觉，且没有记录。
结果就是：调参调出一个好看的数，自己说服自己，事后无法复盘当时凭什么认为它行。

wbt 把「这策略能不能搞」写成了**可复现的判定函数**，两种模式、
明确的通过条件、明确的失败原因字符串。这正是我们缺的那一半。

## 2. 判定逻辑（wbt 原文口径）

### 2.1 波动率归一多头超额

判定不看原始超额，看**波动率归一后**的超额：

```
long_scale  = target_vol / (std(long)  × √252)
bench_scale = target_vol / (std(bench) × √252)
alpha[i]    = long[i] × long_scale − bench[i] × bench_scale
```

意思是「把策略和基准都缩放到同一个目标波动率（默认年化 20%）再比」。
不这么做的话，一个加了三倍杠杆的策略会因为收益高而显得优秀。

**scale 用全样本计算，整段共用一组**。recent 模式也**不**对近期窗口重新归一化。

`long` / `bench` 长度不一致、含 NaN/Inf、或任一年化波动率 < 1e-12 →
**alpha 退化**，此时 `is_good` 强制 `false`，所有 alpha 派生字段留空。
**不允许把「退化 → alpha 全 0 → 回撤 0」当成通过**，wbt 源码为此专门做了防护。

### 2.2 history 模式

两层，先逐年后全样本：

**第一层——每个完整自然年（交易日数 ≥ `min_year_days`）三选一即合格：**

1. 当年绝对收益 > 0
2. 当年波动率归一多头超额 > 0
3. 当年多头超额最大回撤 < `max_dd_threshold`

alpha 退化时第 2、3 路**不参与**（只剩绝对收益一路）。
**所有完整年都必须合格**，有一年不合格就整体失败。
一个完整年都没有 → 失败，原因写「no complete year」。

**第二层——全样本两道硬门，必须同时满足：**

- 全样本超额最大回撤 **≤** `max_alpha_dd_threshold`
- 全样本超额 Sharpe **>** `min_full_sharpe`

注意一个是 `≤` 一个是 `>`，边界不对称，照抄，不要"顺手统一"。

### 2.3 recent 模式

**收益侧三选一**（同 §2.2 第一层，但作用在尾部 `recent_days` 天）：
绝对收益 > 0 或 超额 > 0 或 近期超额回撤 < `max_dd_threshold`。

**唯一硬门**：近期超额最大回撤 **严格小于** 「剔除 recent 窗口后」的历史超额最大回撤。

这一条设计得很好，值得单独说明：它问的不是「近期表现好不好」，
而是**「近期是不是比历史更稳」**。两段窗口完全错开，不重叠。
如果剔除后的历史段长度 < `min_history_days`，返回
`history_window_empty = true` 且判定失败——
防止历史段太短导致 `max_dd ≈ 0`、硬门恒假。

### 2.4 默认参数

| 参数                     | 默认 | 含义                                |
| ------------------------ | ---- | ----------------------------------- |
| `target_vol`             | 0.20 | 归一化目标年化波动率                |
| `max_dd_threshold`       | 0.20 | 逐年 / 近期窗口的超额回撤阈值       |
| `max_alpha_dd_threshold` | 0.30 | history 全样本超额回撤硬门          |
| `min_full_sharpe`        | 0.5  | history 全样本超额 Sharpe 硬门      |
| `min_year_days`          | 200  | 「完整自然年」所需最少交易日        |
| `recent_days`            | 252  | recent 模式尾部窗口                 |
| `min_history_days`       | 60   | recent 模式历史段长度下限，0 = 关闭 |

**这些阈值不得直接拿来下结论，见 §4。**

## 3. 交付

新建 `src/lib/strategy-admission.ts`（纯函数，无 IO）。

### 3.1 多空：接口预留，实现单边

wbt 的签名区分 `strategy_daily` / `long_daily` / `bench_daily`，因为它支持多空。

**A 股 T+1 纯多头，`long_daily` 恒等于 `strategy_daily`**，
「多头超额」就是「策略超额」。用户 2026-09-12 明确后续要做 BTC、
黄金白银、外汇——那些市场可以做空，届时两者会真的不同。

做法（成本几乎为零，现在就定）：

- 签名保留 `longDaily?: readonly (number | null)[]`，**缺省时取
  `strategyDaily`**，并在结果里回显 `longIsStrategy: true`
- 判定逻辑照 wbt 原样写，它本来就不关心两者是否相同

**不要做的**：不实现多空拆分算法、不从成交推导多空腿、
不加 market/asset-class 枚举、不建策略类型分派。
本批只跑通单边这一条路径。这里要的只是「以后传进来就能用」，
不是「现在就支持多空」。

### 3.2 判定内部用 `simple` 口径

这是本批唯一需要偏离「复利为主」的地方，理由要写进 `invariants.md`：

§2.4 那些默认阈值是 wbt 在**单利收益空间**（`Σr`，回撤是绝对值）里标定的。
换成复利比例回撤，`0.20` 的含义就变了，门槛会静默漂移。

所以：**判定核内部统一调 U1 的 `simple` 口径 + `rf = 0`**，
与 wbt 完全对齐，阈值语义可继承。展示层的净值、回撤仍用复利，两者分开。

判定结果里必须带 `basis: "simple"` 字段，页面上标注
「判定口径为单利，与页面净值曲线的复利口径不同」。

### 3.3 返回结构

按 wbt 的 key 设计，但**缺失语义按我们的规范改造**：
wbt 用 `NaN` / `null` / 约定值混着表达不可得，我们一律 `ReviewValue`。

必须返回的：

- `isGood: boolean` —— 但**永远和 `reasons` 一起返回**，不允许只取这个布尔值
- `reasons: readonly string[]` —— **结构化数组，不是 wbt 那个 `join("; ")` 的长字符串**
  （R13 已经踩过长字符串拼接的坑，不重复）
- `mode`、`basis`、`alphaDegenerate`
- history 模式：`yearlyMetrics[]`（每年：年份、交易日数、是否完整年、绝对收益、
  超额收益、超额最大回撤、`yearPassed`）、`completeYearCount`、
  `historyAlphaMaxDrawdown`、`historyAlphaSharpe`、三个 `cond*Passed`
- recent 模式：`recentStartDate` / `recentEndDate` / `recentActualDays` /
  `recentAbsReturn` / `recentAlphaReturn` / `recentAlphaMaxDrawdown` /
  `historyAlphaMaxDrawdownExclRecent` / `historyWindowEmpty` / 两个 `cond*Passed`
- `params` —— 本次判定实际使用的全部阈值，原样回显

**回显阈值是硬要求。** 判定结论离开阈值就没有意义，
导出的 JSON 必须能独立复现这次判定。

### 3.4 输入可信度继承

这条是我们特有的，wbt 没有，但对我们是**最重要的一条**。

E3 已经明示：当前模拟存在成分回溯偏差、公司行动覆盖不全、
外部条件未经独立核验。如果把这样的净值喂进 U8，
`isGood = true` 只是给不可信数据盖了个章。

**要求**：输入带一个 `evidenceLevel` 字段，取值沿用 E3 页面已有的口径标记
（至少区分「合成/受控样本」「本地模拟未独立核验」「真实账户交割单」）。
判定结果原样带出这个字段，页面上**与结论同等字号**显示。
`evidenceLevel` 不是「真实账户」时，`isGood` 的展示措辞必须是
**「在该数据前提下通过」**，不是「通过」。

### 3.5 接入

- `/research`：策略样本结果页加「准入判定」卡片，
  两种模式各跑一次（history 用全样本，recent 用尾部窗口）
- `/trade-review`：真实账户也跑一次 history 模式——
  这回答「我自己这个账户，按同一把尺子量算不算能搞」

参数可调，默认值取 §2.4，改动即时重算并回显。

## 4. 阈值必须先标定，不得直接用默认值

**这是本批的验收前置，不是建议。**

§2.4 的默认值是 wbt 在多品种期货/加密上标定的，不是 A 股，更不是我们的账户。
直接拿来用就是拿别人的尺子量自己。

**要求**：交付时同时提供一个标定脚本或测试，
在我们**已有的**真实账户净值和 E3 已产出的样本上跑一遍，
输出各项指标的实际分布（至少给出 min / 中位数 / max）。

在管理者依据这份分布确认阈值之前：

- 页面上 `isGood` **一律显示为「未标定」**，不显示 true/false
- 各项分指标与 `cond*Passed` 照常显示（那些是事实，不是判断）
- 阈值来源在页面上注明「wbt 默认值，未针对本账户标定」

标定完成后由管理者写进 `decisions.md`，页面才解除封印。

**标定结果按市场记录。** 本轮标的是 A 股。
BTC / 贵金属 / 外汇的波动率量级完全不同，A 股标出来的
`target_vol` 与回撤阈值不可移植——`decisions.md` 里要写明
「本组阈值适用范围：A 股」，以后每个市场各标一次。
`yearlyDays` 同理（A 股 252、BTC 365），走 U1 §0.1 的参数，不内联。

## 5. 测试

`tests/strategy-admission.test.ts`：

- **逐年三选一**：构造只有第 2 路通过、只有第 3 路通过、三路全败的年份，
  断言 `yearPassed` 与整体结论。
- **完整年门槛**：交易日数 199 / 200 / 201 三个边界，断言是否计入完整年。
- **两道硬门的不对称边界**：超额回撤**恰好等于** `max_alpha_dd_threshold`
  时应**通过**（`≤`）；Sharpe **恰好等于** `min_full_sharpe` 时应**失败**（`>`）。
  这两条最容易写反，必须各有一个用例。
- **alpha 退化防护**：构造 bench 波动率为 0 的输入，
  断言 `alphaDegenerate = true`、`isGood = false`，
  且**不会**因为「alpha 全 0 → 回撤 0 → 条件 3 通过」而误判通过。
  这是 wbt 专门防护的坑，我们必须有对应用例。
- **recent 窗口错开**：断言 `historyAlphaMaxDrawdownExclRecent` 的计算
  确实剔除了尾部 `recent_days` 天，两段不重叠。
- **历史段过短**：`min_history_days = 60`，历史段只有 59 天 →
  `historyWindowEmpty = true`、`isGood = false`；设为 0 时关闭该 floor。
- **口径锚定**：断言判定内部用的是 `simple` + `rf = 0`，
  与 U1 在同参数下的输出逐项相等（不允许 U8 自己算指标，`invariants.md §1`）。
- **阈值回显**：断言 `params` 完整回显，导出 JSON 可独立复现判定。
- 入参校验：日期与序列长度不一致、`recent_days = 0`、
  `target_vol <= 0`、阈值为 NaN —— 全部抛错，不静默降级。

## 6. 验收

- 真实账户与 E3 样本各能跑出完整判定结构，`reasons` 是结构化数组。
- §5 里两条不对称边界用例通过。
- alpha 退化不会误判为通过。
- 未标定前页面不显示 `isGood` 的 true/false，只显示分指标。
- `evidenceLevel` 与结论同等字号展示，非真实账户时措辞为「在该数据前提下通过」。
- 标定分布已产出并交管理者，阈值决定写入 `decisions.md`。
- `invariants.md` 补上「判定用单利口径、展示用复利口径」这条分工。
- `pnpm check` 通过；浏览器验收由管理者执行。
- 本批不新增迁移（判定是派生结果，不落库；
  若后续要留判定历史，按 `conventions.md §9.6` 同时定义保留上限与删除方式）。

## 7. 明确不做

- **不做自动决策。** `isGood` 是给人看的一个输入，不驱动任何下单、
  不驱动 E3 的参数选择、不自动淘汰策略。
- 不做多空拆分（§3.1）。
- 不引入 wbt 或任何新依赖，只实现口径。
- 不做参数搜索/自动寻优阈值——那会让判定退化成对历史的曲线拟合，
  恰好是这个工具要防的东西。
