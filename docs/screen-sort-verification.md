# 全候选服务端排序核验

2026-09-09，模块 C 增量。

候选结果增加证券代码、收盘价、涨跌幅、量比和趋势分的升降序选择，默认保留任务原始顺序。先筛选全候选，再排序，最后每页 50 条分页；数值相同时代码升序决定位置，缺失或非有限数值在两个方向均放末尾。排序仅操作过滤后的数组，不改写存储候选、指标或快照。

界面切换字段/方向或搜索时回第一页，更新期间提示并暂禁翻页；原始顺序禁用方向选择。首页快速结果只用于无搜索且原始顺序，其他排序必须读取服务端完整候选排序结果。导出仍保留完整原始任务结果，不混入展示排序。

## 验证

- 新增测试覆盖 123 行跨页排序、搜索后排序、恢复原顺序、代码排序、并列值、缺失值和 NaN，原数组/指标不变。
- 完整 142 文件、673 测试，typecheck、build（含 runtime）、desktop:prepare、desktop:smoke 均通过。
- 首次 typecheck 发现上一轮新增的两个浏览器观测片段 .js 被 tsconfig 纳入源码检查；已将片段改为 .txt，保持可通过 Playwright --filename 读取，没有修改 tsconfig 或关闭类型检查；随后完整检查通过。
- 原 434 候选只读复制到隔离库；真实 HTTP 五字段两方向，共 10 种排序各遍历 9 页，逐条与全量排序结果深度相等；搜索海鸥住工命中 1 条；原任务与完整导出不变。脚本 `output/verify-screen-sort-http.mjs`，结果 `output/screen-sort-http-verification.json`。
- 浏览器从第 2 页切换涨跌幅排序后回第 1 页，降序首行 sh605168、升序首行 sz300468，与全量接口结果一致。搜索海鸥住工后 1 条，清空并恢复原始顺序后仍 434 条，方向禁用。
- 页面证据 `output/playwright/screen-sort-original.txt`、`screen-sort-change-desc.txt`、`screen-sort-change-asc.txt`、`screen-sort-search.txt`、`screen-sort-restored.txt`。

此复核不重新计算指标，也不把原任务中的旧时点候选视为当前有效池。未调用模型、写入通达信源、发送通知或打包 EXE。完整 A–H 方案仍未整体验收。
