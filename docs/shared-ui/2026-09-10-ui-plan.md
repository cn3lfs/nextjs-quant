# R 阶段：UI 框架落地

生效日期：2026-09-10。前置：文档收口已完成并提交（`efddba0`），
组件与依赖已由管理者预置（`3375a15`）。

## 0. 现状与判断

项目**早就选好了框架但从未采用**：`components.json` 里 shadcn/ui（new-york、slate、
CSS 变量）配置齐全，而 `src/components/ui/` 长期只有一个手写的 `button.tsx`。
9,596 行组件代码用的是原生元素：`<input>` 76 处、`<button>` 38 处、
`<select>` 31 处、`<table>` 21 处、`<textarea>` 9 处。

所以本阶段不是「选框架」，是**把已选的框架真正用起来**。

## 1. 已定架构决策（用户已确认，执行者不得更改）

- **组件层用 shadcn/ui**：Tailwind 原生、拷贝进仓库、无运行时依赖膨胀、
  与现有 Tailwind 4 天然兼容。
- **密集表格用 TanStack Table**：无头库，只管排序/分页/列定义逻辑，样式仍走 shadcn。
  这是 shadcn 官方推荐搭配。**服务端已有的排序与分页保持不变**，
  TanStack 只接管客户端呈现，不得把服务端分页改成客户端全量加载。
- **只迁日常主路径**：行情图表、条件选股、信号与通知、数据与连接、
  信号台账、持仓账本。冻结模块的研究面板（CANSLIM/威科夫/基本面/估值/新闻）
  **保持原样**，符合 `roadmap.md` §2 冻结纪律。

## 2. 已由管理者预置（不要重装）

- 18 个 shadcn 组件已拷入 `src/components/ui/`
- `radix-ui`（统一包）、`cn`、`@tanstack/react-table` 已装
- **`globals.css` 未改动** —— shadcn 组件依赖的 `--primary`/`--muted`/
  `--border`/`--ring`/`--card` 等 token **目前不存在**，组件会缺色。补齐是 R1 的活。

## 3. 已知的两处不一致

1. **`cn` 导入不统一**：既有 `button.tsx` 从 `~/lib/utils` 导入，
   新生成的 18 个组件从 npm 包 `"cn"` 导入。
   **裁定：统一到 `~/lib/utils`**，改完后管理者移除 `cn` 依赖。
2. **既有 `button.tsx` 不是标准 shadcn**：它用 `cva("button", ...)`，
   基类是自定义的 `button`，不是 shadcn 默认样式。有 38 处调用。
   **裁定：R1 不替换它**，先让新老并存且视觉不冲突；R2 迁移页面时再逐处处理。

## 4. R1 — 基座（不迁页面）

1. 在 `globals.css` 建立 shadcn token 集，**映射到现有配色**，
   使既有页面外观**不发生可见变化**。这是本阶段最容易翻车的一步：
   1098 行手写 CSS 与 token 集必须共存，不是替换。
2. 统一 `cn` 导入到 `~/lib/utils`。
3. 建一个**组件画廊页**（如 `/ui-gallery`），把 18 个组件各渲染一遍，
   供人眼确认配色、间距、暗色下的可读性。这是 B 层的验收载体。
4. 封装一个基于 TanStack Table + shadcn Table 的 `DataTable`，
   **接受服务端已排序已分页的数据**，不做客户端重排。先只在画廊页用。

**验收（A 层）**
- `pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm desktop:prepare` 通过，
  测试数不减少（当前 166 文件 / 1046 测试）。
- **既有页面视觉零变化**：Playwright 对主路径六个页面截图，
  与 `docs/review/q1-review/`、`q2b-review/` 的既有截图对照，差异需逐处解释。
- 画廊页截图存 `docs/review/r1-review/`。

**验收（B 层，用户）**：看画廊页确认设计口味。

## 5. R2 — 迁移日常主路径

按页面逐个替换原生元素为 shadcn 组件，一次一个页面，每个页面单独可验证。
表格改用 R1 的 `DataTable`。

**硬约束**
- **纯替换，零行为变更**。表单校验、提交逻辑、数据流、API 调用一律不动。
- 服务端排序分页语义不变。
- `tests/workbench-refactor.test.ts` 的结构指纹会失败——
  **更新指纹并对新增部分单独精确校验，不得删除或跳过该测试**。
- 不碰冻结模块。

## 6. R3 — 全应用暗色模式（可选，视 R1/R2 结果决定）

当前「暗色主题」只作用于图表（`chart-view.ts` 的 `view.dark` 传给
lightweight-charts），不是全应用暗色。R1 的 token 集若做对了，
全应用暗色会变得廉价。**但不承诺做**，等 R1/R2 落地后再评估。

## 7. 明确不做

- 不引入 Ant Design 或第二套组件库
- 不改冻结模块的研究面板
- 不重写 `chart.tsx` 的图表渲染（TradingView lightweight-charts 保持不变）
- 不借 UI 迁移之机改任何业务逻辑
