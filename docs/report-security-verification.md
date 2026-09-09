# 通用报告关联证券核验

2026-09-09，模块 A 的增量。

通用报告接口增加独立 `securityContext`，从保存的 contextId 关联记录解析证券：快照直接读取身份；回测/滚动检验沿 input.snapshotId 读取快照；监控信号读取其证券并核对关联快照。只在 SQLite 投影身份字段，不加载关联 K 线。未知记录、无效代码及冲突关联返回 null，不从模型标题、正文或引用推断证券。

报告卡片展示“关联证券：当前主档名称 · 代码”。归档旧名作为缺名回退并在名称变化时提示；未知关联明确显示。原报告标题、正文、模型信息和导出保持原样。

验证：

- 3 项新增测试覆盖快照/回测/信号关联、冲突和无效身份、缺失关联快照、原始快照不变。
- 完整 141 文件 / 669 测试、typecheck、build（含 runtime）、desktop:prepare、desktop:smoke 全部通过。
- 隔离数据库固定报告样本，自动分析关闭；生产 HTTP 返回独立身份，剥离新字段后与原报告深度相等，存储报告和快照不变。脚本及结果为 `output/verify-report-security-http.mjs`、`output/report-security-http-verification.json`。
- 浏览器档案页显示“关联证券：京华激光 · SH603607”，原题“旧名称样本研究（界面验证样本）”和固定正文未改。实际点击导出，Markdown 保留旧题且不混入当前名。证据为 `output/playwright/report-security-archive.txt` 和 `report-security-export.md`。
- 没有模型调用、真实通知或 EXE 打包；测试库新增的唯一报告是固定界面验证样本。

边界：本次覆盖通用 ReportCard。CANSLIM、缠论、威科夫、基本面专门档案及其他消费者仍需各自统一名称展示；原 A–H 方案整体尚未完成。
