# 原434候选验收证据

2026-09-09，原任务 `job-e0dfbd0e-c8e1-4c55-97c3-832603569f6c` 仍在生产数据库。以只读连接取得原任务及434份快照，未用新生成候选替代原案例。

复核命令：`pnpm exec tsx scripts/verify-original-screen.ts`。它只读生产库和 E:/new_tdx64，把归档行情值重建到独立临时目录再交给当前筛选引擎；重建样本不冒称原始磁盘字节。快照、源文件和原任务分别验证不变。报告输出到 `output/original-screen-verification.json`，完整33＋10条说明在 `C:/Users/jm/Documents/nextjs-quant/原434候选复核-2026-09-09.md`。

- 原档案重放：401个2026-09-07候选、33个旧时点隔离；31个名称缺失者全部在旧时点组。401个已接纳候选的300根窗口及指标与原档案完全一致。
- 当前源重放：391个有效、43个隔离；另外10个北交所当前日线文件只到2025-09-30，原快照却到2026-09-07。该差异按来源缺口披露，不改写日期或认定退市。测试期间434个文件hash未变。
- 首次校验按401预期运行当前文件，实际391导致断言失败。核对原快照与文件原始日期后，增加独立归档重放验证401；当前源的额外10个代码、日期和隔离原因另作精确断言。没有为了通过而删除原401要求。
- `output/original-screen-http-verification.json`：真实生产接口9页50×8＋34、434个唯一证券、导出逐项一致、名称搜索通过。旧档案asOf仍为空并保留警告，不倒填统一日期或证券池来源。
- `output/playwright/original-screen-page-2.txt`至`original-screen-page-9.txt`：浏览器逐页验证，最后34条和禁用下一页。
- `output/playwright/original-five-minute.txt`、`original-candidate-research-final.txt`：切换全局5分钟后，从第9页打开京华激光研究，仍为原日线300根、截止2026-09-07。日K按钮实际class为selected；只是打开快照，没有启动模型分析。
- 660项测试、类型检查、生产构建（含runtime）、desktop:prepare和desktop:smoke通过。

覆盖范围：原434案例的混时点隔离、规则与价格不变、分页导出及候选自身周期。6143全池当前成功路径、完整历史证券池、主档全部消费者、所有阶段计数及A–H其他要求仍需继续核验。
