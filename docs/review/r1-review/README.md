# R1 UI 基座核对

本目录为 A 层证据；**B 层设计口味待用户确认**。入口 `/ui-gallery`。没有迁移业务页面，没有全应用暗色模式。

## 画廊

- [完整画廊](gallery.png)：18 个新组件（Table 通过 DataTable 渲染）与原 Button。
- [对话框](gallery-dialog.png)、[菜单](gallery-menu.png)、[提示](gallery-tooltip.png)、[错误与重试](gallery-error.png)、[390px 窄屏](gallery-mobile.png)。
- [交互记录](gallery-checks.json)：键盘复选/开关、对话框 Escape 与焦点返回、菜单、分页/排序、空/加载/失败/重试、窄屏溢出及浏览器异常检查。

## 六页视觉对照

`tests/r1-visual-review.mjs` 读取组件预置提交 `3375a15` 的原始 globals.css，以预置 PostCSS/Tailwind 编译。当前业务页面代码未改，在同一个已加载的 DOM 上原子切换原始/R1 样式，暂停轮询，使用同一 Chromium、1840×1350 视口及完整页面截图。这样隔离首轮独立导航中行情/连接异步加载时点不同的问题。只隐藏 Next 开发指示器，不遮挡业务区域；图表完整页首次截图会触发尺寸取整，先进行一次截图布局稳定，再保留配对结果。

| 页面 | 原 CSS / R1 CSS 截图 | 变化像素 |
|---|---|---:|
| 行情图表 | [原](before/market.png) / [R1](after/market.png) | 0 |
| 条件选股 | [原](before/screen.png) / [R1](after/screen.png) | 0 |
| 信号与通知 | [原](before/signals.png) / [R1](after/signals.png) | 0 |
| 数据与连接 | [原](before/connections.png) / [R1](after/connections.png) | 0 |
| 信号台账 | [原](before/signal-ledger.png) / [R1](after/signal-ledger.png) | 0 |
| 持仓账本 | [原](before/trade-ledger.png) / [R1](after/trade-ledger.png) | 0 |

[逐页像素及样式结果](comparison.json)，before/after 下 JSON 留存原始 CSSOM 与元素几何。行情页“已显示 360 / 6001 根”容器及子 span 的 text-slate-500，独立编译为 `oklch(0.554 0.046 257.417)`，Next 编译为 `lab(48.0876 -2.03595 -16.5814)`；比较时经浏览器归一化为 RGBA，原始值保留，两者实际截图像素完全一致。其余五页 CSSOM 本身也相同。结论只覆盖本轮截图状态，不代替所有业务状态或 B 层审美判断。

### 与 Q1 / Q2b 历史截图的差异逐项说明

1. **行情图表，对照 Q1 `01-day-light.png`**：历史图仅裁剪 chart-workspace，本轮为含侧栏、标题、报价、自选和任务中心的完整页面，不能把新增截图范围误判为新增 UI。两图均为茅台 2026-09-09 日线、收盘 1290.88、360/6001 根、默认 MA 与成交量。历史图仍显示“正在读取持仓成本”“双突破计算中”“缠论计算中”；本轮等待加载后不显示成本读取提示，出现双突破观察日及结果文字、缠论笔/线段/中枢统计、结构线与压力/支撑价标签，价格轴随这些已有叠加内容自动调整。工具栏因此换行/高度不同，是已完成加载状态与历史加载中状态的差别。历史暗色/周月/5分钟/手动画线/受控成本截图属于另外的视图设置与 fixture，本轮未把这些状态冒充相同基线，也未改动它们的实现。
2. **条件选股，对照 Q2b `editor-ready.png`**：历史图仅裁剪公式面板，本轮包含完整选股页。历史选择已保存“老鸭头（价量部分，非原公式）”，源码多行、参数 `{}`，已做语法检查且显示通过，保存/执行可用；本轮隔离库未保存公式，选择“新公式”，默认名称“均线金叉”，单行源码，参数 `{"N1":5,"N2":20}`，尚未检查，保存/执行禁用且没有通过提示。源码区高度、浅底、边框、文字样式保留。历史拒绝/运行中/已有候选截图是已执行状态，本轮未执行选股，所以不显示那些结果，不补造候选。
3. **信号与通知、数据与连接、信号台账、持仓账本**：指定历史目录没有这四页的截图，不能声称与不存在的历史截图逐像素相同。本轮补上原 CSS/R1 CSS 同条件完整页配对，四页均 0 变化像素。

## API 与兼容决定

`DataTable<T extends object>` 接收 `columns`、当前服务端页 `data`、服务端 `rowCount`、受控 `pagination {pageIndex,pageSize}`（从 0 开始）、受控 `sorting`、对应 `onPaginationChange/onSortingChange`（TanStack updater 契约）、稳定 `getRowId` 和无障碍 `label`；可选 `loading/error/onRetry/emptyMessage`。列使用 `DataTableColumn<T>`。仅注册 v9 排序/分页状态功能，不注册客户端排序/分页 row model，并开启 manualSorting/manualPagination。回调只通知调用方，组件不请求全量、不排序、不二次切页、不暗中重置页码；是否在排序后回第一页由调用方按原服务端契约决定。画廊用预置响应演示，不接业务 API。

旧 CSS 原规则及 Button 源码保留。新 token 通过 Tailwind `@theme inline` 映射旧蓝灰/青色；保留旧文字色 `--muted`，新 `--muted-surface` 负责 shadcn 浅底。仅新 `data-slot` 退出旧元素规则，明确排除 `.button`，避免 Radix asChild 给既有 Button 加 slot 后丢失自定义样式。暗色 variant 仅响应 `.dark`，没有启用该类/全局暗色配色，系统深色偏好不会让组件自行变暗。

17 个实际使用 cn 的预置组件均已统一为 `~/lib/utils`；第 18 个 Collapsible 原本没有 cn 导入，无需制造改动。package.json/锁文件未动，**由管理者移除 cn 依赖**。

## 重现与验证

在仓库根设置 `QUANT_DATA_DIR` 为 `.test-data/r1/browser` 的绝对路径，运行 `pnpm dev --port 3214`，随后以相同变量运行 `node tests/r1-visual-review.mjs` 和 `node tests/r1-gallery-review.mjs`。不连接生产库、不调用通知投递或交易操作。截图脚本直接使用已预置共享 Playwright；CLI 缓存目录写入被沙箱拒绝，未安装任何依赖。

`pnpm typecheck`、`pnpm test`、`pnpm build`（含 runtime:build）、`pnpm desktop:prepare` 均通过。单元检查：167 文件 / 1049 测试（原 166 / 1046），新增 3 项保护服务端数据顺序、禁止二次分页、总数与空/加载/失败状态。未运行 desktop:smoke/desktop:pack，没有 commit/push。B 层请用户确认画廊配色、间距、可读性和浮层风格。
