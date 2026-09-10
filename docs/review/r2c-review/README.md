# R2c 核对

仅迁移四个获授权文件的 18 处控件：connections 6 Input + 2 Checkbox + 1 Select；strategy-fields 5 Input；task-history 1 Select + 1 DataTable；evidence-analysis 1 Textarea + 1 Select。业务回调与组件逻辑沿用替换前基线，结构指纹更新并补精确检查。

## 验证与截图

- typecheck、全量 test（170 文件 / 1062 测试）、build、desktop:prepare、format:check 通过。最终“全部”占位文字另经四个相关文件的 18 项测试及浏览器复核。
- Playwright 使用 `.test-data/r2c/browser`，22 条合成历史任务；实际设置保存仅写隔离库，外部请求 0、页面异常 0。
- [连接](connections.png)：文字/数字填写、模型切换、复选框开关、保存参数。
- [策略字段](strategy-fields.png)：五个受控数值均可修改。
- [证据分析](evidence-analysis.png)：多行输入、研究方法选择；浏览器阻断启动快照请求，专门核对无快照时提交禁用。冻结子面板未操作。
- [任务历史](task-history.png)：创建时间倒序、20+2 条游标分页、返回上页、失败筛选、详情、全部重置。原页没有切换排序功能，未新增排序控件。
- [机器结果](result.json)。持久脚本：`tests/r2c-seed-review.ts`、`tests/r2c-browser-review.mjs`，浏览器服务端口 3217，运行前须设置上述隔离目录。

按 conventions §5.5 目视复核，功能可用、观感无明显退步；接受 UI 默认边框、圆角、行高、间距及下拉浮层，不做像素对齐，不改 globals.css。没有进入 R3，也没有 commit/push 或 smoke/pack。无新增待用户决定事项。

## 最终原生元素计数

扫描 `src/**/*.tsx` 的 JSX 起始标签（不将 `table.FlexRender` 误算为原生 table），排除 `src/components/ui/`。非冻结模块四种元素均为 **0**。以下冻结模块按 conventions §9.5 全部豁免、未修改。

| 文件（相对 src/components） | input | select | textarea | table | 合计 |
|---|---:|---:|---:|---:|---:|
| `backtest-actions.tsx` | 0 | 0 | 0 | 3 | 3 |
| `canslim-panel.tsx` | 0 | 1 | 0 | 1 | 2 |
| `cash-dividend-experiment.tsx` | 3 | 0 | 0 | 1 | 4 |
| `chan-panel.tsx` | 0 | 1 | 1 | 0 | 2 |
| `financial-growth-panel.tsx` | 0 | 0 | 0 | 1 | 1 |
| `financial-quality-panel.tsx` | 0 | 1 | 0 | 1 | 2 |
| `fundamental-report-panel.tsx` | 0 | 3 | 1 | 0 | 4 |
| `news-panel.tsx` | 3 | 3 | 0 | 0 | 6 |
| `news-sector-panel.tsx` | 0 | 1 | 0 | 0 | 1 |
| `revenue-reconciliation-panel.tsx` | 0 | 0 | 0 | 2 | 2 |
| `theme-prices-panel.tsx` | 0 | 0 | 0 | 1 | 1 |
| `valuation-panel.tsx` | 3 | 2 | 1 | 1 | 7 |
| `walk-forward-panel.tsx` | 2 | 1 | 0 | 1 | 4 |
| `wyckoff-panel.tsx` | 0 | 1 | 1 | 0 | 2 |
| `workbench/backtest-view.tsx` | 2 | 1 | 0 | 1 | 4 |
| 合计 | 13 | 15 | 4 | 13 | 45 |
