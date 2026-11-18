# 策略闭环实施记录

状态：COMPLETE / 工程交付完成。最终 `pnpm check --build`、`desktop:prepare`、财务 v2 必要门禁与真实单年 smoke、合成三成本 seed、最终 UI 验收与清理均已完成；下列研究与数据限制继续保留，但不作为执行 TODO。本文只记录当前结论与必要失败历史，不把工程可运行、规则自检或合成 fixture 写成真实收益资格，也不声明打包发布。

## 当前结论

- **72 场景迁移对拍经济等价**：理论 32 + 结构 32 + 多周期 8；三组 `economicOk=true`，匹配键 32/32/8；首次 32/32/8 完成，第二次 0 新算并恢复 32/32/8。
- **多周期材料 `materialOk=false` 保留**：CN 四个变体输入身份因 TDX 日线在 2026-11-17 追加了窗口（截至 2026-11-13）之外的记录而变化；抽检的 CN 日线旧源版本匹配截至 2026-11-16 的前缀，crypto 四个变体零差异。旧固定输入 8 例重放 8/8 字节相同，仅补充证明旧输入可复现旧结果，不撤销材料失败。
- **真实 ORB 三成本成交 72/42/28**（zero/base/double）；base/double 各 9 笔延迟卖出，所有中间槽位有同订单拒单；double 唯一被抑制入场由前持仓 1.211724 与 10 次滑点拒单解释，`unexplainedSuppressions=0`。原始 `ok=false` 为检查假设错误并保留；修正后 verify-only 回执 `ok=true`。这是规则自检，不是收益认证。
- **已接受 19 个纯组件与 1 个 ORB 代理**（按既有回执）；它们是可复用分析/执行组件，不是完整策略或收益验证。
- **最终工程门禁通过**：`pnpm check --build` exit 0，首次无失败；7641 tests passed/27 skipped，752 files passed/16 skipped；3 条既有 Vite configLoader native tooling 警告，无六条 full-repository trace 警告。日志 `review/full-check-v2.log`，进度 `review/integration-progress-v2.json`，check result 保留在 `review/check-OBNER8-result.json`。
- **桌面准备通过**：`pnpm desktop:prepare` exit 0，guard 未拒绝，未打包；worker SHA256 `deb1b5e8c5f6df86df7fcfd452c47a800c8cf85b2427d2147b8f41b639fb67ec`，identity.hash `d95132d7f6d460ee49440a14b9bff6c67f52c73fe6b3d75617a5315f408ed56c`。
- **财务 v2 与真实 smoke**：严格 UNKNOWN 实现完成并通过必要门禁；真实 smoke 仅 sh600008/2020 单年 CLI，exit 2 expected blocked，positions/magicEligible/completeMagic 均为 0，未创建 portfolio。原四场景/八次 blocked P5 保留历史，不是新的 799×7/F-score 全池回归。
- **合成三成本 seed**：三个 preset 各 seed 两次均 exit 0；每场景 28 fills/1 reject/781 curve points/6 positions；旧 checkpoint/result 不变，新 journal 确认 reused。独立导出校验三场景 passed，corrupt copy rejected。它是合成认证零成功，不是真实盈利/合格证据；实际 app UI 验收已通过（合成可用性验证）。证据见 `financial/v2/seed-ready.json`、`financial/v2/final-execution-receipt.json`。
- **财务真实数据 blocked**：已收集的 P5 真实运行中，799 池、2020–2026、三成本各两次均 blocked，7 年无完整魔法公式事实，未生成组合/现金曲线；F-score 缺发行普通股事实同样 blocked。旧 eligible 把 FN31/FN32 未知误当合格，严格完整性随后阻断，是已确认规则缺陷，不是应放宽的数据误报。
- **应用验收已见**：ORB 真实任务 42 成交/9504 曲线点并独立复算一致；财务 2 只/2025 blocked；799 任务取消至 10%、同参恢复后 blocked；1024/1440 无横向溢出，console errors 0。

## 必要失败历史

- `check-HLRhcN` lint exit 1 保留；`check-gzEoEP` 7/7 exit 0、7639 通过/27 跳过为历史完整门禁，不是最终门禁。
- 原始 ORB receipt `ok=false`、真实 799 三成本 blocked、F-score blocked、2020–2026 无完整魔法事实均保留，不重写为成功。
- 2023 旧开发记录 157 与既有旧口径审计 154 数量相差 3；`2023-candidate-difference.json` 列出 4 只报告期/EV 变化样本，不照抄旧值。

## 当前实现与验收边界

- 财务 v2 严格 UNKNOWN 实现完成并通过必要门禁；真实 smoke 仅 sh600008/2020 单年 CLI，exit 2 expected blocked，positions/magicEligible/completeMagic 均为 0，无 portfolio；不是新的 799×7/F-score 全池回归。
- 此前 11 项 pure + 17 项 work 窄测报告保留为过程证据；最终工程门禁以本次 7641/27 为准。
- 原四场景/八次 blocked P5 运行保留为历史证据；真实最终 smoke 仅 sh600008/2020，不重跑 799×7/F-score。
- 合成三成本各两次 seed 已完成并复用；它独立于真实数据/合格业绩，实际 app UI 验收已通过（合成可用性验证）。

## 最终 UI 与清理

- 最终 UI 验收通过：三成本历史、28 fills 分页 20+8、1 reject、781 curve、刷新、完整 JSON 下载、1440/1024、ORB 文案/预填均通过；仅为合成数据可用性验证，不是真实业绩。浏览器已关闭，3937 已停止。回执 `runner/final-ui/receipt.json`。
- 清理 Apply exit 0：386/386 删除、0 failures/blockers、1,415,022,070 bytes，正常权限、无重试；回执 `cleanup/receipts/apply-20261117-154007.json`，manifest `ecfb1a208d19ae3fc01c55f50e103ebab3daf925975efba1b720c14d61adf52f`。必要 P5 输入/结果/checkpoint/final UI/复现证据按 manifest 保留。

## 分工与边界

根代理此前独立验证保留为历史事实。自用户最新授权起，根代理只派单/决策；剩余 UI 验收与清理已由 Claude 正常权限完成。未提交、推送、正式打包部署、生产库迁移、真实通知或交易；开发验证使用隔离数据。证据索引见任务目录 `readiness/final-evidence-map.md`。
