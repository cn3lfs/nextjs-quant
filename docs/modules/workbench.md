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

## 维护指南

新页面只解析路由输入、提供数据入口并装配对应领域组件；新增业务状态归所属领域。改 URL、导航、缓存或 server/client 边界时同步更新此页与 [模块地图](README.md)。
