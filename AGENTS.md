# Repository guidance

## 工作范围与决策

- 修改前读 `docs/roadmap.md`，当前交付与验收见 `docs/next-plan.md`。用户最新明确授权优先；同步调整计划，不让旧冻结清单阻止已授权开发。
- 项目处于开发阶段，目标是个人沪深量化工作台：行情与原生缠论图表、多周期 RPS、公式选股、双突破、现行策略研究/回测和交易复盘。旧样本研究与旧执行入口按优化方案退役；其他市场保持已有授权范围，不顺手扩展无关模块。
- 按可验收的小阶段推进。先核实、复用已有能力；完成当前阶段必要检查后再进入下一阶段。
- 命名、签名、边界等局部决定自行处理。未授权范围、付费数据、重大架构取舍或不可逆操作先提出具体方案；独立工作继续。
- 历史验证按计划开发，先明确数据时点、交易规则和指标口径。未经验证的旧回测只能作为规则自检，不能称为可信策略业绩。
- 性能工作由可复现瓶颈和当前验收需要驱动，不作为无期限独立目标。

## 实现与验证

- 新增与重构优先采用职责清晰的最优结构，不保留旧接口兼容层或为兼容扩展需求范围；2026-11-13 用户授权清理项目不再使用的历史结果与证据，不保留旧功能兼容；保留原始数据源、现行功能和测试所需输入，不能按目录名一概删除。
- Windows-first；前后端 TypeScript，Electron 负责宿主和 bundled Node 服务。工程约定见 `docs/conventions.md`，正确性约束见 `docs/invariants.md`。
- 改动级运行相关 Vitest 与 typecheck；子任务运行 `pnpm test`；有意义的应用交付运行 `pnpm build`，涉及 runtime 时重建 worker，桌面交付前运行 `pnpm desktop:prepare`。
- 纯文档改动检查内容、链接和 diff，不机械运行应用全套测试。浏览器/桌面验证按受影响交互与实际环境能力执行；失败记录具体原因，不反复无效重试。
- 不假定当前代理有或没有网络、GPU、显示权限。优先复用现有依赖；确需新增说明理由和影响，遵守当前环境权限，不用手写替代品绕过缺失依赖。
- 持久验证用例放 `tests/`；临时数据隔离并明确清理方式。不重建 `output/` 或一次性验证档案库。
- `docs/decisions.md` 记录决定、取舍及与预期不符的事实；检查结果放交付说明。

## 数据、交易与凭证

- 通达信和外部 Blocks 目录只读；新解析器需要固定 fixture 与非法输入测试。
- 数据来源、时间、证券池、复权模式明确，研究快照可复现，缺失不能补造。
- 可能打开数据库或应用迁移的开发/验证先设置隔离 `QUANT_DATA_DIR`，不得使用默认生产库。不得删库或降低 user_version 绕过版本检查。
- 新迁移使旧 exe 落后，交付时说明；打包需明确授权，仅使用 `release/win-unpacked`，应用运行中不替换现有 release。
- 校验 LLM 结构、证据和版本；不执行生成代码，不自动下单。
- 通知须有启用订阅；真实测试消息需明确测试请求和目的地。未经授权不外发、不交易。
- 凭证使用仓库外 Windows DPAPI，不输出 API key、webhook、token 或认证信息。

## 共享工作区与提交

- 开始前检查 git 状态；保留用户和其他任务的修改，不因无关 diff 回退、暂存或覆盖。
- 撤销不明来源改动前核对修改时间、进程和归属；仍不清楚则询问。
- 每阶段保持差异可审查并报告验证。提交、推送、发布各需对应授权；未授权提交不妨碍继续已授权且可隔离的工作。
- `src/server/mcp.ts` 及其 UI 文案由用户维护，未经明确交接不修改、不回退、不纳入提交。

## 临时文件与交付收尾

- 创建临时文件前先复用已有能力；本任务脚本、日志与隔离数据集中在一个可识别的任务目录，不在仓库根或同级不断新建副本，不为每次检查新增长期档案。
- 临时 worktree 仅在隔离脏改等确有需要时创建，记录归属与删除条件。交付核对后清理本任务的一次性构建目录、检查脚本和中间产物，并用 Git 注销 worktree；不能默认以“留待复核”为由长期保留整套 node_modules、构建和打包副本。
- 正式产物只留 `release/win-unpacked` 与简短交付记录；回滚备份确需保留时只留一份，说明位置与清理时点，下一次交付不得无期限累积。用户要求脚本手动清理时交付可预演、精确列出目标的脚本，不擅自执行删除。
- 清理前核对绝对路径、目录链接、worktree 修改和相关进程；只清理归属明确且已授权的任务产物。不得按 ignored/隐藏目录一概删除，不动正式包、主工作区依赖、用户业务数据库、原始数据源、当前使用的输入快照、凭证或其他任务修改；已核实不用的历史衍生结果按最新清理授权处理。
- 将清理作为任务收尾的一部分，报告已清理项及确需保留项；未获删除授权或清理失败时说明具体目标和原因，不默默遗留。本次浅色打包遗留使用 `scripts/cleanup-light-package.ps1`，默认预演，`-Apply` 执行并删除旧包备份。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
