# 基准日历修正后的 `sz000001` 补跑（2026-11-22）

> 本文是[五标的回测诊断](2026-11-22-five-symbol-diagnostic.md)的补充记录，只回答“日历外 bar 策略修正后，原先被 `sz000001` 阻断的单元能否继续”。流程诊断，不是策略业绩；不做收益排名，不构成任何可交易结论。主报告仍由另一任务维护，本文不回写主报告。

## 范围与口径

| 项目 | 取值 |
| --- | --- |
| 补跑批次 | `.test-data/backtest-diagnose/2026-11-22-batch1b/` |
| 单元数 | 12（per-symbol 6 + portfolio 6） |
| 标的 | 单标的 `sz000001`；组合 `sh600519,sz000001,sh601318,sz000333,sz300750` |
| 策略 | `dual-ma`、`turtle`、`rsi2`、`double-breakout`、`formula` + `hold` 对照 |
| 行情根 | `E:/new_tdx64`，只读 |
| 数据截止 | 2026-11-20 |
| 初始资金 / 费用 | 1,000,000 / `base` |
| 信号价 | 非 `hold` 策略统一 `forceCausalPrice`；`hold` 不强制因果价 |
| 隔离数据目录 | `D:/github/nextjs-quant/.test-data/backtest-diagnose/data`（`--data-dir` 覆盖 `QUANT_DATA_DIR`） |
| 代码改动 | 无。本任务只运行与记录，未修改 scripts/src/packages/tests |

## 修正前后对比

### 修正前（batch1，作为基线）

| 范围 | ok | blocked | failed | 阻断原因 |
| --- | ---: | ---: | ---: | --- |
| 单标的 30 单元 | 24 | 6 | 0 | 6 个 `sz000001` 单元全部因基准日历缺口阻断 |
| 组合 6 单元 | 6 | 0 | 0 | 无；组合窗口从 2018-06-11 起，不含早期缺口 |
| 合计 36 单元 | 30 | 6 | 0 | 数据层 6 |

**与任务假设的差异**：任务描述预期“6 个单标的 + 6 个组合单元被基准日历阻断”，但 batch1 的 `aggregate.json` 与主报告均显示组合 6 个单元原本就是 `ok`。原因是组合窗口为 2018-06-11 ~ 2026-11-20，`sz000001` 的 39 个日历外 bar 全部在 1991–1993 年，落在组合窗口之外。因此修正前的实际阻断数是 **6**，不是 12；本补充报告以实际产物为准。

### 修正后（batch1b，本批）

| 范围 | ok | blocked | failed | 阻断层级 |
| --- | ---: | ---: | ---: | --- |
| 单标的 `sz000001` 6 单元 | 4 | 2 | 0 | `causal-price` 2 |
| 组合 6 单元 | 6 | 0 | 0 | 无 |
| 合计 12 单元 | 10 | 2 | 0 | — |

- 原来的“基准日历缺少交易日”阻断 **6/6 消失**，没有再出现该错误。
- 新出现 2 个 `causal-price` 层阻断（`double-breakout`、`formula`），不是旧的日历阻断；本任务按要求只记录、不改代码。

## 日历外 bar 策略

修正实现在 `scripts/lib/backtest-diagnose/prepare-request.ts`，规则如下：

1. 基准日历取 `sh000001` 在 `[start, end]` 内的日线日期，替换原并集日历。
2. 逐标的找出窗口内“个股有 bar、基准日历没有”的日期集合。
3. 阈值 `max(20, floor(窗口内 bar 数 × 0.005))`：
   - 集合不超过阈值：只从 `instrument.bars` / `instrument.signalBars` 删除这些 bar，**不合成日期、不改公司行动、不改逐日执行映射**，并把日期与说明写入 `run.json` 的 `sources[].offCalendarDates` / `offCalendarNote`，诊断项 `dataQuality` 记 `warn`。
   - 集合超过阈值：仍抛旧的 `基准日历 sh000001 缺少 <symbol> 的交易日：…`，阻断该单元。大缺口被视为基准日历缺陷，不能用“删几根 bar”掩盖。
4. `hold` 与非 `hold` 使用同一规则；`hold` 窗口从 1991-04-03 起，因此披露 39 个日期，信号策略从各自预热后开始，只披露窗口内的 2–4 个。

### 4 个关键日期

`dual-ma` 的 `run.json` 披露：

```text
sz000001 offCalendarDates: 1992-05-03, 1992-10-04, 1993-05-01, 1993-05-02
note: 基准日历 sh000001 不含该标的 4 个交易日；为对齐回放日历，已从 bars/signalBars 删除这些 bar（未合成日期，未改公司行动或执行映射）
```

| 日期 | 星期 |
| --- | --- |
| 1992-05-03 | 周日 |
| 1992-10-04 | 周日 |
| 1993-05-01 | 周六 |
| 1993-05-02 | 周日 |

- `turtle` / `rsi2` 窗口从 1992-06-04 起，因此只披露后 3 个（`1992-05-03` 在起始日之前）。
- `hold` 从 1991-04-03 起，披露 39 个，完整包含上述 4 个；其余 35 个为 1991–1992 年初的周末日期。
- bar 数闭合：`sz000001` 全历史 8496 根；`dual-ma` 8492 = 8496 − 4；`hold` 8457 = 8496 − 39。`turtle` / `rsi2` 为 8493 = 8496 − 3。
- 这些日期全部是周六/周日。数据源在深市早期周末有成交记录、沪市基准无对应 bar；本批不判定哪一侧记录更正确，只做“对齐回放日历 + 显式披露”，不补造交易日。

## 12 单元状态

计数格式：`bars/warmup/signals/orders/fills/rejections/closedTrades`。`blocked` 单元没有有效计数。

| # | 模式 | 策略 | 状态 | 层级 | start | 计数 | 备注 |
| ---: | --- | --- | --- | --- | --- | --- | --- |
| 1 | per-symbol | dual-ma | ok | — | 1992-03-24 | 8492/250/500/434/377/77/188 | 日历外 4 日已披露 |
| 2 | per-symbol | turtle | ok | — | 1992-06-04 | 8493/300/1201/249/223/36/111 | 日历外 3 日已披露 |
| 3 | per-symbol | rsi2 | ok | — | 1992-06-04 | 8493/300/6814/352/332/37/166 | 日历外 3 日已披露 |
| 4 | per-symbol | double-breakout | blocked | causal-price | 1992-03-24 | 0/0/0/0/0/0/0 | 见“新发现 F1” |
| 5 | per-symbol | formula | blocked | causal-price | 1992-03-24 | 0/0/0/0/0/0/0 | 见“新发现 F1” |
| 6 | per-symbol | hold | ok | — | 1991-04-03 | 8457/0/8457/77/1/76/0 | 日历外 39 日已披露；1 笔成交 |
| 7 | portfolio | dual-ma | ok | — | 2018-06-11 | 24460/14250/644/609/579/55/288 | 与 batch1 逐项一致 |
| 8 | portfolio | turtle | ok | — | 2018-06-11 | 24460/14250/1545/316/306/25/151 | 与 batch1 逐项一致 |
| 9 | portfolio | rsi2 | ok | — | 2018-06-11 | 24460/14250/7945/516/506/27/253 | 与 batch1 逐项一致 |
| 10 | portfolio | double-breakout | ok | — | 2018-06-11 | 24460/14250/92/72/70/6/35 | 与 batch1 逐项一致 |
| 11 | portfolio | formula | ok | — | 2018-06-11 | 24460/14250/5572/372/364/21/180 | 与 batch1 逐项一致 |
| 12 | portfolio | hold | ok | — | 2018-06-11 | 24460/14250/10210/12/5/7/0 | 与 batch1 逐项一致；5 笔成交 |

- 组合窗口 `2018-06-11 ~ 2026-11-20`，`sz000001` 的 39 个日历外日期都不在窗口内，`sources[].offCalendarDates` 为空，因此 6 个组合单元不受本次修正影响。
- 6 个组合单元的计数与 batch1 主报告逐项一致（例如 `dual-ma` 644/609/579/55/288、`hold` 12/5/7），说明同输入重跑结果稳定，修正没有改变组合路径的成交序列。
- 10 个 `ok` 单元没有任何 `fail` 检查；`failedChecks` 为空。

## 新发现

### F1（阻断，`causal-price` 层）：删除日历外 bar 会使因果价证明失效

受影响单元：`per-symbol/double-breakout/sz000001`、`per-symbol/formula/sz000001`。

原始错误（`summary.json` / `diagnostics.json`，状态 `blocked`，层级 `causal-price`）：

```text
sz000001：绝对价格或无法证明尺度无关的规则需要逐 bar 因果因子或已验证的拆股复权序列；当前输入缺少该证据
```

定位：

- 该文案在 `replayLabBacktest` 的因果价证明复核处抛出（`src/server/research/lab-backtest.ts:470-485`），精确匹配“证明校验失败”分支；不是 `prepareLabBacktest` 包装后的带内层原因的版本。
- `prepareLabBacktest` 先按完整 bar/signalBars 计算并记录 `causalPrice.seriesHash`（`causalResearchPrices` → `hasCausalPriceProof` 的 `hash([raw, bars])`）。
- `prepareDiagnoseRequest` 随后删除 4 个日历外日期，修改了 `instrument.bars` / `instrument.signalBars`；证明对象里的 `seriesHash` 仍是删除前的序列。
- `replayLabBacktest` 仅对 `requiresCausalPriceBasis(strategy)` 为真的策略重新校验证明。`double-breakout` 和本批 `formula`（含绝对价格输出）命中该分支，因此哈希不匹配被拒绝；`dual-ma` / `turtle` / `rsi2` 是尺度无关规则，不走该复核，所以即使同样删除了 bar 仍为 `ok`。
- 组合单元窗口内没有日历外 bar，序列未被修改，因此 `double-breakout` / `formula` 组合仍为 `ok`；这也支持“删除动作触发哈希失效”的解释。

影响边界：

- 只影响“单标的窗口内存在少量日历外 bar，且策略需要因果价证明”的组合；本批只有 `sz000001` 的 `double-breakout` / `formula` 满足条件。
- 这是修正引入的交互缺陷，不是旧的日历阻断；本次未改代码，`double-breakout` / `formula` 的 `sz000001` 单标的结果仍不可用。
- `blocked` 单元的 `run.json` 走错误分支，没有 `sources`，因此这 2 个单元看不到 `offCalendarDates` 披露；但错误签名已表明 prepare 完成、失败发生在 replay 的证明复核。

### F1 修复后（batch1c 复跑，2026-11-22）

> 本节追加在 batch1b 记录之后。上面的 F1 描述与 batch1b 的 before/after 证据原样保留，作为修复前历史；本节只更新“两个单元能否继续”的可用性，不改写旧结论。

批次 `.test-data/backtest-diagnose/2026-11-22-batch1c/`，运行 `run-2026-11-22T04-57-44.865Z-38980/`，共 3 个单元（2 个原阻断单元 + `hold` 对照）。修复点是 `refreshCausalPriceProof`（`src/server/research/causal-price-basis.ts`）：删除日历外 bar 后，按过滤后的 `instrument.bars` / `instrument.signalBars` 重算 `seriesHash`，首根原始 bar 锚点与 GBBQ 来源保持不变；锚点若被过滤则仍拒绝（不会保留陈旧证明）。本任务只复跑与记录，未改代码或测试。

#### 3 单元结果

计数格式：`bars/warmup/signals/orders/fills/rejections/closedTrades`。

| 策略 | 状态 | 层级 | start | 计数 | offCalendarDates |
| --- | --- | --- | --- | --- | --- |
| double-breakout | ok | — | 1992-03-24 | 8492/250/65/65/64/7/32 | 4 |
| formula | ok | — | 1992-03-24 | 8492/250/4782/301/231/82/115 | 4 |
| hold | ok | — | 1991-04-03 | 8457/0/8457/77/1/76/0 | 39 |

- **目标单元 2/2 恢复 `ok`**：`double-breakout`、`formula` 的 `summary.json` / `diagnostics.json` 均为 `status: ok`，`run.json` 不再有 `layer` / `error`；在本批目录内检索 `causal-price`、`缺少 … 交易日` 均无命中，说明 replay 的因果价证明复核通过。
- **日历外披露仍在**：两个目标单元的 `sources[0].offCalendarDates` 均为 `1992-05-03, 1992-10-04, 1993-05-01, 1993-05-02`（4 个），与 `dual-ma` 一致；bar 数为 `8492 = 8496 − 4`。`hold` 仍披露 39 个，`8457 = 8496 − 39`。
- **复跑稳定性**：`hold` 计数 8457/0/8457/77/1/76/0 与 batch1b 逐项一致，拒绝构成也相同（一字行情 60、缺少当日交易限制依据 12、滑点超出可观察范围 3、开盘涨停 1）。
- 本批 3 单元无 `fail` 检查；告警仍为 `dataQuality`（日历外 bar）、`capacityRatio` 与 `corporateActionDates`，与修复无关，口径同 batch1b。

#### 合并后的补跑覆盖

| 范围 | 来源 | ok | blocked |
| --- | --- | ---: | ---: |
| `sz000001` 单标的 6 单元 | batch1b 的 `dual-ma` / `turtle` / `rsi2` / `hold` + batch1c 的 `double-breakout` / `formula` | 6 | 0 |
| 组合 6 单元 | batch1b（本批未重跑） | 6 | 0 |
| 合计 12 单元 | — | 12 | 0 |

- 组合 6 单元本次未重跑：其窗口 `2018-06-11 ~ 2026-11-20` 内没有日历外 bar，`refreshCausalPriceProof` 对它们不执行，batch1b 的 6 个 `ok` 仍然有效；因此“12/12 补跑单元 ok”是 batch1b（10 ok）与 batch1c（2 个原 blocked 转 ok）的合并结论，不是一次 12 单元重跑的结果。
- 本批 `aggregate.json` 为 `statusCounts: ok 3 / blocked 0 / failed 0`。

#### 边界

- F1 的结论只到“证明刷新后两个单元可以继续执行”，不是策略业绩；`double-breakout` 的 65 个信号/64 笔成交、`formula` 的 4782 个信号/231 笔成交只说明流程打通。
- 日历外 bar 仍是从回放序列删除的 4 个早期周末日期，数据争议与 batch1b 相同，不补造交易日。
- `formula` 有 65 笔成交超过当日成交额 5%（12 笔超 20%），`double-breakout` 1 笔；引擎无容量约束，不代表可成交。不做收益排名或可交易结论。

### F2（披露）：`hold` 的 39 个日历外日期多于信号策略

`hold` 预热为 0、窗口从 1991-04-03 起，因此完整暴露 1991–1993 年的 39 个周末日期；信号策略从预热后开始，只暴露 1992–1993 年的 2–4 个。两者是同一缺口的截断表现，不是标的数据不同。

### F3（执行限制）：`hold` 对照仍有 76 次拒绝

`hold/sz000001` 的 77 笔订单中只有 1 笔成交，拒绝构成为：一字行情 60、缺少当日交易限制依据 12、滑点成交价超出可观察价格范围 3、开盘涨停 1。早期深市数据缺少可靠的逐日涨跌停/停牌依据，引擎选择保守拒绝；这是执行证据限制，不是日历修正造成的，也不是账本错误。最终 1 笔成交后不再卖出，符合 `hold` 语义。

### F4（容量提示，未新增阻断）

`dual-ma/sz000001` 有 120 笔成交超过当日成交额 5%（其中 27 笔超过 20%），`turtle` 37 笔（2 笔超 20%），`rsi2` 9 笔（1 笔超 20%），`hold` 1 笔。引擎没有容量/参与率约束，这些只是可达性提示，不代表可成交；与主报告的口径一致。

## 结论与边界

1. 日历外 bar 策略修正**解决了原来的 6 个 `sz000001` 单标的阻断**；这 6 个单元不再出现“基准日历缺少交易日”的错误。
2. 修正后 12 个补跑单元为 **ok 10 / blocked 2 / failed 0**。2 个阻断是新暴露的 `causal-price` 证明失效（F1），不是旧日历问题，也不构成策略结论。
3. 组合 6 个单元修正前后均为 `ok`，本次补跑逐项复现 batch1 计数；组合路径未受本次修正影响。
4. `dual-ma` / `turtle` / `rsi2` / `hold` 的 `sz000001` 单标的结果可以使用，但必须同时引用其 `offCalendarDates` 披露：4 / 3 / 3 / 39 个日历外 bar 被删除。删除只影响回放 bar 序列，不改公司行动与执行映射。
5. 本批不判断早期周末成交记录本身是否正确，也不补造交易日；该数据争议保留为数据限制。
6. 结果只覆盖当前五只标的与当前存续样本，存在幸存者偏差；不做收益排名、样本外或参数敏感性分析。
7. F1 需要单独的代码任务修复（例如在删除 bar 后重算因果价证明，或先裁剪再计算证明），batch1b 任务按边界未改代码。该修复已由后续任务完成，batch1c 复跑后两个目标单元转为 `ok`，见“F1 修复后”。

## 产物

- 批目录：`.test-data/backtest-diagnose/2026-11-22-batch1b/`
- 单标的运行：`run-2026-11-22T04-49-24.719Z-6836/`
- 组合运行：`run-2026-11-22T04-50-05.614Z-17176/`
- 12 单元汇总：`.test-data/backtest-diagnose/2026-11-22-batch1b/aggregate.json`（`statusCounts: ok 10 / blocked 2 / failed 0`）
- 计划快照：`logs/plan-per-symbol.stdout.txt`、`logs/plan-portfolio.stdout.txt`
- 运行日志：`logs/per-symbol.log`、`logs/portfolio.log`、`logs/aggregate.log`
- 每个单元含 `run.json`、`summary.json`、`diagnostics.json`、`orders.csv`、`fills.csv`、`rejections.csv`、`equity.csv`、`bars.csv`、`positions.json`；`blocked` 单元的 `run.json` 没有 `sources`
- 单标的/组合的批次内 `report.md` 由 CLI 自动生成

### batch1c 产物（F1 修复后复跑）

- 批目录：`.test-data/backtest-diagnose/2026-11-22-batch1c/`
- 运行：`run-2026-11-22T04-57-44.865Z-38980/`（3 单元，含 CLI 生成的 `report.md`）
- 汇总：`.test-data/backtest-diagnose/2026-11-22-batch1c/aggregate.json`（`statusCounts: ok 3 / blocked 0 / failed 0`）
- 日志：`logs/per-symbol.log`、`logs/aggregate.log`
- 两次命令退出码均为 0

### 命令（本批实际执行）

```powershell
$env:QUANT_DATA_DIR = "D:/github/nextjs-quant/.test-data/backtest-diagnose/data"

# 1. 单标的计划
pnpm exec tsx scripts/backtest-diagnose.ts --tdx-root E:/new_tdx64 `
  --symbols sz000001 --mode per-symbol --plan `
  --out .test-data/backtest-diagnose/2026-11-22-batch1b `
  --data-dir .test-data/backtest-diagnose/data

# 2. 组合计划
pnpm exec tsx scripts/backtest-diagnose.ts --tdx-root E:/new_tdx64 `
  --mode portfolio --plan `
  --out .test-data/backtest-diagnose/2026-11-22-batch1b `
  --data-dir .test-data/backtest-diagnose/data

# 3. 单标的 6 单元
pnpm exec tsx scripts/backtest-diagnose.ts --tdx-root E:/new_tdx64 `
  --symbols sz000001 --mode per-symbol `
  --out .test-data/backtest-diagnose/2026-11-22-batch1b `
  --data-dir .test-data/backtest-diagnose/data

# 4. 组合 6 单元
pnpm exec tsx scripts/backtest-diagnose.ts --tdx-root E:/new_tdx64 `
  --mode portfolio `
  --out .test-data/backtest-diagnose/2026-11-22-batch1b `
  --data-dir .test-data/backtest-diagnose/data

# 5. 汇总 12 单元（只读脚本，输出到本批目录）
pnpm exec tsx .test-data/backtest-diagnose/tools/aggregate.ts `
  ".test-data/backtest-diagnose/2026-11-22-batch1b/run-2026-11-22T04-49-24.719Z-6836,.test-data/backtest-diagnose/2026-11-22-batch1b/run-2026-11-22T04-50-05.614Z-17176" `
  "E:/new_tdx64" `
  ".test-data/backtest-diagnose/2026-11-22-batch1b/aggregate.json"
```

batch1c（F1 修复后复跑）：

```powershell
# 3 个单元（2 个原 blocked + hold 对照）
pnpm exec tsx scripts/backtest-diagnose.ts --symbols "sz000001" `
  --strategies "double-breakout,formula" --controls "hold" `
  --mode per-symbol --start auto --end 2026-11-20 `
  --tdx-root E:/new_tdx64 `
  --data-dir .test-data/backtest-diagnose/data `
  --out .test-data/backtest-diagnose/2026-11-22-batch1c

# 汇总 3 单元（只读脚本）
pnpm exec tsx .test-data/backtest-diagnose/tools/aggregate.ts `
  ".test-data/backtest-diagnose/2026-11-22-batch1c/run-2026-11-22T04-57-44.865Z-38980" `
  "E:/new_tdx64" `
  ".test-data/backtest-diagnose/2026-11-22-batch1c/aggregate.json"
```

批次内 `report.md` 路径：

- 单标的：`.test-data/backtest-diagnose/2026-11-22-batch1b/run-2026-11-22T04-49-24.719Z-6836/report.md`
- 组合：`.test-data/backtest-diagnose/2026-11-22-batch1b/run-2026-11-22T04-50-05.614Z-17176/report.md`
