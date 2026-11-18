# Claude 专家协作入口

Codex 主线程负责管理与决策，researcher、data、trader、risk、backtester、reviewer 六类专家全部由外部 Claude CLI 执行。沿用 Claude 默认模型，不读取或修改模型配置，不传模型选择参数。

入口为 `pnpm quant:team`，操作说明见[项目技能](../../../../.agents/skills/quant-team/SKILL.md)。任务状态与专家结果集中在 `.test-data/quant-team/<runId>/`，本次实现与验收记录集中在 `.test-data/quant-team-20261118/`。临时目录与复现证据由交付时的精确清理脚本分开列出；未核实的执行不写成通过。

首版用于现有策略研究协作，管理者负责冻结候选和决定何时启动下一阶段。程序管理外部进程，不自行作研究决策；研究输出与风控判断不能触发真实交易、通知或生产库写入。外部进程不占 Codex 原生子代理槽位。

## 验证

- 定向 Vitest 两文件 30 项通过，包含超过三个执行者的调度、重型串行、依赖阻断、重复定义、会话关联、权限拒绝、孤儿进程拒绝恢复、取消/超时及真实继承管道场景。日志为任务目录 `vitest.log`。
- 最终 `pnpm exec tsc --noEmit --incremental false --pretty false` 退出 0；新增脚本、两份测试、技能和 package 的 Prettier 检查通过。没有运行应用构建或全量应用测试：此次入口不进入应用运行链，也未修改业务实现。
- 真实六专家在 `quant-team-sma200-six-roles` 同批启动，最终 6/6 completed；复盘任务先 cancelled、后在同一 session ID 下 completed，保留两次尝试。原运行与恢复的 CLI 非零退出码均按当时取消/失败状态保留，不改写为全绿。
- 管理者冻结 `sma200` 现有源码身份和研究边界；六角色复用该说明及本地证据，未重新回测。研究员区分状态条件与穿越事件，数据专家保留成分前视和非独立留出限制，风控仅允许只读分析，回测与复盘不认证盈利或实盘资格。此验收证明协作与交接，不证明策略收益。
- 初批 `quant-team-smoke-feasibility` 保留两项三分钟超时及交易员 needs_decision；研究员原会话恢复仍超时后停止，不循环重试。新批明确冻结输入并采用正常任务预算，旧失败未覆盖。
- 实测发现 Windows 下已退出的 Claude 子进程仍可能等待继承输出管道关闭；修复为 owned 子进程退出后的有界输出排水，取消/超时还需等待 owned 进程树终止，再释放名额。真实父子孙进程用例保护这一行为。

## 使用与限制

管理者在 Codex 中加载 `$quant-team`，先执行 `pnpm quant:team --help`。批次使用技能内的 JSON 契约，`run --input <文件>` 前台运行，独立调用 `status --run <ID>` 和 `cancel --run <ID> [--task <ID>]`；只有已知 Claude 会话的终止任务才接受 `resume --run <ID> --task <ID>`。

六路上限与一个重型名额由同一 team root 的协调锁保证，不同 run 争用时明确 TEAM_BUSY，不另开协调器突破上限。异常退出后，旧子 PID 存活或无法确认时拒绝恢复，不结束未知 PID。进程级工具范围不等于独立操作系统沙箱；回测 Bash 仍使用原正常权限，管理者必须提供已批准的现有入口。

模型、effort 与认证配置不读取、不覆盖；CLI 不传模型参数、不启用 bare/bypass，也不预批准任意 Bash。任务明确关闭继承 MCP 工具，不修改用户 MCP 文件或全局设置。

## 收尾

任务证据保留在本文开头列出的两个目录，包括冻结输入、尝试记录、原始结果、类型与测试日志。一次性提示文件与检查隔离目录已通过任务根的 `cleanup.ps1` 精确清单交 Claude 正常权限预演和执行，6 个目标已删除，主代理逐项核对不存在；回执见 `cleanup-result.json`、`cleanup-dry-run.json` 和 `cleanup-apply.json`。系统 TEMP 中无法唯一确认归属的历史目录不批量删除。未提交、推送、打包或部署。
