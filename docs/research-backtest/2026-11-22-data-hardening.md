# 数据与公司行动硬化（2026-11-22）

> 本文记录回测数据层的处理决定与证据边界，不产生策略业绩结论。冻结口径见[回测研究假设](2026-11-22-backtest-assumptions.md)，诊断流程见[回测诊断协议](2026-11-22-backtest-protocol.md)。

## 1. GBBQ 未识别记录按标的归因

**问题**：`parseGbbqFile` 只记录偏移和原因，`prepareLabBacktest` 把整份文件的未识别记录当作每个标的的阻断条件。只要全文件有一条坏记录，任何标的的因果信号价都会被拒绝，即使坏记录属于别的证券。

**处理**：

- `packages/tstdx/src/local/gbbq.ts` 的 issue 记录增加可选 `symbol`。市场与 6 位代码可解码时立即归属；类别未知、日期非法、数值非法都带该 `symbol`。代码或市场本身无法识别时保持无归属。代码按原始字节校验为 ASCII 数字（0x30–0x39）：Node 的 `ascii` 解码会清高位，0xB6 会被读成 “6”，若不校验就会把损坏记录错归到真实证券。
- `src/server/research/lab-backtest.ts` 把 issue 拆成两类：
  - 本标的 issue：计入 `sources.gbbqIssueCount`，strict 模式阻断该标的；
  - 无法归属的整文件 issue：计入 `sources.gbbqUnattributedIssueCount`，strict 模式仍保守阻断所有标的（这些记录可能属于当前标的）。
- 归属其他标的的 issue 不再阻断当前标的；`record-only` 仍跳过全部 issue 并披露两组计数。
- `parseGbbqFile` 对外行为不变；新增 `parseGbbqRecords(buffer, decodeRecord)` 与 `GBBQ_RECORD_SIZE` 只用于纯文本 fixture 测试。

**证据**：`tests/research-backtest/gbbq-attribution.test.ts` 覆盖有效记录、未知类别、非法日期、非法代码与高位字节五种情况；`tests/research-backtest/diagnose/loader.test.ts` 覆盖“A 标的 strict 通过、B 标的 strict 阻断、无法归属仍阻断”。诊断的 `dataQuality` 同时读取 `gbbqIssueCount` 与 `gbbqUnattributedIssueCount`，无法归属的记录不会被当成“无缺口”。

**残留边界**：GBBQ 是事后文件，归属只解决“坏记录连坐”，不证明事件完整；派息到账日、送转上市日仍按除权日的研究情景处理。

## 2. 权证（category 13/14）

**现状**：strict 模式由 `researchCorporateActions` 抛出 `Unsupported warrant entitlement <date>`；`record-only` 模式按标的过滤 13/14，日期写入 `sources.skippedWarrants`。

**决定**：维持“显式排除 + 披露”，不建模。权证行权涉及正股结算、行权价与到期日，当前本地数据没有可验证的行权现金流与股份变动路径；建模会把未验证假设混入持仓和现金。

**边界**：含 2006 年权证事件的标的全历史在 strict 模式下仍会阻断；需要该区间的研究应显式使用 `record-only` 并引用 `skippedWarrants` 日期，不能把结果当作覆盖权证事件的业绩。

## 3. 历史 ST / IPO 状态

**现状**：`equityResearchRules(symbol, date, status?)` 只有在提供“同日历史 ST 证据”时才把主板涨跌停改为 ST 口径；没有本地历史 ST 表。创业板/科创板保持 20%，北交所 30%。

**本批改动**：主板 ST 口径按日期切换——2026-07-05 及之前 5%，2026-07-06 起 10%。测试覆盖边界日与创业板不受影响。

**决定**：没有同日证据时不套用 ST 折价，明确记为 unknown；不能用当前证券名称反推历史 ST。IPO 初期涨跌幅与上市首日规则仍无本地证据，相关日期只阻断依赖该结论的单元。

**残留边界**：全历史策略会把部分 ST 区间按 10% 处理，可能高估可成交性；报告必须披露“历史 ST/IPO 未认证”。

## 4. `sz000001` 早期周末 bar

**事实**：`sz000001` 全历史 8,496 根，其中 39 根落在 1991–1993 年的周六/周日，`sh000001` 基准日历没有对应交易日。逐日清单与窗口内 4 个关键日期见[日历修正记录](2026-11-22-calendar-correction.md)。

**决定**：保留“删 bar + 披露”的小缺口策略：窗口内缺口不超过 `max(20, 0.5%)` 时从 `bars`/`signalBars` 删除并写入 `offCalendarDates`，不合成日期、不改公司行动；超过阈值仍阻断。

**理由**：本地没有第二数据源可判定深市早期周末成交记录的真伪；删除并披露比伪造交易日或悄悄并集更可审计。组合窗口从 2018-06-11 起，不受影响。

## 5. 幸存者偏差

**现状**：五标的均为当前存续标的；RPS 回填使用当前存活证券与当前名称，代码注释已标注生存者偏差。仓库没有历史指数成分、退市清单或历史名称变更表。

**决定**：本阶段不做“全市场可外推”的结论；所有报告继续标注样本为当前存续标的。要做历史横截面研究，先补历史成分与退市覆盖，再谈 PIT 证券池。

**后续可行性**：需要外部数据（历史成分、退市日期、历史 ST）并单独授权；在此之前，RPS/经典横截面只做规则自检。

## 验证

- `pnpm exec vitest run tests/research-backtest/gbbq-attribution.test.ts tests/research-backtest/diagnose/loader.test.ts`
- `pnpm --filter trading-strategy-core test`
- 完整门禁由指挥官在批次末尾执行 `pnpm check`。
