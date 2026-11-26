# 用户实测反馈记录（2026-11-25）

记录用户实测量化软件过程中提出的界面、交互与数据意见，按编号持续追加，并跟踪多 Agent 工作流的解决与验收状态。

反馈 #1–#20 已在 `master@d73c2534` 一并交付。后续浏览器／原生回归由 [Wave 0 / Iteration 5](2026-11-25-iter5-v040-plan.md#wave-04-实施拓扑) 承接，回归项列在总览下方。

## 反馈总览

| 编号 | 模块 / 页面 | 问题摘要 | 状态 | 关联改动与验证 |
| :--- | :--- | :--- | :--- | :--- |
| **#1** | 今日交易 / 今日计划（`/`）— 明日交易候选 | 标的、对应策略、交易理由混在一列；交易理由过长需缩略展示且悬浮显示全文；增加当前价格 / EMA5 / EMA20 展示 | 已完成 | Wave 1 实现，Wave 2–3 收口报价时点和缺数。 |
| **#2** | 今日交易 / 今日计划（`/`）— 页内快捷跳转 | 去掉「市场温度与行业轮动 / 精准快讯 / 次日调仓计划单」页内跳转导航；固化设计规则：同一页面不重复放置类似左侧菜单栏的导航条 | 已完成 | Wave 2 清理页内导航，规范见 [conventions.md](../conventions.md)。 |
| **#3** | 今日交易 / 今日计划（`/`）— 市场温度计 & 30 行业相对轮动 | 底部小字报原始错误 `冻结面板不可用：Error: ENOENT ... market-panel/current.json`，且缺少生成冻结面板的入口 | 已完成 | Wave 2 接入构建任务，Wave 3 收口路径、错误和轮询边界。 |
| **#4** | 今日交易 / 今日计划（`/`）— 布局空间利用率 | 「明日交易候选」独占一整行，「进行中交易计划」与「持仓止损监控」并排拼成单独一行 | 已完成 | Wave 2 完成候选与计划卡片布局。 |
| **#5** | 选股筛选 / 强势排名 RPS（`/scan?tab=rps`）— 行业与概念视图 | 参考「个股」RPS 样式重构「行业」「概念」排名工具栏与多周期表格；将板块成分来源/外部 Blocks 目录配置迁至「系统设置 / 数据源设置」；隐藏成分/剔除原因/名单文件证据/幸存者偏差与时点审计等对交易无用的数据，静默剔除 ST | 已完成 | Wave 3 实现，Wave 4 收口 P1，Wave 5 同步回归断言。 |
| **#6** | 今日交易 / 板块估值（`/scan?tab=valuation`） | 通达信本地 `BK5` 估值与分位严重失真（多板块全挤在 `0.17% / 0.10%` 且 10 年全缺失）；切换为与财联社新闻脚本（`news-sector-analyzer/scripts/analyze.py`）同源的腾讯自选股 `westock-data` 申万一级/二级估值（PE-TTM / PB-LF / 股息率及历史分位） | 已完成 | Wave 4 实现并完成浏览器验收，Wave 5 收口 P1/P2，Wave 6 合入浏览器用例。 |
| **#7** | 今日交易 / 涨停与情绪（`/scan?tab=sentiment`） | 涨停概念分布点击不再错误联动筛选上方涨停池（仅在概念分布右侧展示对应成分股）；在「涨跌停按日」模块下方新增展现形式类似的「涨跌家数按日」情绪参考曲线与明细 | 已完成 | Wave 4 单元测试及双浏览器夹具通过。 |
| **#8** | 行情看盘 / A 股看盘（`/scan`）— 指标参数与缠论口径 | 双突破/缠论结构/形态突破支持像其他指标一样通过芯片 `⚙` 配置具体应用参数；缠论结构图上只显示标准一/二/三类买卖点（去掉均线吻等）；对照 `E:\new_tdx64\T0002\dlls\czsc-presets.ini` 与 `D:\github\czsc-tdx` 对齐中枢与笔段默认口径 | 已完成 | Wave 5 完成参数与缠论口径，Wave 6 修复语义过滤并更新浏览器定位。 |
| **#9** | 行情看盘 / A 股看盘（`/scan`）— 图表新闻事件 | 将图表下方「图表新闻事件」重构为动态 WebView 加载财联社官方搜索页（`https://www.cls.cn/searchPage?keyword=<标的关键词>&type=all`），桌面端原生 WebView 嵌入、浏览器端优雅降级 | 已完成 | Wave 6 完成新闻面板与桌面 WebView 白名单验证。 |
| **#10** | 行情看盘 / A 股看盘（`/scan`）— 左侧临时列表上下文联动 | 从行业成分股、概念成分股、RPS 排名列表、连板梯队/涨停池跳转至看盘时，左侧临时列表自动展开并切换展示对应来源的股票列表，支持点击切股与 `PgUp/PgDn` 同步 | 已完成 | Wave 6 接通临时列表，Wave 7 收口重进展开与列表完整性。 |
| **#11** | 行情看盘 / A 股看盘（`/scan`）— 形态突破算法与绘制重构 | 修复形态突破在实盘 K 线上出现「向空处外推斜线、同位置多形态重叠、14 条虚线织成蜘蛛网、低分噪点过多」问题：轨道严格锚定真实极值点并校验贴合度、同 K 线择优与冷却去重、图表默认仅绘最新有效形态轨道线且默认最低评分 3/5 | 已完成 | Wave 5 完成重构，Wave 6 修复评审 P1。 |
| **#12** | 行情看盘 / A 股看盘（`/scan`）— 双突破算法重构优化 | 重构双突破使其严格回归「向上突破下降趋势线（或 MA20）+ 近期压力位 / 向下跌破上升趋势线（或 MA20）+ 近期支撑位」：修复趋势线在最新高/低点对失效时过早放弃搜索的问题、剥离整数关口等伪关键位干扰、在图表默认启用「趋势线优先 / MA20 替代」与「严格近期压力/支撑位」并支持在 `双突破 ⚙` 中切换 | 已完成 | Wave 5 完成重构，Wave 6–7 收口评分与绘线一致性。 |
| **#13** | 选股筛选 / 问财选股（`/scan?tab=wencai`）— 补全中文名、最新价与涨跌幅 | 问财结果表只显示代码、缺少中文名/价格/涨跌幅：接入 `useSecurityNames()` 与 `api.overviewQuotes`（仅在有查询结果时按需批量拉取）补全「证券中文名」「最新价」「涨跌幅」列，并同步接入 `<BrowseSource>` 使点击跳转看盘时左侧临时列表展示问财选股结果 | 已完成 | Wave 6 完成报价、名称与临时列表联动，缺失显示 `—`。 |
| **#14** | 全局布局 — 收缩「策略运行台 / 部署到策略运行台」至策略相关页面 | 移除今日计划/大盘总览/看盘/板块估值/涨停/RPS/问财/股票池等非策略页右上方整行占空的「策略运行台 / 部署到策略运行台」按钮条；将「策略运行台」收进左侧「策略回测」菜单，并在策略相关页（组合回测、Alpha 研究、公式选股）改为紧凑行内小按钮不额外占一整行 | 已完成 | Wave 6 完成策略运行台导航与紧凑部署入口。 |
| **#15** | 策略回测 / 策略库（`/lab`）— 补充通俗使用说明与逐阶段通关指引 | 策略库「六阶段晋级流水线」与「定义冻结 · 缺少冻结输入哈希」等提示过于工程化；新增折叠式「使用说明」与各阶段直白操作引导（明确告知跑一次「用此策略对象回测」即可同时通过第 1/2 阶段，以及后续 3–6 阶段的具体推进入口） | 已完成 | Wave 6 完成六阶段说明与直达指引。 |
| **#16** | 持仓复盘 / 模拟账户（`/accounts?tab=paper`）— 同花顺模拟/实盘与本地模拟账户平行管理 | 当前同花顺模拟只接了一半且深埋在「手工记账」下以原始 JSON 调试面板呈现，缺少同花顺实盘账户平行入口；将模拟与账户工作区重构为「本地模拟账户」「同花顺模拟账户」「同花顺实盘账户（桥接/只读查账，DPAPI 加密凭证+受实盘总开关保护）」三列平行视图，并同步接入部署向导 | 已完成 | Wave 7 交付平行账户，Wave 8 收口凭证安全与回归。 |
| **#17** | 行情看盘 — A 股 / 数字货币 / 期货直接模拟下单 | 按 `product-delivery` 产出功能规格（`docs/market-chart/2026-11-25-chart-direct-sim-order-spec.md`）：三大看盘页工具栏新增「模拟下单」弹窗（预填当前标的与最新价、快捷仓位、两步预览确认、无账户一键建户），A 股支持本地模拟与同花顺模拟双通道、数字货币对接 USDT 模拟盘、期货新增双向多空保证金轻账本 | 已完成 | Wave 8 交付三市场入口，Wave 9 收口乘数、成本、报价日期及回执，见[下单规格](../market-chart/2026-11-25-chart-direct-sim-order-spec.md)。 |
| **#18** | 股票池 & 全局 UI — 去掉「上一只/下一只」并彻底移除全站页面中的「生存者/幸存者偏差」与时点审计显示 | 股票池已改为无限滚动，移除无用的「上一只 / 下一只」按钮与底部「时点审计 / 生存者偏差」卡片；同步清理看盘图 RPS 提示、行业 RPS 状态、策略对比与数据说明等所有页面 UI 中残留的「生存者偏差 / 幸存者偏差」显示 | 已完成 | Wave 6 清理界面，Wave 7 核对残留。 |
| **#19** | 全站交易术语 — 将 `shadow` / `live` / `影子` 等生僻词统一汉化为直白中文交易术语 | 统一将界面中的 `shadow / 影子观察 / 影子模式 / 影子前推` 改为「空跑观察 / 空跑验证（只记不推不下单）」，将 `live 提醒 / 开启 live 提醒 / 暂停 live 提醒` 改为「正式提醒 / 开启正式提醒 / 暂停正式提醒」，将 `manual_confirm / auto_sim / auto_live` 等英文枚举在说明文案中全部替换为中文（含左上角 `提醒影子` → `提醒空跑`） | 已完成 | Wave 8 完成术语更新，Wave 9 补齐研究页面文案。 |
| **#20** | 选股筛选 / 历史信号（`/accounts/alerts`）— 重梳理信号分类并消除「移动止损」策略名与「入场候选」信号类型的混淆 | 排查确认「区间公式 · 移动止损」出现在「入场候选」下是因为策略名把出场规则后缀直接拼成 `· 移动止损`，极易误读为移动止损卖点信号；改为清晰标注策略出场规则（如 `区间公式（移动止损出场）`），并将历史信号的 11 个扁平提醒类型重构为四大交易分组（买入/入场、卖出/止盈止损、计划与成交、风控与状态）加彩色方向徽章 | 已完成 | Wave 8 完成分类、方向徽章和策略显示名更新。 |

### Wave 0 / Iteration 5 回归

- 浏览器覆盖 #3、#6、#8–#13、#17 的面板生成与状态恢复、申万估值可用／不可用、图表指标参数、榜单临时列表、新闻面板降级和三市场模拟下单。以现有夹具固定已交付行为，再补不同宿主下的交互证据。
- Electron 原生覆盖 #8–#10、#16–#17 的缠论 DLL 与图表焦点、CLS WebView 白名单与切换、平行账户隔离、预览确认和成交回执跳转。依赖真实行情或登录的成功态按可用环境记录。

---

## 详细记录

### #1 今日计划 — 交易候选列拆分、理由缩略悬浮与当前价/EMA5/EMA20

- **提出时间**：2026-11-25 13:56
- **用户诉求**：
  1. 将「标的」「对应策略」「交易理由」分列展示；
  2. 「交易理由」默认缩略展示，鼠标悬浮时完整展示全文；
  3. 增加「当前价 / EMA5 / EMA20」展示列。
- **实现进展**：Wave 1 已落地 `src/server/alerts/candidate-metrics.ts`（复用 `~/lib/indicators` 唯一 `ema` 实现，缺数与预热不足严格返回 `null`）、`CandidateTable` 分列 + 截断与 Radix `Tooltip` 悬浮全文、`TodayWorkspace` 非阻塞接入 `overviewQuotes` 实时价；Wave 2 已完成空日线 `adjustment: null`、`assertCurrent()` 后置与报价错误回落修复；Wave 3 收口无日期实时报价不覆盖有日期本地收盘价的边界。

---

### #2 去掉页内快捷跳转导航，固化「页面不重复左侧菜单式导航」规范

- **提出时间**：2026-11-25 14:01
- **用户诉求**：去掉「今日交易 / 今日计划」页内的 `市场温度与行业轮动 / 精准快讯 / 次日调仓计划单` 快捷跳转条，并长期记住同一页面不再重复放置类似左侧菜单栏的导航条。
- **实现进展**：Wave 2 已从 `src/components/overview/today-workspace.tsx` 移除 `<nav aria-label="作战室面板">`，并将该规范固化至 [conventions.md](../conventions.md) §4 UI。

---

### #3 市场温度计 & 30 行业相对轮动报「冻结面板不可用：ENOENT current.json」

- **提出时间**：2026-11-25 14:01
- **根因定位**：`marketTemperature` / `industryRotationRrg` 按只读不变量不自动建盘，`MarketPanelStore.build()` 此前仅在 Alpha 实验室调用；且缺盘时直接将原始 `ENOENT` 文件路径透出到界面。
- **实现进展**：Wave 2 已将缺盘提示改为友好中文（零 `ENOENT` 路径泄露）、新增 `worker.ts` `market-panel-build` 任务与 `marketPanelStatus` / `marketPanelBuild` 接口，并在两张卡片右上角接入「生成冻结面板」一键按钮与完成后自动刷新；Wave 3 收口 4 项 P1（统一 `tdxRoot` 回退根目录、将只读查库下沉到 `src/server/db/jobs.ts`、全面脱敏其余 catch 路径错误、修复重试/重挂载轮询状态机）。

---

### #4 布局调整：「明日交易候选」独占一整行，「进行中交易计划」与「持仓止损监控」并排拼一行

- **提出时间**：2026-11-25 14:01
- **实现进展**：Wave 2 已将 `明日交易候选` 移出 `nc-cockpit-grid` 独占 100% 整行，下方将 `进行中交易计划` 与 `持仓止损监控` 放入两列 `nc-cockpit-grid` 并排展示。

---

### #5 强势排名 RPS — 行业/概念对齐个股样式、配置迁至数据源设置、移除无用审计与幸存者偏差噪音

- **提出时间**：2026-11-25 14:45（14:48 补充两张截图）
- **用户诉求**：
  1. 「行业」与「概念」参考「个股」RPS 的工具栏与多周期表格样式重构；
  2. 将「板块成分来源 / 外部 Blocks 根目录 / 核对板块成分变化」迁移至「系统设置 / 数据源设置」（`/system` `DataSection`）；
  3. 隐藏「成分 / 有效 / 端点不足」「剔除原因及数量」「名单文件证据」「行业口径与保留策略」「本次结果的证券池含生存者偏差 / 时点审计 / 审计开始与结束 / 池内标的」等对交易无用的数据，静默剔除 ST 即可（`packages/quant-rps` 已静默剔除 ST）；并同步清理 RPS 界面的「生存者偏差」文案。
- **实现进展**：Wave 3 完成重构，Wave 4 `wave3-p1-fixups` 修复全部评审 P1（含显式 `null` 缺失周期与 `/system` 变更明细恢复），Wave 5 同步更新旧回归断言。

---

### #6 板块估值数据错误 — 改用与财联社新闻脚本同源的腾讯自选股（`westock-data`）申万行业估值

- **提出时间**：2026-11-25 14:53
- **现象与截图**：当前板块估值页读取通达信本地 `gpsh<code>.dat`（BK5/BK6），不仅只有 2018-08 起 2000 条导致 10 年分位全部「历史不足」，且本地 BK5 数值异常导致有色、稀有金属、电池、食品助剂、休闲食品等大量板块 PE 5 年分位全部挤在 `0.17%`、全历史分位 `0.10%`，完全失真。
- **对照核实**：
  - 财联社新闻脚本（`news-sector-analyzer/scripts/analyze.py` `fetch_valuations`）通过 `westock-data` CLI（`sector valuation <pt01codes> --raw`，每批 30 码）拉取申万 2021 一级（31 个）+ 二级（123 个）行业指数的 `PeTTM`/`PeTTMPct`、`PbLF`/`PbLFPct`、`DivTTM`/`DivTTMPct` 及周/月/季/年对照；
  - 实测 2026-11-24 腾讯源：有色金属 PE 11.14（分位 16.62%）、PB 2.20（分位 35.61%）、股息率 2.19%（分位 84.06%）；电子 PE 37.32（分位 56.68%）、PB 4.82（分位 84.20%），准确清晰。
- **方案设计（Wave 4）**：
  - 内置 `src/lib/financial/sw-sector-codes.ts`（31 一级 + 123 二级申万代码与归属）与 `src/lib/financial/sw-sector-valuation.ts` 契约；
  - 新增 `src/server/financial/sw-sector-valuation.ts` 复用仓库现有 `westockScriptPath()` + `query()` 分批（30 码/批）拉取并带 10 分钟内存缓存与强刷新，注册 `financialRouter.swSectorValuation`（`financial/read`），保留既有 `sectorValuation` 不破坏历史测试；
  - 升级 `SectorValuationView` 为申万一级/二级估值视图（含二级按一级筛选、名称搜索、PE/PB/股息率及分位排序、亏损标注、缺失显式标「不可得」绝不伪造 0%）。
- **实现进展**：Wave 4 完成实现与浏览器验收，Wave 5 `wave4-p1-fixups` 修复全部评审 P1/P2（批次失败不污染缓存、PE 分位盈利/亏损分组排序、越界分位校验、`不可得` 文案与刷新缓存失效），`sector-valuation` 浏览器用例同步合入 Wave 6。

---

### #7 涨停与情绪 — 解除概念分布对上方涨停池的联动，并在涨跌停按日下新增涨跌家数按日

- **提出时间**：2026-11-25 14:58
- **用户诉求**：
  1. 「涨停概念分布」的点击联动不要影响上方的「涨停池」（当前点击概念会把上方涨停池强制切换并过滤为该概念）；
  2. 在「涨跌停按日」模块下方新增一个「涨跌家数按日」情绪参考模块，展现形式与「涨跌停按日」类似（双线趋势图 + 最新家数图例 + 可折叠逐日明细表）。
- **方案设计（并入 Wave 4，与 #6 文件完全正交）**：
  - **后端（`src/server/market/limit-history.ts`）**：复用同一次 `gpsh999999.dat` 本地读取，补充按日 `SC31`（上涨家数 / 下跌家数，最多 60 个记录日、缺失/重复语义与 SC3/SC4 一致）为 `LimitHistory.breadth` 字段（零额外磁盘 IO，保持既有字段完全兼容）。
  - **前端（`limit-up-view.tsx` & `limit-daily-trend.tsx`）**：
    - `limit-up-view.tsx`：将「涨停概念分布」的选中状态改为该面板内独立状态 `selectedConceptCode`，点击概念仅切换右侧「概念对应成分股」表格，彻底解除对上方涨停池的切换与筛选联动（并移除会改动上方池筛选的「仅看该概念涨停池」按钮）；
    - `limit-daily-trend.tsx`：在「涨跌停按日」面板下方新增风格一致的「涨跌家数按日」区域/面板（红实线上涨家数、绿虚线下跌家数、0 起点纵轴、最新家数图例与可折叠逐日明细表）。
- **实现进展**：Wave 4 已完成实现并通过 `limit-up-first-seal` 与 `limit-history` 浏览器验收。

---

### #8 A 股看盘 — 双突破/缠论结构/形态突破统一参数配置、缠论仅显标准 1/2/3 买卖点、对齐 `czsc-tdx` 中枢口径

- **提出时间**：2026-11-25 15:02
- **用户诉求**：
  1. 「双突破」「缠论结构」「形态突破」支持像其他指标（`MA`/`EMA`/`BOLL`/`MACD` 等）一样配置具体应用参数；
  2. 「缠论结构」图上只显示标准一类、二类、三类买卖点（`1买/2买/3买/1卖/2卖/3卖`），不要显示「均线吻」等额外标注；
  3. 对照参考项目 `D:\github\czsc-tdx` 核查为何相同 `CZSC64.dll` 画出的中枢不一致。
- **对照 `E:\new_tdx64\T0002\dlls` 与 `D:\github\czsc-tdx` 逐项核查结论**：
  1. **DLL 与 FFI 结构体本身完全一致**：`E:\new_tdx64\T0002\dlls\CZSC64.dll`、`vendor/czsc/CZSC64.dll`、`runtime/czsc/CZSC64.dll` 与 `D:\github\czsc-tdx\build\CZSC64.dll` 四者 SHA-256 完全相同（`257ECBFCE519AB8790D637386BF56B2860E5678F8854F86B4D4A3E82EFB00CAE`）；
  2. **中枢与笔段差异根因 #1 — 未对齐实机 `czsc-presets.ini` 与预设 2 口径**：通达信实机 `E:\new_tdx64\T0002\dlls\czsc-presets.ini` 在预设 `[0]/[1]/[2]` 上显式配置了 `stroke.rule=new`（1，新笔）、`stroke.endpoint=bounded`（2，区间包络）、`segment.startBreak=revise`（1，修正前段），叠加预设 2 内置 `center.strokeFormation=segment`（1，服从所属线段）与 `projection.centerBox=initial`（0，前三构件）；而本仓原先仅配了 `projection.centerBox: 0`，其余 4 项均留在 DLL 裸默认值（严格笔 / 极值延伸 / 不回改 / 按进入段），导致笔、线段和中枢均与通达信主图不符；
  3. **中枢差异根因 #2 — 默认叠加绘制了线段中枢**：`chan-main.txt` 主图仅绘「笔 + 线段 + 笔中枢」，不默认叠加「线段中枢」；本仓原先 `showSegment: true` 把线段连线与线段中枢、线段买卖点捆绑同时绘出，造成大框压小框视觉错乱；
  4. **「均线吻」来源定位**：`src/lib/chart/chart-data.ts` 中 `czscChartMarkers` 在有结构表时调用了研究分类器 `classifyCzscSignals`，将 `均线吻`（`K`）、`区间套`、`中阴`、`小转大` 等全部注入了主图标记；而 DLL 原始 `family.signals` 本身就只含标准 1/2/3 买卖点（与 `chan-main.txt` 一致）。
- **方案设计（Wave 5）**：
  - **缠论中枢与买卖点对齐实机通达信**：`chartCzscDefaults` 升级为 `{ "stroke.rule": 1, "stroke.endpoint": 2, "segment.startBreak": 1, "center.strokeFormation": 1, "projection.centerBox": 0 }`（持久化 `version: 3` 平滑迁移，保留用户显式修改项）；拆分「线段连线」（默认开）、「线段中枢」（默认关）、「线段买卖点」（默认关）；`czscChartMarkers` 仅输出标准 `1/2/3` 买卖点，彻底移除图上 `均线吻` 等非标准标记（研究与选股模块默认口径及分类器不受影响）；
  - **三大结构指标统一芯片 + 参数配置**：将工具栏中「双突破」「缠论结构」「形态突破」从裸复选框升级为与 `MA/EMA/MACD` 统一的 `IndicatorChip`（点击切换显示，点击 `⚙` 打开对应参数配置面板/弹窗），新增持久化 `useOverlaySettings` 并将「双突破」参数（方向、最小放量倍数、最少指标共振数、最低评分、最少触点数、要求实体 K 线）与「形态突破」参数（形态类型多选、方向、最小放量倍数、最低评分）真实传入后端计算与图表过滤，即时生效；移除底部 `联动周期` 旁重复的「缠论设置」按钮。
- **实现进展**：Wave 5 主体实现（5 项 TDX 参数对齐 + `IndicatorChip` 统一参数芯片 + 线段中枢/买卖点默认拆分）与 125 项单测已完成；`wave5-sol-review` 检出的缠论 `盘背1/2+3/小转大` 语义过滤与旧浏览器用例定位同步已合入 Wave 6 `wave5-p1-fixups` 并行修复。

---

### #9 A 股看盘 — 下方「图表新闻事件」重构为动态 WebView 加载财联社搜索页

- **提出时间**：2026-11-25 15:10
- **用户诉求**：将 K 线图下方的「图表新闻事件」重构为动态 WebView，按当前标的关键词拼接财联社官方搜索页 URL 动态加载（如 `https://www.cls.cn/searchPage?keyword=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0&type=all`）。
- **方案设计（Wave 6）**：
  - **Electron 安全宿主（`electron/main.ts`、`electron/preload.ts`）**：开启 `webviewTag: true`，通过 `will-attach-webview` 严格白名单校验仅允许 `https://www.cls.cn/` 与 `https://*.cls.cn/`、剥离 preload、强制 `nodeIntegration: false` + `contextIsolation: true` + `sandbox: true`，并通过 `window.quantDesktop.supportsWebview` 暴露桌面端能力；
  - **动态新闻面板（`src/lib/news/cls-search-url.ts`、`src/components/news/intel-annotations.tsx`、`src/components/market/chart-workspace.tsx`）**：根据当前标的名称（无名称时回退 6 位代码）构造财联社搜索 URL；桌面端原生渲染 `<webview>`（支持切换标的自动跳转、关键词微调、后退/前进/刷新/展开收起/浏览器打开），浏览器端优雅降级为嵌入预览 + 新标签页打开链接；保留 `aria-label="图表新闻事件"` 语义区域。
- **实现进展**：Wave 6 已完成实现与测试（Desktop 启动 51/51 + 图表工作区 5/5 + CLS 面板单测通过，Electron WebView 安全白名单与沙箱隔离经 `wave6-sol-review` 确认无 P0/P1）。

---

### #10 A 股看盘 — 左侧临时列表按跳转来源上下文动态展示（行业/概念成分股、RPS 排名、连板等）

- **提出时间**：2026-11-25 15:10
- **用户诉求**：从不同榜单/模块跳转至 A 股看盘时，左侧列表自动展示对应的临时列表：
  - 行业成分股跳转 → 展示该行业成分股列表；
  - 概念成分股跳转 → 展示该概念成分股列表；
  - RPS 排名列表跳转 → 展示 RPS 排名列表；
  - 连板跳转 → 展示连板列表。
- **方案设计（Wave 6）**：
  - **补齐所有跳转入口的 `BrowseList` 传递**：在 `StockPoolView` / `MarketPoolBrowser`（行业成分股、概念成分股、指数成分股）与 `IndustryRotation`（30 行业轮动下钻成员）补齐 `BrowseList`（带语义标签如 `行业 · <行业名>`、`概念 · <概念名>`），与已有的 `连板梯队`、`涨停池`、`概念 · <涨停概念>`、`RPS 排名` 全链路打通；
  - **左侧轨道新增临时列表签（`src/components/workbench/market-view.tsx`）**：当 `activeBrowse` 存在时，左侧轨道自动新增临时列表签（标题为来源名与数量）、自动切换至该签并自动展开左侧栏；列表支持搜索过滤、高亮当前标的、点击切股并与 `PgUp/PgDn` 双向同步及「退出列表」关闭；无 `activeBrowse` 时保持原默认收起行为，不破坏既有测试。
- **实现进展**：Wave 6 完成主体实现，Wave 7 `wave6-p1-fixups` 修复全部评审 P1（同榜单重进重新展开左栏、行业/概念/指数池完整有序 `browseSymbols`）并经 `wave7-sol-review` 核验通过。

---

### #11 A 股看盘 — 形态突破算法与图表绘制重构

- **提出时间**：2026-11-25 15:17
- **现象与截图（`贵州茅台 SH600519`）**：开启「形态突破」后，5 个月 K 线上同时叠画了 7 个互相冲突的形态（上升/下降三角形、上升/下降楔形、箱体），14 条虚线织成蜘蛛网；多条斜线向空处外推至远低于/高于真实 K 线的区域（如 1000 元悬空绿线与 1460 元悬空橙线）。
- **根因定位（`packages/trading-strategies/src/pattern-breakout.ts` + `src/lib/chart/chart-data.ts`）**：
  1. **向空处外推**：`enclosingRails()` 取右侧两个相近极值点拟合斜线，却在 `channelSetup()` 中硬拉回 `start = i - 55` 绘制，导致斜线外推几十根 K 线悬空；
  2. **同 K 线/邻近 K 线重复触发**：`converging()` 允许同一根 K 线同时产出三角形与楔形，`analyzePatternBreakouts()` 无冷却去重，同一震荡区间反复触发多个重叠形态；
  3. **默认阈值过松**：图表默认 `minScore = 1`，把无放量、无盈亏比的 `1/5`、`2/5` 噪点全放上主图；
  4. **图表全历史轨道叠画**：`patternChartData()` 将可视区间内所有历史形态的上下轨一次性全画出来，造成蜘蛛网遮挡 K 线。
- **重构方案（并入 Wave 5）**：
  1. **轨道严格锚定真实极值与贴合校验**：收敛形态起点改为 `Math.min(upper.a.index, lower.a.index)`（箱体改为最早触碰极值），要求两锚点跨度 ≥ 形态长度的 35%，起点处上下轨须贴合窗口真实高低点（误差 ≤ 3%），杜绝悬空外推线；收敛比收紧至 `≤ 0.72`、最小高度 `≥ 4%`、且要求 `i-1` 收盘在轨道内（仅首根真突破触发）；
  2. **同根择优 + 冷却去重**：单根 K 线多形态冲突时只保留得分最高、结构最清晰的一条；`analyzePatternBreakouts` 引入默认 `10` 根 K 线同向/同类冷却去重（支持参数配置）；
  3. **图表防蜘蛛网渲染**：`patternChartData` 对所有去重后的有效突破画标注点，**几何轨道线默认仅绘制最新（或光标所指）1 个有效形态的轨道**（可在形态突破参数中切换显示全部轨道），图表默认 `minScore = 3`，清爽无遮挡。
- **实现进展**：Wave 5 主体实现完成，Wave 6 `wave5-p1-fixups` 修复全部形态突破 P1 并经 `wave6-sol-review` 核验通过。

---

### #12 A 股看盘 — 双突破算法重构优化（下降/上升趋势线或 MA20 + 近期压力/支撑位）

- **提出时间**：2026-11-25 15:21
- **用户诉求**：双突破算法应回归标准口径「向上突破下降趋势线 + 近期压力位 / 向下跌破上升趋势线 + 近期支撑位」；若趋势线不易绘制，可用 `MA20` 替代，并对双突破整体重构优化。
- **现有算法问题定位（`packages/trading-strategies/src/research/breakout/breakout.ts`）**：
  1. **关键位被整数关口/均线/反向极值污染**：`levels` 混入了 `round`（整数关口）、`ma20`、`ma60` 与反向极值，`keyLevel` 直接取距离前收盘最近的一个，导致经常拿 0.5% 外的整数位冒充「近期压力位 / 近期支撑位」；
  2. **趋势线搜索过早放弃**：`trend()` 在最新一对波段高/低点被实体穿过时直接返回 `null`（不继续回溯寻找更早的有效趋势线），且缺少 `MA20` 趋势线替代模式。
- **重构方案（并入 Wave 5，保持 `dual-breakout-1` 研究基线兼容）**：
  1. 在 `BreakoutAnalysisOptions` 中新增 `trendMode`（`"trendline" | "trendline-or-ma20" | "ma20"`）与 `levelMode`（`"structural" | "all"`），缺省仍沿用 `dual-breakout-1` 研究基线不破坏历史监控/回测测试；
  2. 优化 `trend()` 候选对回溯逻辑：最新极值对不可用时继续向前回溯有效趋势线对（需满足无中间实体突破）；支持 `ma20` 作为趋势基准（多头：前收 ≤ MA20 且今收 > MA20 阳线；空头：前收 ≥ MA20 且今收 < MA20 阴线）；
  3. `levelMode: "structural"` 严格限定多头关键位为近期压力位（`swing-high` / `platform-high`）、空头关键位为近期支撑位（`swing-low` / `platform-low`），剔除整数关口与反向极值干扰；
  4. **看盘图表默认启用** `trendMode: "trendline-or-ma20"`（有有效趋势线画趋势线，无则用 `MA20` 替代）+ `levelMode: "structural"`（严格近期压力/支撑位），并在 `双突破 ⚙` 参数面板开放「趋势基准（趋势线+MA20兜底 / 仅趋势线 / 仅MA20）」与「关键位口径（近期压力/支撑位 / 全部关键位）」实时切换；图表标注与趋势线/压力支撑位清晰对应，无冗余线。
- **实现进展**：Wave 5 主体实现完成，Wave 6/Wave 7 修复全部双突破 P1（`minIndicatorVotes` 图表硬门槛、MA20/真实 `keyLevel` 绘线一致、`keyLevel` 为空不回退画未采纳高低点）并经 `wave7-sol-review` 核验通过。

---

### #13 问财选股 — 补全标的中文名、最新价与涨跌幅（并打通左侧临时列表）

- **提出时间**：2026-11-25 15:26
- **根因定位（`src/components/market/thsdk-wencai-panel.tsx`）**：`thsdk-hq` 的 `query_wencai` 接口常只返回代码与查询条件命中的动态字段（`securities.name` 为空且不含价格/涨跌幅），而前端未接入本地名称字典 `useSecurityNames()` 与实时批量报价 `api.overviewQuotes`。
- **方案设计（并入 Wave 6）**：
  - 在 `ThsdkWencaiPanel` 接入 `useSecurityNames()` + `api.overviewQuotes`（严格 `enabled: visible && wencaiSymbols.length > 0`，首次空进入不发额外请求）；
  - 名称按 `row.name ?? quote?.name ?? names[row.symbol]` 补全，新增「最新价」与红绿着色「涨跌幅」列（不可得时显式显示 `—`，不伪造 0）；右侧热门板块成分股同样补全中文名；
  - 将问财选股结果表与热门板块成分股接入 `<BrowseSource>`，点击跳转看盘时左侧临时列表同步展示对应榜单。
- **实现进展**：Wave 6 已完成实现与单测（补齐中文名/最新价/涨跌幅、零空载请求、失败回退 `—` 并接入左侧临时列表），评审无 P1。

---

### #14 全局布局 — 收缩「策略运行台 / 部署到策略运行台」到策略相关页面，消除顶部占空

- **提出时间**：2026-11-25 15:29
- **用户诉求**：「策略运行台」「部署到策略运行台」不要全局挂在各个页面右上方，收缩到策略相关页面即可，且不要占据一整行那么多空间。
- **方案设计（并入 Wave 6）**：
  1. **`src/components/overview/today-workspace.tsx`**：移除顶部的 `<nav aria-label="今日交易标签页"><Button>策略运行台</Button></nav>` 整行占空条（保留 `/?tab=pipeline` 路由渲染 `<PipelineConsole />`）；
  2. **`src/components/workbench/navigation.ts`**：将「策略运行台」（`/?tab=pipeline`）收归左侧菜单栏「策略回测」分组下；
  3. **`src/components/screening/scan-workspace.tsx`**：移除 `/scan` 顶层的 `<ScanDeployEntry />`（A 股看盘、自选、板块估值、涨停与情绪、强势排名、股票池、问财选股、数字货币等非策略页不再挂「部署到策略运行台」）；在公式选股页保留紧凑行内入口（与标签栏同行，不单占一整行）；
  4. **`src/components/backtest/backtest-page.tsx` 与 `src/components/research/alpha/alpha-lab-workspace.tsx`**：在策略回测与 Alpha 研究页将「部署到策略运行台」收紧为紧凑行内按钮（减少垂直留白，不单占一整行空白条）。
- **实现进展**：Wave 6 已完成实现与单测（「策略运行台」收归侧栏「策略回测」，移除非策略页顶栏，策略页收紧为紧凑按钮），评审无 P1。

---

### #15 策略库 — 新增通俗「使用说明」与六阶段逐项操作指引

- **提出时间**：2026-11-25 15:36
- **用户诉求**：策略库页面「六阶段晋级流水线」与「卡在第 1 阶段 · 定义冻结：策略已登记，缺少冻结输入哈希」等表述看不懂，需要补充清晰易懂的使用说明。
- **方案设计（并入 Wave 6）**：
  - 在 `src/components/research/strategy-lab.tsx` 的策略库列表与详情「六阶段晋级流水线」旁新增可展开的「使用说明」（通俗解释策略从登记 → 组合回测冻结输入 → 同口径对照 → 模拟盘前推 → 影子观察 → 人工晋级与开启正式提醒的完整流程）；
  - 在各阶段展开的「证据明细」下补充直白中文的「如何通过本阶段」与对应直达跳转入口（如第 1/2 阶段直接提示点击「用此策略对象回测」跑完一次组合回测即可自动通过，第 4 阶段引导至「模拟盘对照」），不改变既有服务端门禁逻辑与测试契约。
- **实现进展**：Wave 6 已完成实现（策略库新增默认折叠的通俗六阶段使用说明及各阶段直达指引），评审无 P1。

---

### #16 模拟账户 — 同花顺模拟/实盘账户与本地模拟账户平行打通

- **提出时间**：2026-11-25 15:37
- **现状核查**：
  - `本地模拟盘`（`/accounts?tab=paper`）具备完整的账户卡片、持仓、资金流水、成交记录与下单表单；
  - `同花顺模拟盘`（`mock-trading-service.ts` + `venue-router.ts` `ths_mock`）后端能力已具雏形，但前端仅以原始 JSON 调试面板藏在「手工记账」底部，没有与本地模拟盘平行的资金/持仓/成交/下单账户界面；
  - `同花顺实盘` 在部署通道 `cn_broker_live` 仅列了 `qmt/ptrade/xtquant/http_bridge`，缺少独立的「同花顺实盘账户」配置与只读查账视图。
- **方案设计（Wave 7）**：
  1. **契约与后端**：
     - `packages/trading-strategies/src/deployment-contract.ts`：`cn_broker_live` 的 `broker` 枚举新增 `"ths_live"`（同花顺实盘）；
     - `src/server/portfolio/mock/mock-trading-service.ts`：补充本地只读状态摘要 `readMockAccountMeta()`（零远程请求、零凭证泄露）与按需结构化总览 `queryMockOverview()`（资金 + 持仓 + 当日成交）；
     - 新增 `src/server/portfolio/ths-live-account-service.ts`：管理同花顺实盘桥接账户元数据，令牌凭证严格复用 Windows DPAPI（`pipelineLiveVaultId`）且永不回传明文；查账严格受全局实盘总开关（`live-kill-switch`）与人工点击触发控制，绝不自动轮询或自动下单；
  2. **三账户平行界面（`/accounts?tab=paper`）**：
     - 顶部平行切换「本地模拟账户」「同花顺模拟账户」「同花顺实盘账户」三个平行通道视图；
     - 「同花顺模拟账户」提供资金概览卡片、结构化持仓表（含中文名）、当日成交表与安全两步确认（预览→确认）模拟委托下单表单，原契约差异与脱敏日志折叠收底；
     - 「同花顺实盘账户」以清晰实盘警示标识与模拟盘隔离，支持登记账户 ID / 桥接地址、加密保存凭证与手动只读刷新资金/持仓；
     - 策略部署向导（`deploy-strategy-dialog.tsx`）同步支持「同花顺实盘」与「同花顺模拟」状态提示及快速跳转。
- **实现进展**：Wave 7 完成主体实现，Wave 8 `wave7-p1-fixups` 修复全部 2 项凭证安全 P1 与 P2 回归（12/12 通过）并经 `wave8-sol-review` 核验通过。

---

### #17 行情看盘（A 股 / 数字货币 / 期货）— 直接模拟下单

- **提出时间**：2026-11-25 15:47
- **产品规格**：详见 [2026-11-25-chart-direct-sim-order-spec.md](../market-chart/2026-11-25-chart-direct-sim-order-spec.md)（按 `product-delivery` M 级规范产出需求、系统契约、交互设计与测试矩阵）。
- **核心交付（Wave 8）**：
  - **后端**：新增期货双向多空保证金模拟服务（`src/lib/portfolio/futures-sim.ts` + `src/server/portfolio/futures-sim-service.ts`，精确十进制计算 + 币种隔离 + `clientRequestId` 幂等，落盘现有 `records` 表零迁移风险），扩展 `sim-accounts.ts` tRPC 接口；
  - **前端**：新增统一看盘下单弹窗 `ChartSimOrderDialog`（A 股本地模拟 + 同花顺模拟双通道、数字货币 USDT 现货模拟、期货双向开平仓模拟；预填标的与未复权参考价、快捷仓位换算、无账户一键建户、两步预览确认防误单），分别挂入「A 股看盘」「数字货币」「期货行情」工具栏及「模拟账户」期货子视图。
- **实现进展**：Wave 8 完成主体实现，Wave 9 及终审补齐全部 P1/P2（15 个期货品种标准交易所合约乘数、`BigInt` 精确有理数累计成本防多次部分平仓舍入漂移、旧版无乘数持仓兼容平仓与防混乘数加仓、A 股历史快照日期防呆、4 页签测试同步、数字货币 8 位快捷精度与回执直达 `accountId`），已通过全部单测与全量门禁验收。

---

### #18 股票池与全站 UI — 移除「上一只/下一只」按钮并全局清理所有「生存者/幸存者偏差」界面显示

- **提出时间**：2026-11-25 15:52
- **用户诉求**：
  1. 股票池页面已采用动态无限滚动，去掉底部已无用的「上一只 / 下一只」按钮；
  2. 彻底去掉所有页面 UI 中「生存者偏差 / 幸存者偏差」与「时点审计」的展示（用户不关心这些内容）。
- **全站排查清单与改造（并入 Wave 6）**：
  - `src/components/market/market-pool-browser.tsx`：移除「上一只 / 下一只」按钮、移除 `<UniverseAuditContainer />` 时点审计/生存者偏差区块、将「回填数据（存在生存者偏差）」改为「回填数据」；
  - `src/components/market/industry-rps-status.tsx`：「回填（成分漂移 / 生存者偏差）」→「回填数据」；
  - `src/components/market/charts/market-chart.tsx`：RPS 图例说明「虚线：回填（生存者偏差）」→「虚线：回填数据」；
  - `src/components/research/strategy-center/strategy-catalog.tsx` 与 `src/components/research/research-data-guide.tsx`：清理 UI 文案中「幸存者偏差」字样；
  - 保留后端研究/审计纯函数不破坏历史后端单测，仅同步更新 `tests/screening-rps/universe-audit.test.ts` 的 UI 静态断言。
- **实现进展**：Wave 6 完成清理，Wave 7 `wave6-p1-fixups` 清理完毕最后一处 `market-pool-browser.tsx:752` 残留并经 `wave7-sol-review` 核验通过。

---

### #19 全站交易术语汉化 — 消除 `shadow / live / 影子` 等生僻术语

- **提出时间**：2026-11-25 15:56
- **用户诉求**：界面上反复出现的 `shadow / live / 影子` 看不懂，统一翻译成直白易懂的中文交易术语。
- **统一词表（并入 Wave 8）**：
  - `shadow` / `影子观察` / `影子模式` → **空跑观察**（只记信号不推不下单）
  - `影子前推` / `影子扫描` → **空跑验证** / **空跑扫描**
  - `live 提醒` / `开启 live 提醒` / `暂停 live 提醒` → **正式提醒** / **开启正式提醒** / **暂停正式提醒**
  - `manual_confirm` / `auto_sim` / `auto_live` / `draft`（弹窗说明文案中）→ **人工确认** / **自动模拟** / **自动实盘** / **草稿**
- **涉及文件**：`src/lib/common/ui-glossary.ts`、`src/lib/research/strategy-lab.ts`、`src/components/pipeline/pipeline-console.tsx`、`src/components/pipeline/deploy-strategy-dialog.tsx`、`src/components/portfolio/account-review-panels.tsx`、`src/components/research/lab-review.ts`、`src/components/research/paper-shadow-prompt.tsx`、`src/components/research/strategy-lab.tsx`、`src/components/research/strategy-scoreboard.tsx`、`src/components/research/studio/studio-result-panel.tsx`、`src/components/signals/alert-settings.tsx` 及对应受影响单测。
- **实现进展**：Wave 8 完成全站主体术语汉化，Wave 9 补齐剩余 2 处研究页文案（`portfolio-evidence-panel.tsx` / `lab-backtest.tsx`），全仓单测与静态校验通过。

---

### #20 历史信号 — 重梳理提醒类型分类，消除「移动止损策略名」与「入场候选信号」混淆

- **提出时间**：2026-11-25 15:59
- **根因定位**：
  1. `strategyDisplayName()`（`src/lib/strategy-facts/strategy-display.ts`）把策略 ID `r2a-cn-equity-formula-range-trailing` 格式化为 `区间公式 · 移动止损`——其中 `移动止损` 只是该策略配置的**出场止损方式**，而本条事件的实际信号类型是 `entry`（区间突破公式触发的**买点/入场候选**），并排显示极易让人误以为是「移动止损卖出信号被错误归进了入场候选」；
  2. `历史信号`（`src/components/signals/alert-workspace.tsx`）把 11 种提醒类型扁平堆在一个下拉框里，且表格中缺少方向/大类徽章，同时顶部与明细仍残留 `提醒引擎：影子` / `仅影子记录`。
- **重构方案（并入 Wave 8）**：
  1. 策略显示名明确区分「入场方法」与「配套出场规则」（如 `区间公式（移动止损出场）` / `区间公式（ATR止损出场）` / `区间公式（定时出场）`）；
  2. 将 11 种信号类型按交易意图重组为 4 大清晰分组（表格顶部支持快捷大类筛选 + 细类下拉，表格内展示带色调的方向徽章）：
     - **买入 / 入场**：`入场候选`、`计划入场`
     - **卖出 / 止盈止损**：`退出条件`、`触发止损`、`触发目标`、`移动止损出场`
     - **计划与成交**：`模拟成交`、`计划到期`
     - **风控与状态**：`市场状态`、`分仓偏离`、`错过窗口`
  3. 同步将 `src/lib/strategy-facts/alerts.ts` 的 `alertModeLabels.shadow` 从 `"影子"` 改为 `"空跑"`（消除左上角 `提醒影子` 与 `提醒引擎：影子`），并将 `formatAlertReason` 中的 `仅影子记录` 转为 `仅空跑记录`。
- **实现进展**：Wave 8 已完成 4 大交易分类筛选、彩色方向徽章、策略出场后缀清晰化及 `提醒影子` → `空跑` 清理，经 `wave8-sol-review` 核验无 P1。


