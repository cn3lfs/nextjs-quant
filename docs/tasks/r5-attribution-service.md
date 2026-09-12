# 任务书 R5：归因分组与服务层组装

你是执行者。R1/R1b（解析）、R2（存储）、R3/R3b（回合与买卖点）、
R4/R4b（净值与风险）已验收。本任务做**归因分组**与**服务层组装**，
仍不做页面（页面是 R2b）。

先读 `AGENTS.md`、`docs/conventions.md`、`docs/invariants.md`、
`docs/trade-review-plan.md` §5.4 §6，以及 `src/lib/trade-review*.ts`、
`src/server/delivery-store.ts`。

## 0. 不可越界

- 新建 `src/lib/trade-review-attribution.ts`（纯函数）与
  `src/server/trade-review-service.ts`（有 IO），及各自测试。
- 不改解析层、存储层、迁移、`src/server/mcp.ts`；不 commit / push / 打包；不新增依赖。
- 既有用例全部必须继续通过。

## 1. 归因分组（纯函数）

输入 R3 的回合（`ReviewRound[]`）与可选的**外部维度映射**（由调用方准备，
本函数不做 IO）：行业、概念、买入日 RPS 分档。

维度：

- 标的、品种（股票 / ETF / 可转债）
- 持有期分桶（1 日 / 2-5 日 / 6-20 日 / 21-60 日 / 60 日以上）
- 买入日 RPS 分档（如 <70 / 70-90 / ≥90；**缺 RPS 的单列「未知」组**，不并入任何档）
- 行业、概念（一个标的可属多个概念，**重叠不得当作独立样本**，
  分组统计必须说明样本可重叠）
- 星期几、单笔仓位占比分档

每组输出 R3 `reviewStatistics` 的核心统计（笔数、胜率、盈亏比、期望、
profit factor、净收益合计）。

**硬约束**：

- 分组是**描述性**的，不声称因果，不等同因子分析（沿用 N1 既有措辞）。
- 组内样本少于阈值（建议 5）必须标注「样本不足，不稳定」，
  但仍显示明细——不要因为样本少就隐藏。
- 缺维度数据的回合进「未知」组，**禁止**按均值或众数填充。

## 2. 服务层组装

`src/server/trade-review-service.ts`：

- 从 `DeliveryStore` 读某账户的 fills 与 cashFlows，调用 R3/R4 引擎，
  组装出完整复盘快照：回合、买卖点、净值与风险、归因、逆回购汇总、
  未解释资金残差、待核对行。
- 日线由既有 `readSnapshot`（`src/server/tdx.ts`）提供；
  **缺行情的标的不得跳过**，要在快照里列出「因缺行情无法分析」的标的清单。
- 行业/概念用既有 `market-pool-files.ts` / `industry-blocks`；
  RPS 用既有 `rps_values` 查询。这些都**可选**：取不到就是「未知」组，
  不能让整个复盘失败。
- 导出 JSON：包含数据来源（各文件 hash 与导入批次）、口径说明、
  以及全部统计。**导出必须可重放**——同样输入得到同样输出。
- 连接沿用可注入方式（与 `delivery-import-service.ts` 一致），不新建数据库单例。

## 3. 必须显式呈现的口径（真实数据已证明会出错）

快照里必须带上这些字段，页面才能如实展示：

- **未解释资金残差**：柜台资金余额与推算现金的差额（真实账户为 `17554.45`）。
  必须作为独立字段呈现，**禁止自动平账**。
- **费用来源**：每笔是按发生金额反推还是按分项求和（R3b 已有）。
- **成本口径**：移动加权与 FIFO 两套结果并列，不要只给一套。
- **openingUnknown**：中签建仓等证据不足的回合，收益留空。
- **作废流水**：被排除的失败转账要能在快照里看到。

## 4. 测试

- `tests/trade-review-attribution.test.ts`：手算小样本，覆盖
  样本不足标注、缺维度进「未知」组、概念重叠说明、各分桶边界。
- `tests/trade-review-service.test.ts`：用内存库（`new Database(":memory:")` +
  `migrate`，范式见 `tests/delivery-store.test.ts`）与 `tests/fixtures/delivery/`
  的合成样本，贯通「导入 → 复盘快照 → 导出」；
  断言导出可重放（两次运行结果一致）、缺行情标的进清单、残差字段存在。
- 不得连接生产库，不得依赖用户真实文件。

## 5. 自证（全部执行，贴真实输出）

```
npx vitest run tests/trade-review-attribution.test.ts tests/trade-review-service.test.ts tests/trade-review.test.ts tests/trade-review-nav.test.ts tests/delivery-import.test.ts tests/delivery-store.test.ts
npx vitest run
npx tsc --noEmit
npx prettier --check src/lib/trade-review-attribution.ts src/server/trade-review-service.ts tests/trade-review-attribution.test.ts tests/trade-review-service.test.ts
```

## 6. 报告格式

改了哪些文件、关键设计选择及理由、四条命令真实结果、
你认为仍有问题但没动的地方、以及你没做到的部分。
