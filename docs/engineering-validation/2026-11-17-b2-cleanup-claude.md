# B2 清理执行单（交给 Claude）

用户已要求清理统一写成脚本交给 Claude 执行。本单只包含 B2 已确认的一次性产物；不授权扩大到其他任务。当前状态为**脚本已交付，删除尚未执行**。

## 执行范围

- 工作区：`D:\github\nextjs-quant`。
- 脚本：[cleanup-b2.ps1](../../../../.test-data/b2-20261117/cleanup-b2.ps1)。使用 PowerShell 7（`pwsh`）。默认仅预览；只有 `-Apply` 才删除。
- 原预览为 21 个目标、776.33 MiB；以执行前新预览为准。包括本任务 `checks`、`data`、`ui-data`、临时验证脚本/配置、重复下载、可从已校验 gzip 恢复的两份原始导出和页面临时快照。
- 保留研究分支、冻结输入、结果、失败/恢复记录、截图、压缩导出、审查和验证回执；脚本在删 `checks` 前提取检查结果。保留标准 `.next`、`runtime` 构建、依赖和正式 `release`。
- 原始通达信/Blocks、已有行情归档和研究输入、生产库、凭证、其他任务的修改全部不在清理范围。不提交、推送、打包、部署、停止未知进程或修改 `src/server/mcp.ts`。

## 给独立 Claude 会话的任务

先读仓库 `AGENTS.md` 和本单，再审查脚本及任务内 `cleanup-receipt.json`、`browser/compression-receipt.json`。遵守当前会话正常权限和审批；此前 Codex 删除被策略拒绝，仅返回 `blocked by policy`，本单不授予绕过限制的权限。若本会话也拒绝，记录原因并停止，不更换工具或关闭审批重试。

1. 在上述工作区预览：

   ```powershell
   pwsh -NoProfile -File .test-data/b2-20261117/cleanup-b2.ps1
   ```

2. 核对全部绝对路径只在任务目录、无链接、任务进程已停、端口 3925 空闲；核对重复下载哈希和 gzip 恢复校验。脚本已有这些检查，不降低检查来继续执行。若预览与原目标类别不一致，先报告变化。
3. 在正常权限允许时执行已获用户授权的范围：

   ```powershell
   pwsh -NoProfile -File .test-data/b2-20261117/cleanup-b2.ps1 -Apply
   ```

4. 核对 `cleanup-receipt.json` 为 `completed`，逐个确认其中 `Entries.Path` 不再存在。再默认预览，应为零目标；确认研究目录、截图、两个 gzip 和检查结果回执仍在。
5. 报告实际目标数、释放字节数、保留项和任何失败；只有核对后才将 B2 交付记录和 next-plan 的“待执行”改成“已完成”。不更改历史测试结果或研究结论。

## 主代理交付边界

当前 Codex 会话只交付脚本、预览和 Claude 只读审查，不再次发起被拒绝的删除。外部执行结果以实际回执为准；交接完成不代表磁盘已清理。

Claude 已完成首版只读审查，原文在任务目录 `claude-cleanup-review.txt`。根据审查补齐了父目录链接检查、PowerShell 7.2 要求、结构化预览清单及脚本/压缩回执哈希、执行逐项回执、部分失败留证与禁止覆盖、完成后重复执行不覆盖首次回执。原始导出已缺失时仍校验 gzip；检查结果归档如同名且内容不同则停止。最终版本语法与默认预览通过：21 项、776.33 MiB，清单见任务目录 `cleanup-preview.json`。未执行删除分支，Claude 执行时仍须核对最终脚本；首版审查不能当作最终版执行验收。
