# 全谱缠论、双向双突破与五类形态突破

## 背景与范围

三类方法为批量筛选、策略观察和图表复核提供可回查的信号证据。批量筛选按完成 K 线判定。

| 方法 | 识别口径 |
| --- | --- |
| 全谱缠论买卖点 | 以 `czsc-tdx` v22 的端点、信号、中枢、走势、诊断表及 `breakouts` 为输入。笔级（0）和段级（1100）共用九类双向标签，覆盖 `1B/1S`、`P1B/P1S`、`2B/2S`、`L2B/L2S`、`3B/3S`、`STB/STS`、`NB/NS`、`ZYB/ZYS`、`KB/KS`。图表标注结构端点，筛选按确认日判定。已撤销信号（`revokedAt >= 0`）排除。 |
| 双向双突破 | 向上同时越过下降趋势线和上方关键位，向下同时跌破上升趋势线和下方关键位。以候选日前 60 根完成 K 线查找已确认波段点。遇到反趋势回抽使最近一对波段点斜率反向时，在窗口内回溯可用锚点，检查候选趋势线是否已被先前收盘穿越。量比以此前 20 根 K 线计算。 |
| 五类核心形态突破 | 头肩底 `head-shoulders-bottom`、头肩顶 `head-shoulders-top`、箱体 `box`、三角形 `triangle`、楔形 `wedge`。检测结果包含方向、突破位、结构失效位、量度目标、评分及绘图几何。头肩形态绘制颈线和轮廓，其余形态绘制上下边界。 |

原生版本与配置见 [CZSC v22 算法接入](2026-11-08-czsc-v22.md)。

## 筛选、策略记录与图表的联动

### 量化筛选（`/scan`）

服务端提供 `screening.patternScreenPresets` 和 `screening.patternScreenRun`。可按缠论点位代码、方向、笔段配置与质量筛选，双突破和五类形态使用各自的方向与阈值。服务在回看窗口内按完成日线从近到远检查。`any` 接受任一启用族命中，双突破或形态先命中时可跳过原生缠论计算。`all` 要求所有启用族在同一根 K 线上命中。

候选返回冻结快照 ID 及信号收盘价。原价与信号价按日期对齐，`rawClose` 取信号日原价，`rawStopPrice` 和 `rawTargetPrice` 以该日 `rawClose / signalClose` 换算首条命中的止损和目标。缺少止损或目标时保留空值，缺少原价时记录该证券的错误。冻结快照保留截至信号日的前复权和原价序列，供候选复核。

`/scan` 公式工作区新增「结构与形态突破」页签（[PatternScreenPanel](../../src/components/screening/pattern-screen-panel.tsx)、[ScanWorkspace](../../src/components/screening/scan-workspace.tsx)）及公式编辑器标准模板下拉（[FormulaScreen](../../src/components/screening/formula-screen.tsx)），点击候选行即可在右侧打开对应的冻结快照 K 线图。服务端实现见 [筛选服务](../../src/server/screening/pattern-screen-service.ts)。

### Signals、StrategyObject 与 Ledger

`StrategyObject` 支持 `pattern-breakout`、`czsc-monitor`、`chan-third-buy` 和双向 `double-breakout`。策略信号使用已记录证据生成决策原因，展示形态评分和价格位、缠论标签和端点日期、三买起算索引，以及双突破方向和条件检查。原生缠论监控用策略版本、证券和观察键维护新增信号。

当前台账记录原生一至三类买卖点及双向双突破，双突破的去重键包含方向。五类形态和缠论衍生类别的独立台账记录待接入。见 [策略规则](../../packages/trading-strategies/src/strategy-object.ts)、[台账引擎](../../src/server/monitoring/signal-ledger-engine.ts)。

### K 线图层

图表默认开启缠论和双突破。缠论图表请求包含结构表，可绘制扩展标签。双突破使用紫色上箭头 `双突破↑` 和绿色下箭头 `双突破↓`，趋势线绘制到所选 K 线。

形态图层默认关闭（`{ breakout: true, czsc: true, patterns: false }`），勾选图表工具栏「形态突破」复选框后按需请求 `strategy.patternBreakout` 并通过 `patternChartData` 绘制方向箭头、评分与对应几何线（头肩轮廓/颈线、箱体上下沿、三角形与楔形收敛轨）。见 [CzscMarketChart](../../src/components/market/charts/czsc-market-chart.tsx)、[MarketChart](../../src/components/market/charts/market-chart.tsx)、[MarketChartBase](../../src/components/market/market-chart-base.ts)、[图表接口](../../src/server/api/routers/strategy.ts)、[图层数据](../../src/lib/chart/chart-data.ts)。

## 验证

在仓库根目录运行以下 PowerShell 命令。

```powershell
pnpm packages:build
pnpm exec vitest run tests/strategy-signals/methods/pattern-breakout-screen.test.ts tests/market-chart/chart/chart-data.test.ts tests/screening-rps/pattern-screen-service.test.ts tests/strategy-signals/decision-reason.test.ts tests/strategy-signals/strategy-display.test.ts tests/strategy-signals/strategy-drivers-golden.test.ts
pnpm --filter trading-strategies exec vitest run tests/chan-signal-evaluator.test.ts tests/double-breakout.test.ts tests/pattern-breakout.test.ts
pnpm exec tsc --noEmit --incremental false
```

| 验证项 | 覆盖 |
| --- | --- |
| 缠论图层 | 以固定原生表样本生成全部 18 个方向标签，校验标记日期、箭头和位置，覆盖撤销索引为零和正数。 |
| 双突破图层 | 从镜像行情计算双向突破，核对颜色、箭头和文字，以及视窗截断后的趋势线起止价。规则回归另覆盖 60 根窗口、反向锚点回溯和先前收盘穿线。 |
| 五类形态图层 | 从固定行情检测五类形态，核对日线标记方向、颈线、轮廓或上下边界坐标，并检查选中日期之前的图层输出。 |
| 决策说明 | 对照人可读文本，覆盖四类策略，其中双突破分别校验向上和向下。 |
| 批量筛选 | 校验代码和方向过滤、双向双突破、逐类形态筛选、`any` 与同日 `all`，以及三个原价字段和冻结快照内容。 |

应用定向回归 6 个文件、107 项通过，其中[本次集成测试](../../tests/strategy-signals/methods/pattern-breakout-screen.test.ts) 22 项。策略包回归 3 个文件、94 项通过。新增测试替换行情读取、原生投影调用及持久化 I/O，实际执行分类、规则、筛选、图层映射和快照序列化。定向验证使用 Vitest 的临时环境，无需在 `.test-data/` 下创建测试库。原生 DLL 实机、浏览器交互及完整台账写入在本轮验证范围之外。
