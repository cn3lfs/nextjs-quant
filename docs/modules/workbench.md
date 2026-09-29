# 工作台与路由

## 职责与非职责

`src/app/` 声明 Next App Router 页面/API 入口；`src/components/workbench/` 负责导航、工作台布局和面板装配，`overview/`、`panels/` 分别提供总览和可组合面板。业务规则、数据访问和持久化归领域模块。根页目前返回 `null`，总览由根布局内的工作台面板缓存呈现。

## 入口与消费者

- 根布局：[src/app/layout.tsx](../../src/app/layout.tsx) 安装样式、tRPC provider 和 `WorkbenchLayout`。
- 根页：[src/app/page.tsx](../../src/app/page.tsx)；其他 route files 只装配页面组件。研究数据指南在 [ResearchDataGuide](../../src/components/research/research-data-guide.tsx)，通用组件示例在 [UiGallery](../../src/components/common/ui-gallery.tsx)；其余页面位于 `src/app/{analysis,market,rps,screen,research,backtest,signals,signal-ledger,trade-ledger,trade-review,news,cls-review,intraday,tasks,reports,settings}/`。
- 页面通过 `src/trpc/react.tsx` 使用 client API；Server Component caller 在 [src/trpc/server.ts](../../src/trpc/server.ts)。
- 全局导航、标题和面板状态见 `src/components/workbench/`；页面实际把查询状态和交互交给领域组件。
- 任务中心的列表和详情展示位于 [task-history.tsx](../../src/components/workbench/task-history.tsx)，任务状态数据由 API/jobs 模块提供。

## 契约与依赖

- Next 特殊文件承担框架入口；页面 URL、查询参数和 React server/client 边界是可见契约。
- 依赖方向：route/layout → 页面/工作台组件 → 领域组件与 tRPC client。客户端组件不可直接导入 `src/server`；纯展示/转换才属于 `src/lib`。
- 不把领域业务搬入新的 `src/features` 根层，也不把业务组件放进 `src/components/ui/`。

## 状态、副作用与验证

路由 query/path 与 client query cache 影响导航和刷新；工作台壳不应自行持久化业务实体。代表性验证：[workbench-refactor.test.ts](../../tests/workbench/workbench-refactor.test.ts)、[t4-desktop-guards.test.ts](../../tests/desktop-build/t4-desktop-guards.test.ts)。涉及真实页面交互时再按受影响路径做浏览器验收；结构指纹失败需精确更新并增加行为断言。

**客户端缓存持久化**（[persist.ts](../../src/trpc/persist.ts)）：`PersistProvider` 与库自带 `PersistQueryClientProvider` 同一契约（启动恢复一次、恢复期间 `useIsRestoring`），但保存只由"需持久化查询拿到新数据"触发并 2 秒节流。库自带实现在任何查询缓存事件（包括每 4 秒的投递轮询）上 dehydrate，而 `dehydrate.serializeData` 为 SuperJSON，每次都序列化整个证券名录等持久化数据，空闲页面因此长期占用主线程。投递列表只在总览/信号页 4 秒轮询，其他页 30 秒（仅用于侧栏失败角标）。

**今日总览行情**（[market-pulse.tsx](../../src/components/overview/market-pulse.tsx)）：上证/深成/创业板/沪深300/科创50 与自选的现价、涨跌幅、指数成交额，一次批量 `tdxQuotes`，按交易时段刷新（`useQuoteRefreshInterval`，与行情侧栏、分时图共用），总览被切走时暂停。

**基线与验证**：[workbench-perf-browser.mjs](../../tests/workbench-perf-browser.mjs) 需先以隔离数据目录启动生产服务（`QUANT_DATA_DIR=... PORT=3217 node scripts/start.mjs`），输出冷启动 JS 体积/时间、侧栏导航耗时与空闲主线程开销（`PROFILE=1` 附热点）；[persist-cache-browser.mjs](../../tests/persist-cache-browser.mjs) 核对持久化写入集合。

## 维护指南

新页面只解析路由输入、提供数据入口并装配对应领域组件；新增业务状态归所属领域。改 URL、导航、缓存或 server/client 边界时同步更新此页与 [模块地图](README.md)。

## 数据与连接的配置闭环（2026-09-28）

`connections.tsx` 的页面级保存入口统一处理行情路径、默认源、新闻/研究和通知策略；聊天渠道及数字货币保持独立保存。`lib/settings/settings-draft.ts` 只合并表单拥有的字段：未编辑字段接收后台更新，脏字段保留；保存成功仅确认实际提交的值，期间新增编辑仍为脏状态。页面切换依靠既有 PanelCache 保留草稿，关闭/刷新时有未保存提醒，不持久化草稿凭证。

newsBudget 与研究技能查询按 PanelVisible 暂停；删除本组件未消费的 securityNames 订阅，壳层共享证券名录继续维持原职责。默认行情源在行情页没有手动选择时跟随 settings；手动选择保留优先级。已加载快照继续保留原始证据；修改目录/默认源/日历后清理 A 股会话快照缓存并推进 marketGeneration，旧 A 股请求不可回填或覆盖页面；数字货币、期货的缓存及在途请求保留，全局 clear 仍使全部请求失效。

`connection-diagnostics.tsx` 显式检查已保存配置，结果携带配置与选择范围；旧结果标旧，连接、数据和新鲜度分别呈现，腾讯延迟属性单独说明。与 `settingsRouter.checkConnection` 的契约见 `lib/settings/connection-check.ts`。不会自动扫描、切源、通知或调用模型。

行为验证入口为 `tests/connections-browser.mjs`（真实组件、查询缓存、合成传输），`tests/connections-production-browser.mjs`（仅允许显式隔离服务，真实设置/诊断 API），`tests/connections-perf-browser.mjs`（生产服务冷开/交互/隐藏请求测量）。合成传输结果不能称为实源可用性验证。

## 任务中心的状态与恢复（2026-09-28）

任务中心使用 `taskOverview` 对全部已记录 Job 聚合计数，今日完成按北京时间日界；失败和取消为历史累计，统计独立于列表筛选。壳层 `jobs` 最近 80 条契约保留。历史列表继续 20 条游标分页，增加类型和精确编号；输入编号提交后才请求。列表和详情不返回原始 input/result。

`use-task-visible.ts` 合并 PanelVisible、document 可见性与窗口焦点。概览有活动任务时 2 秒、否则 30 秒校验；读取既有 Job revision，变化时只失效当前列表。旧活动任务不依赖最近 80 条窗口发现。展开的活动详情每 2 秒核对，终态停止周期读取；隐藏或失焦不启动页面专属查询，回来立即核对。传输失败保留旧列表并标注未刷新。详情仅首次无数据时显示加载 live region，周期核对不反复插入加载提示。

普通刷新保留游标和展开任务，“回到最新”单独回首页；历史页不会被新任务自动顶回首页。当前任务退出筛选/当前页时给出说明并将焦点移回列表计数。取消按任务编号独立控制在途操作，显示服务端实际 outcome。取消受理不等于外部请求撤回或资源全部退出。来源链接是白名单导航，不自动填参或重新执行；没有可确认映射时明确提示。结果链接继续核对真实持久化结果。

行为验证入口：`tests/task-center-browser.mjs` 保留原交互回归；`tests/task-center-query-browser.mjs` 使用真实 TanStack Query 与合成传输验证自动更新/隐藏/失焦/重复操作；`tests/task-center-production-browser.mjs` 使用隔离服务真实 API 和合成持久任务。性能分别由 `tests/task-center-perf.ts` 和 `tests/task-center-perf-browser.mjs` 测量，不把合成任务当作真实模型或计算任务业绩。

## 研究档案的检索与阅读（2026-09-28）

`archive-list.tsx` 统一通用研究、CAN SLIM、缠论、威科夫四类摘要；估值与财务质量保持独立区域，不计入统一检索数量。`researchArchiveHistory` 使用 SQL 摘要投影，在分页前完成类型、精确证券、标题/ID 普通子串和北京时间生成日期过滤；固定每页20条，时间、kind、id共同确定顺序，游标绑定规范化筛选条件。缺失/非法生成时间作为明确的未知组置后，不用 updated_at 代替；未知时间不进入日期筛选。元数据不完整的记录仍计数并标识，缺失证券关系不从正文推测。原报告和旧 History 接口均保留。

查询按钮/Enter提交草稿，URL仅记录已提交条件；sessionStorage保存游标栈与阅读前的焦点/滚动位置，存储不可用时退回内存导航。刷新保留当前边界，回到最新单独重置。列表没有周期轮询，隐藏面板禁用查询；回来重新校验。详情继续用 kind+id精确读取，不先拉列表。错误与空结果分离；渲染损坏的旧档案由局部边界承接，原始产物不被修改。

`archive-evidence.tsx` 只在展开时生成证据DOM；超长正文以8000 UTF-16单元为一段显示，边界避免拆开代理对，原文与完整导出不截断。生成时间统一北京时间；缺失元数据不补造。通用报告保留Markdown导出，三种方法使用完整JSON；下载准备失败可重试。完整通用报告不再进入IndexedDB持久缓存，详情保留短期内存缓存并在重新打开时校验。

壳层初始行情快照在 `/reports` 和其详情路径延后，离开档案再按原逻辑加载一次；阅读、筛选和导出不启动行情/研究任务。证据生产、方法算法、任务调度和MCP不在此次改动范围。验证入口为 `research-archive-history/navigation/evidence.test.ts`、`research-archive-production-browser.mjs`、`research-archive-perf.ts`、`research-archive-perf-browser.mjs`；浏览器/SQL产物均为隔离fixture，不证明真实策略有效。

统一摘要查询在一次SQL内共享过滤结果，COUNT不受当前页边界影响；查询内JSONB只保留七个元数据字段，没有持久化格式变化。SQL和HTTP分别由 `tests/research-archive-perf.ts`、`tests/research-archive-http-perf.mjs`测量，后者在明确隔离库插入临时合成行并在finally恢复原有记录数。最终工程验收与性能波动记录见Documents下本模块交付说明。

常驻面板约定：任何固定间隔的 `refetchInterval`，以及较重的一次性计算（如缠论分析），都必须在 `usePanelVisible()` 为 false 时暂停；只有"任务完成即停"的状态轮询可以例外。回归检查方法见 `docs/optimization-plan-2026-09-29.md` 的 1A。
