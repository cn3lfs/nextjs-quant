# 任务书 U6：三段样本治理

依赖 [U1](u1-daily-performance.md)（已合入）与 [U8](u8-strategy-admission.md)（已合入）。
U 系列剩余候选里**唯一还能改变判断**的一批，排在首位。

来源：czscflow `apps/web-antd/src/utils/stats/analyzeOutsample.ts`
把时间轴切成 **研究阶段样本内 / 研究阶段样本外 / 系统跟踪样本外** 三段。

## 1. 问题

E3 现在只有两段：`researchSpecSchema` 的 `start → validationStart` 是开发期，
`validationStart → end` 是保留验证期，`ResearchEvent.partition` 取
`"development" | "validation"`。

两段都是**回测**。区别只是「调参时看没看过这段数据」——
而这个区别完全依赖执行者自律，因为两段都是同一次运行、同一批历史数据里切出来的。
真正能证伪一个策略的，是它**上线之后**、在没人能回头改参数的情况下的表现。
这一段我们现在没有。

后果很具体：策略调完参，保留验证期也好看，然后就当它可信了。
但保留验证期的数据在调参当时**已经存在于磁盘上**，
「我没看」是个无法被系统验证的声明。

## 2. 核心设计：`trackingStart` 必须是推导出来的，不能是填进去的

**这是本批的全部价值所在，实现时不要走样。**

如果 `trackingStart` 是表单里一个日期输入框，那这一段就一文不值——
事后挑一个对自己有利的日期即可，和保留验证期是同一个问题。

正确做法：`trackingStart` = **该策略版本最早的前向观察记录时间**，从既有存储里查，
不接受任何人工输入、不提供覆盖开关。

仓库里已有两处带 `observedAt` + `strategyVersion` 的前向记录：

- `src/server/monitoring/signal-ledger-store.ts` —— 信号台账的向前观察（T+5/10/20）
- `src/server/monitoring/intraday-store.ts` —— E2 午尾盘预选与收盘确认快照

先核实这两处的实际字段与查询方式再动手；本任务书对存储结构的描述若与代码不符，
**以代码为准**并记入 `decisions.md`。

推导规则：

- 取该 `strategyVersion` 在上述存储中**最早的 `observedAt` 所在交易日**
- 两处都有记录时取更早的那个
- **一条前向记录都没有 → 第三段不存在**，返回 `null` + 原因
  「该策略版本无前向观察记录，系统跟踪段不存在」。
  **不要**回退成「用 end 日期」「用今天」或任何构造出来的日期
- `trackingStart` 早于 `validationStart` 时（策略在保留验证期结束前就上线了），
  三段会重叠。**如实报告重叠并拒绝出第三段指标**，
  不要偷偷截断——重叠本身说明实验设计有问题，值得看见

## 3. 交付

### 3.1 分段扩展

`ResearchEvent.partition` 增加 `"tracking"`：

```ts
partition: "development" | "validation" | "tracking";
```

现有两段的判定逻辑与边界**一字不改**，`tracking` 只在
`observedDate >= trackingStart` 时覆盖 `validation`。
`trackingStart` 不可得时**没有任何事件落入 `tracking`**，行为与本批之前完全一致。

### 3.2 三段指标并排

三段各调 U1 的 `dailyPerformance`，同一套 17 项，并排展示。
沿用 U2 已有的分段表格写法（`period-performance-results.tsx`），不新建第二套表格组件。

**衰减警示**：跟踪段的年化或 IR 相对开发段下滑超过阈值时给出提示。
阈值不要硬编码在组件里，放常量并在页面注明——
这是提示不是判定，**不产生 `isGood`、不阻止任何操作**。

### 3.3 接入 U8

U8 的两种模式与三段天然配套，接法固定：

- `history` 模式跑 **开发段 + 保留验证段**
- `recent` 模式跑 **跟踪段**

跟踪段不可得时 `recent` 模式照原样按尾部 `recentDays` 跑，
但结果里标 `trackingSegmentAvailable: false`，页面写明
「近期窗口是按尾部天数截的，不是真实上线跟踪段」。
这两者的可信度差一个数量级，不能在页面上长得一样。

### 3.4 边界

- 本批**不新增迁移**。`trackingStart` 是从既有存储查出来的派生值，不落库。
  若核实后发现必须落库才能查，**停下报告**，不要自行加迁移。
- 不改 E2/E3 既有的写入路径，只读查询。
- 不新增依赖。

## 4. 测试

`tests/three-segment-sample.test.ts`：

- **推导正确性**：构造两处存储各有记录的情况，断言取更早者；
  只有一处有记录时取该处；两处都没有时返回 `null` + 原因。
- **不可伪造**：断言不存在任何接受 `trackingStart` 的入参路径
  （`grep` 层面也要保证：函数签名里没有可选的 `trackingStart` 覆盖参数）。
- **重叠拒绝**：`trackingStart < validationStart` 时报告重叠且不出第三段指标。
- **不可得时行为不变**：无前向记录时，三段视图退化为现有两段，
  且现有 E3 测试**一条都不改**（这条是护栏：改了就说明破坏了既有行为）。
- **指标同源**：三段的 17 项与直接对同一子序列调 U1 的结果逐项相等
  （`invariants.md §1`，不允许 U6 自己算指标）。
- **U8 接入**：跟踪段可得与不可得两种情况下，
  `recent` 模式的 `trackingSegmentAvailable` 标记正确。

## 5. 验收

- `trackingStart` 只能推导，**代码里不存在人工设置它的路径**。
- 无前向记录时不编造第三段，页面明确显示原因。
- 三段重叠时如实报告，不静默截断。
- 三段指标全部来自 U1，`grep` 不到第二份实现。
- 现有 E3 两段行为与测试不变。
- `pnpm typecheck` / `pnpm test` / 改动文件 prettier 通过。
- `invariants.md` 补一条：三段的定义、`trackingStart` 的推导来源与不可伪造性、
  以及「跟踪段不可得时 `recent` 模式的含义降级」。
- 本批不新增迁移、不新增依赖。

## 6. 明确不做

- 不做自动淘汰：衰减警示只是提示，不驱动任何操作。
- 不改 E2/E3 的写入路径与既有分段语义。
- 不为了凑出第三段而放宽「前向记录」的定义
  （例如把回测产物当成前向观察）——那等于把这批的价值抹掉。
