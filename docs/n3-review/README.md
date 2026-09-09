# N3 技术债收口验收

范围：仅移动冻结模块 UI 入口及拆分 workbench，不开展 N2。拆分基线为 `b0efbc09d02f4970aeced397efd0e1f021834532` 的 `src/components/workbench.tsx`（2,826 行）。

## 入口与逐项可达性

主导航保留行情图表、条件选股、信号台账、信号与通知、数据与连接。原“行情研究”入口显示为“行情图表”；信号台账仍访问原 `/signal-ledger`。二级入口采用原生 `details/summary`“研究”，包含证据分析、研究档案、策略实验、新闻/主题。

所有下列面板均在实际 Chromium 浏览器中通过 Playwright 逐项打开，检查标题、表单或原有空态，并保存截图。只验证入口与渲染，不为冻结算法补验收、不运行模型或真实通知。

| 移动内容 | 原位置 → 新位置 | 渲染证据 |
|---|---|---|
| 通用证据分析、SEPA 方法选择 | 行情右侧 → 研究／证据分析 | [完整面板](03-evidence-analysis.png) |
| CANSLIM 报告生成 | 行情右侧 → 研究／证据分析 | [CANSLIM](04-canslim.png) |
| 缠论 LLM 标注报告 | 行情右侧 → 研究／证据分析 | [缠论 LLM](05-chan-llm.png) |
| 威科夫多周期报告 | 行情右侧 → 研究／证据分析 | [威科夫](06-wyckoff.png) |
| CANSLIM、缠论 LLM、威科夫历史档案及通用报告 | 主导航研究档案 → 研究／研究档案 | [全部档案入口与空态](07-research-archive.png) |
| 年度财务质量、基本面与价值资料复核 | 主导航研究档案 → 研究／研究档案；父子关系不变 | [财务质量和基本面](08-financial-fundamental.png) |
| 独立估值情景 | 主导航研究档案 → 研究／研究档案 | [展开创建表单](09-valuation.png) |
| 双均线研究模拟、结果 | 主导航策略实验 → 研究／策略实验 | [完整实验页](10-backtest.png) |
| 滚动样本外检验 | 主导航策略实验 → 研究／策略实验 | [滚动检验](11-walk-forward.png) |
| 纯现金分红实验账簿、公司行动核验 | 随原回测结果一起移动，显示条件不变 | [分红账簿](12-dividend-ledger.png)、[公司行动](13-corporate-actions.png) |
| 财联社新闻、行业分析、跨行业主题 | 数据与连接 → 研究／新闻/主题；内部层级不变 | [新闻档案](14-news.png)、[行业新闻](15-news-sector.png)、[跨行业主题](16-news-themes.png) |

TMT 与市场情绪没有独立的已挂载 UI 面板：当前仅有服务端证据/研究链路与报告内内容。没有新增面板或改动链路；其既有报告展示随研究档案归入二级入口。主题价格等更深层结果仍保留原条件挂载，本轮不运行冻结研究流程生成它们。

日常入口：[行情图表](01-market.png)、[展开研究导航](02-research-navigation.png)、[条件选股](17-screen.png)、[信号与通知](18-signals.png)、[数据与连接](19-settings.png)、[信号台账](20-signal-ledger.png)。行情截图来自本地只读日线；新闻和回测结果截图中的数据明确标记为 N3 UI 构造样例，不能视为实际研究结果。

## 拆分文件与行数

路径除第一项外均相对 `src/components/workbench/`。行数按文件实际文本计数。

| 文件 | 行数 | 职责 |
|---|---:|---|
| `src/components/workbench.tsx` | 180 | 工作台外壳、主/二级导航及挂载条件 |
| `navigation.ts` | 33 | 日常与研究导航元数据 |
| `use-workbench-state.ts` | 382 | 原顶层状态、effects、查询、mutation、派生值和回调 |
| `market-view.tsx` | 259 | 原行情图表、证券选择、自选列表 |
| `screen-view.tsx` | 668 | 原条件选股表单、结果及分页 |
| `signals-view.tsx` | 339 | 原监控订阅、信号、通知投递展示 |
| `connections.tsx` | 596 | 原设置、模型、MCP、通知渠道表单 |
| `evidence-analysis.tsx` | 111 | 原行情右侧研究子树及三类报告生成面板 |
| `research-archive.tsx` | 30 | 原研究档案面板挂载组 |
| `backtest-view.tsx` | 236 | 原策略实验表单与结果挂载组 |
| `reports.tsx` | 263 | 原 ReportArchive、ReportCard |
| `strategy-fields.tsx` | 82 | 原共用策略字段 |
| `shared.tsx` | 84 | 原格式化函数、Field、Empty、日历证据及分页控件 |
| `task-center.tsx` | 79 | 原任务中心 |

## 行为等价依据

1. 原 Workbench 的所有顶层语句保持顺序，放入唯一且无条件调用的 `useWorkbenchState()`。没有把查询或状态移到条件显示的 tab 内；初始化、依赖数组、轮询间隔、enabled 条件、mutation 参数和回调均保留。原 Connections 自有状态仍由 Connections 持有。
2. 展示组件通过类型化的 `Pick<WorkbenchState, ...>` 接收原值及函数。冻结组件源码、API、数据库迁移、指标、CZSC、双突破、信号台账均未改动。原面板 props、key、条件分支、事件处理和 className 不变；没有增加延迟加载、缓存、隐藏式常驻挂载或 CSS。
3. `tests/workbench-refactor.test.ts` 对照从拆分前文件生成的 `tests/fixtures/n3-workbench-structure.json`：检查原 hook 语句、辅助/报告函数、Connections（仅扣除移动的 NewsPanel 挂载）及七个展示子树。JSX 比较使用 TypeScript 编译后的结构，保留渲染与回调表达式；它是机械拆分的支持证据，不替代浏览器验收或现有业务测试。负向校验将轮询间隔改为不同值，确认对照能够检出差异。
4. Playwright 实测：初始“研究”折叠；行情页无 CANSLIM 面板；设置页无新闻面板；每个二级分组可进入。将选股“短均线”改为 7，切换到研究／策略实验仍为 7，验证原共用状态跨 tab 保留。台账链接和返回工作台正常。没有页面错误；设置页有两条浏览器 VERBOSE 级“密码字段不在 form 中”提示，原表单结构未改。
5. 入口位置、导航标签及其承载宽度变化是本次授权的 UI 归置；不声称前后整页像素相同。面板内部功能、数据流与 API 调用保持原契约，未通过修改样式来填补行情右侧腾出的布局空间。

## 验证结果与复现

- 原有 157 文件 / 793 测试全部保留；新增 1 文件 / 5 项结构校验，合计 **158 文件 / 798 测试通过**，无跳过。
- `pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm desktop:prepare` 通过。build 包含 `runtime:build`。
- 未运行 `desktop:smoke`、`desktop:pack`、依赖安装、commit 或 push；`output/`、路线图、下一阶段计划和仓库指令未改动。
- 浏览器服务使用 `QUANT_DATA_DIR=D:/github/nextjs-quant/.test-data/n3/browser`，端口 3113；检查/构建使用 `.test-data/n3/checks`。未读取共享库来复制业务数据，也未对共享库执行迁移。

浏览器 fixture 为持久文件 `tests/n3-review-seed.ts`，它在导入数据库前严格校验隔离目录。复现：

```powershell
$env:QUANT_DATA_DIR = 'D:/github/nextjs-quant/.test-data/n3/browser'
pnpm exec tsx tests/n3-review-seed.ts
$env:PORT = '3113'
pnpm start
```

使用已预置的共享 Playwright CLI，不安装依赖。CLI 单独设置 `PWTEST_DAEMON_SESSION_DIR` 至 `.test-data/n3/playwright`，其 `LOCALAPPDATA` 至 `.test-data/n3/browser-cache`；Chrome 使用 `headless: true`、`--no-sandbox`、`--disable-gpu`，视口 1440×1000。缓存重定向只应用于 CLI，不应用于工作台服务。

进入研究／新闻/主题后，选择“历史新闻分析”中的 N3 样例，即可打开行业及跨行业主题子面板；研究／策略实验自动显示已种入的完成任务样例。展开估值创建、公司行动、分红账簿以检查控件。不要点击生成报告、运行实验、抓取数据或测试通知。

## 自行决定及待议事项

自行决定：原生折叠二级导航、保留四个原有职责分组、顶层状态统一保留、展示组件只接收原值、已有嵌套面板随父入口移动、缺少独立 TMT/情绪面板时不新增实现。

无需用户作出新的范围或架构决定。待议：CANSLIM 空态文案仍指向“日线行情页面生成研究报告”，与新入口不一致；按冻结约束只登记到 `docs/decisions.md`，本次不修复。
