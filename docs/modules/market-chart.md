# 行情与图表

## 职责与非职责

行情域组织证券、证券池、日历、行情来源选择和通用行情读取；图表域把行情与指标呈现为 K 线、周期聚合、策略证据、视图设置和画线。行情供应商协议归 [数据源适配](data-sources.md)，指标核心实现归 `trading-strategy-core`，不在图表组件复制。

## 入口与消费者

- UI：`src/app/market/page.tsx`、`src/components/market/`；证券与交易账本复盘也会消费行情能力。
- 应用层：`src/server/market/`、`src/server/charts/`；API procedure 有 `chartPosition`、`chartBars`、`chartView`、`saveChartView`、`tdxQuotes`、`tdxBars`、`tdxMinutes` 等，当前装配在 `src/server/api/root.ts`。
- 纯计算/契约：`src/lib/market/`、`src/lib/chart/`；主要入口包括 [chart-data.ts](../../src/lib/chart/chart-data.ts)、[chart-view.ts](../../src/lib/chart/chart-view.ts)、[chart-symbol.ts](../../src/lib/chart/chart-symbol.ts) 和 [chart-drawings.ts](../../src/lib/chart/chart-drawings.ts)。图表消费的指标实现见 `packages/trading-strategy-core/src/indicators.ts`。

## 契约与依赖

输入包括证券、周期、行情来源和可选复权/显示状态；输出保留数据日期、来源、覆盖和缺失语义。周/月图由日线聚合，不新增策略周期；主策略路径维持不复权，复权必须显式标识。SQLite `chart_views` 由 db/chart-view-store 按证券×周期保存用户视图。

方向为 UI → API → market/chart service → data-source；纯规则依赖 `src/lib`/core，供应商适配不依赖策略或回测编排。

## 状态、副作用与验证

工具区保留常用切换，指标参数、RPS、叠加对比与画线设置按需展开；两行工具区允许换行，图表高度按视口 60% 与副图最小高度共同决定。RPS 的不可用/失败/重试状态独立显示，不藏在设置中。宽窄屏溢出、弹层边界、键盘焦点和参数保存见 [工具区浏览器回归](../../tests/browser/market-toolbar-browser.mjs)，实际持久化与导航见 [P1 应用验收](../../tests/e2e/stock-pool.spec.ts)。

行情周期使用单一选择控件，F8 切换保留；证券标题与图表/财务标签共用一行，“继续研究”按需展开。数据口径可点击/键盘阅读，实际来源警告单独可见；双突破完整关键位说明在图例弹层内，图形及价格标签仍在图上。点击指标图例直接打开对应参数，隐藏缓存页或财务标签会关闭所属弹层，返回时不重新弹出。1440×900 固定应用用例按窗口顶部与画布矩形交集核验首屏可见高度至少 540px，不能仅以画布自身高度代替；该用例含成交量、MACD、RPS 与来源警告，不代表全站或任意指标组合的布局验收。

本地 TDX/Blocks 源只读；外部市场源按调用产生网络请求；图表设置和缓存写入应用 SQLite/进程内缓存。快照用例由 [snapshot.ts](../../src/server/market/snapshot.ts) 承担，runtime 负责调度。关键约束见 [invariants §1–2](../invariants.md#1-指标只有一个实现入口) 与 [architecture 图表/数据章节](../architecture.md)。代表测试：[q1-chart](../../tests/market-chart/chart/q1-chart.test.ts)、[chart-data](../../tests/market-chart/chart/chart-data.test.ts)、[market-source-selection](../../tests/market-chart/market-source-selection.test.ts)、[weekly-bars](../../tests/market-chart/market-data/weekly-bars.test.ts)。

**图表渲染生命周期**（`MarketChart`）：原生图表只在挂载、周期、价格精度或视口键变化时创建。其余按层原地更新：外观与手势（深色、拖动模式）用 `applyOptions`；日志坐标与画线集合各自一层；基础层（K 线、缠论/双突破线与标记、成本线）只在数据或结构变化时重写；副图 pane 按"锚 series"识别做差异增删与 `moveTo` 排序，不动其他 pane；指标线单独一层。视口只在数据本身变化时重置。长期存活的回调通过 `live` ref 读最新 props，不得把画线/悬停等交互状态放进创建图表的依赖。交互性能用 [chart-perf-browser.mjs](../../tests/browser/chart-perf-browser.mjs) 复测（真实 Chrome、合成 K 线，每操作主线程耗时中位数与重建次数；`SHOT=1` 另存截图）。

**渲染职责**（2026-11-13）：[chart.tsx](../../src/components/market/chart.tsx) 保留视图状态、查询装配、控件与 effect 顺序；[instance](../../src/components/market/market-chart-instance.ts) 创建和销毁原生实例并管理历史加载帧；[drawings](../../src/components/market/market-chart-drawings.ts) 管理画线 DOM 事件；[structure](../../src/components/market/market-chart-structure.ts) 只投影既有 CZSC 结果；[base](../../src/components/market/market-chart-base.ts) 更新行情/对比/结构/成本图层；[indicators](../../src/components/market/market-chart-indicators.ts) 维护副图身份和指标数据；[legend](../../src/components/market/market-chart-legend.tsx) 显示当前光标数据及关键位。纯指标算法、原生 DLL 和服务端执行边界不变。

价格精度改变会重建实例，保存画线与跨周期共享画线都必须重新应用；主题、数据、指标开关继续原地更新。卸载移除窗口事件、取消待执行历史加载帧并销毁 chart，十字光标订阅由对应 effect 释放。[生命周期浏览器检查](../../tests/browser/chart-lifecycle-browser.mjs) 覆盖精度/视口身份变化和连续卸载重挂；缺失清理及旧共享画线依赖均有已复现负例。

**键盘操作**（对齐通达信常用键位）：图表内与行情/加密/期货页（`hotkeys`，焦点不在输入框或弹层时）均可用 ←/→ 逐根移动光标（首按落在最后可见根，出界时最小滚动）、↑/↓ 以右边界为锚缩放、PageUp/PageDown 在已有导航列表中换股；没有换股列表时由图表翻屏、Home/End 到最早/最新、Esc 退出光标；F8 轮换周期（`usePeriodHotkey`），F10 展开并定位公司资料；行情页键盘精灵识别周期码 D/W/MO/M5/M15/M3/M6（精确匹配，列在证券结果之前）。纯逻辑在 `keyboardCursor`/`keyboardPage`/`keyboardRange`（chart-view.ts）与 [chart-hotkeys.ts](../../src/components/market/chart-hotkeys.ts)；键位与事件接线测试见 [chart.test.ts](../../tests/market-chart/chart/chart.test.ts)。F5 在 K 线与分时之间切换（A 股证券；跨证券切换保持所选模式）。

**分时图**（[intraday-chart.tsx](../../src/components/market/intraday-chart.tsx)，纯逻辑 [intraday.ts](../../src/lib/chart/intraday.ts)）：价格线、均价线（累计 价×量 / 累计量；TDX 均价为 成交额/成交量，分钟点无成交额，属近似并在界面注明）、昨收虚线、左涨跌幅/右价格两轴以昨收为中心对称、分钟成交量按与上一分钟比较着色；横轴固定 240 个交易分钟（09:31–11:30、13:01–15:00，按分钟收盘时刻标注），当日未走完的分钟留空；1–5 日（Alt+1…5）。数据：当日 `tdxMinutes`/`tdxQuotes` 按交易时段刷新，历史日 `tdxMinutes(date)`，昨收与交易日来自日线。**实时分时与快照都不带日期，时段时钟也没有节假日日历**，因此实时分时所属交易日由"实时昨收 = 前一交易日日线收盘"推出（`liveIntradayDay`）；日线尚未包含该日时按今天标注并显示"?"。浏览器验证 [intraday-browser.mjs](../../tests/browser/intraday-browser.mjs)（桩 tRPC、合成数据）。

**画线**（[chart-drawings.ts](../../src/lib/chart/chart-drawings.ts)）：趋势线、水平线、矩形、斐波那契、射线、平行通道（第三点定宽）、文字、测量（价差/涨跌幅/根数）。`drawingGeometry` 是绘制与命中测试共用的像素几何；浏览状态下点中图形即选中（端点白圈），拖端点改形、拖线身整体平移（按移动后的像素重新吸附到真实 K 线与价格，拖动期间暂停图表平移），Delete 删除、Esc/点空白取消选中，松手后经视图自动保存落库。schema 只追加可选字段 `c`/`text`，旧视图照常解析。浏览器验证 [chart-drawings-browser.mjs](../../tests/browser/chart-drawings-browser.mjs)（桩 tRPC 下的完整 ChartWorkspace）。

**叠加对比**（TDX 叠加 / TradingView compare）：A 股 K 线可叠加最多 3 只 A 股；有叠加时主坐标切为自可见区首根起的百分比（lightweight-charts `Percentage`），叠加线按主图日期对齐（对方无该日即留空，不向时间轴插入新时点），图例显示叠加品种收盘价。数据走只读 `compareBars`（本地通达信、不复权、与 `chartBars` 同一套周期合成，不写快照记录）。浏览器验证 [chart-compare-browser.mjs](../../tests/browser/chart-compare-browser.mjs)。

## 维护指南

组件指纹守卫（R2/R2b/N3）覆盖本模块多个文件；有意修改后先审 diff，再用 `npx tsx scripts/refresh-component-fingerprints.ts <文件>` 更新。新增来源先加到数据源适配并定义失败/时效语义；新增展示或图表交互放对应 market/chart 层；改变周期、复权、null 或成本线语义时同步更新不变量文档和固定输入测试。
