---
name: quant-team
description: Codex 管理者通过外部 Claude CLI 调度 researcher/data/trader/risk/backtester/reviewer 六个只读研究角色的固定工作流。
---

# quant-team

用于 Codex 管理者把沪深量化研究拆给六个外部角色。所有角色都通过
`pnpm quant:team` 调用的 Claude CLI 执行；**不要**用 Codex 原生子代理或另行启动
`claude` 命令。

## 硬规则

- **不派生原生子代理**：不要使用 Agent/Task/subagent 机制。角色只能由本 CLI 启动。
- **模型与思考强度用默认值**：不传 `--model`、`--effort` 或 fallback model，不设置
  `ANTHROPIC_MODEL`，不修改 Claude 的 settings 或认证，不覆盖模型、思考强度等相关配置。
- **权限模式显式指定**：调用 Claude CLI 一律显式传 `--permission-mode bypassPermissions`；
  不依赖用户机器上的默认权限模式，也不另加或替换其他权限参数。该模式只表示免交互审批，
  不扩大任务范围或工具面。
- **MCP 关闭**：CLI 使用 `--strict-mcp-config` 和空 `mcpServers`，避免 `--tools` 之外的
  继承 MCP 网络/写入工具泄漏；不要改回继承配置。
- **v1 禁止外部动作与代码编辑**：不提交、不推送、不打包、不下单、不通知、不联网取数。
  研究只引用已有本地结果。不要给角色派发写文件、改代码或扩权任务。
- **研究角色只使用已批准命令**：researcher/data/trader/risk/reviewer 只读；
  backtester 只可通过现有受控 Bash 运行仓库已有构建/回测入口，不得新增脚本。
  仓库源文件、原始数据和既有证据只读；只有授权命令可写任务输出、QUANT_DATA_DIR 或既有构建目标。
  权限被拒绝会返回 `blocked`，不要绕过、改用 `--allowedTools` 或借代理重试；不要为绕开拒绝而
  改写权限模式、工具面或模型参数。
- **不按角色跑全量验证**：单个角色不运行完整测试、构建或打包；集成交付点由管理者统一执行。
- **一次运行只写一份汇总**：`status --run` 的结果就是事实源。管理者写总结时引用任务 ID、
  session ID、结论和证据，不要为了写总结重复计算或重跑任务；也不要为每个角色另建汇总文件。
- **版本不写死**：`candidateVersion` 在运行时从当前策略对象、候选定义或仓库实际版本读取。
  示例中的占位符必须替换，不能把 package 版本、当前日期或历史版本号当候选版本照抄。
- **风险否决必须返回 blocked**：`risk` 若不允许进入回测，必须使用 `status="blocked"` 并把理由写入
  `blockers`；不能用 `status="complete"` 加否决文字。`complete` 的 `blockers` 必须为空。

## 固定工作流

1. **平行摸底**：第一轮只派 `researcher`、`data`、`trader` 三个任务，互不依赖，可并行。
2. **Codex 冻结定义**：读取第一轮 `status` 的真实结论，由 Codex 决定本次候选定义与
   `candidateVersion`，并把决定写成冻结产物。不要把这个决定交给角色投票或让模型自行“冻结”。
   `dependsOn` 只在本批次内有效；第二轮不能依赖第一轮的任务 ID，必须通过 `inputRefs` 引用
   第一轮 `run.json` 和冻结产物。
3. **回测前风险审查**：第二轮先派 `risk`，不写跨 run 依赖；风险未通过不得回测。
4. **回测**：`backtester` 在同一批次内依赖风险审查任务，`heavy=true` 且无论调用者怎么写都会被
   强制视为重型，共享构建/回测槽位最多 1 个。
5. **回测后双审**：`risk` 与 `reviewer` 都依赖同一批次内的回测任务，可并行。两者都完成后管理者
   再决定是否进入下一轮或停止。失败、阻断、取消都以 `status` 的实际状态为准。

角色提示词的唯一源码是 `scripts/lib/quant-team/prompts.ts` 的 `ROLE_PROMPTS`；
技能下的 [references/roles.md](references/roles.md) 只做边界摘要，修改提示词时改 TS 并同步摘要。

## 命令

在仓库根目录执行：

```bash
pnpm quant:team run --input batch.json
pnpm quant:team status --run <runId>
pnpm quant:team cancel --run <runId>
pnpm quant:team cancel --run <runId> --task <taskId>
pnpm quant:team resume --run <runId> --task <taskId>
pnpm quant:team --help
```

CLI 输出 JSON。运行状态保存在 `.test-data/quant-team/<runId>/run.json`，每任务原始
stdout/stderr/prompt 保存在该目录的 `tasks/<taskId>/attempt-<n>/`；摘要会脱敏，原始日志仅供本地诊断。

## 最小可运行示例

### 第一轮：并行摸底

```json
{
  "runId": "roll1-research",
  "maxConcurrent": 6,
  "tasks": [
    {
      "id": "research",
      "role": "researcher",
      "goal": "核对当前候选的策略定义、既有证据和未决问题",
      "candidateVersion": "REPLACE_WITH_CURRENT_CANDIDATE_VERSION",
      "inputRefs": ["AGENTS.md", "docs/roadmap.md"],
      "completionCriteria": ["结论可追溯到实际文件"]
    },
    {
      "id": "data",
      "role": "data",
      "goal": "核对数据来源、时点、证券池、复权与缺失语义",
      "candidateVersion": "REPLACE_WITH_CURRENT_CANDIDATE_VERSION",
      "inputRefs": ["AGENTS.md", "docs/invariants.md"],
      "completionCriteria": ["列出可用数据与缺口"]
    },
    {
      "id": "trader",
      "role": "trader",
      "goal": "基于候选定义写出规则、执行条件与失效条件",
      "candidateVersion": "REPLACE_WITH_CURRENT_CANDIDATE_VERSION",
      "inputRefs": ["AGENTS.md", "docs/next-plan.md"],
      "completionCriteria": ["规则可由他人复核"]
    }
  ]
}
```

### 冻结产物

Codex 读取第一轮 `status` 后，把决定写到
`.test-data/quant-team/freeze-roll1-research.json`（本地任务产物，不是代码）：

```json
{
  "sourceRunId": "roll1-research",
  "sourceRunPath": ".test-data/quant-team/roll1-research/run.json",
  "candidateVersion": "REPLACE_WITH_FROZEN_VERSION",
  "decision": "freeze candidate and plan for risk review and backtest",
  "decidedAt": "REPLACE_WITH_RUNTIME_TIMESTAMP"
}
```

### 第二轮：风险 → 回测 → 双审

第二轮只在本批次内使用 `dependsOn`；它通过 `inputRefs` 引用冻结产物和第一轮 `run.json`：

```json
{
  "runId": "roll2-risk-backtest",
  "maxConcurrent": 6,
  "tasks": [
    {
      "id": "risk-before",
      "role": "risk",
      "goal": "审查冻结候选的数据时点、未来函数、成本与权限边界，决定是否允许回测",
      "candidateVersion": "REPLACE_WITH_FROZEN_VERSION",
      "inputRefs": [
        ".test-data/quant-team/freeze-roll1-research.json",
        ".test-data/quant-team/roll1-research/run.json",
        "AGENTS.md",
        "docs/invariants.md"
      ],
      "completionCriteria": [
        "允许回测时返回 complete 且 blockers 为空",
        "否决时返回 blocked 并把理由写入 blockers"
      ]
    },
    {
      "id": "backtest",
      "role": "backtester",
      "goal": "只运行仓库已有受控回测入口，记录命令、数据时点、证券池、复权与成本口径",
      "candidateVersion": "REPLACE_WITH_FROZEN_VERSION",
      "inputRefs": [
        ".test-data/quant-team/freeze-roll1-research.json",
        ".test-data/quant-team/roll1-research/run.json",
        "docs/conventions.md"
      ],
      "completionCriteria": ["命令可复现", "明确规则自检而非可信业绩"],
      "dependsOn": ["risk-before"],
      "heavy": true
    },
    {
      "id": "risk-after",
      "role": "risk",
      "goal": "复核回测结果的风险与证据缺口",
      "candidateVersion": "REPLACE_WITH_FROZEN_VERSION",
      "inputRefs": ["docs/invariants.md"],
      "completionCriteria": ["指出可复现风险与不可用结论"],
      "dependsOn": ["backtest"]
    },
    {
      "id": "review",
      "role": "reviewer",
      "goal": "对照预声明策略/计划与实际成交或结果，复盘数据与执行偏差，不重跑全量测试",
      "candidateVersion": "REPLACE_WITH_FROZEN_VERSION",
      "inputRefs": [
        ".test-data/quant-team/freeze-roll1-research.json",
        ".test-data/quant-team/roll1-research/run.json"
      ],
      "completionCriteria": ["结论只引用已有结果", "列出阻断或下一步"],
      "dependsOn": ["backtest"]
    }
  ]
}
```

`runId` 只能用字母/数字/点/下划线/连字符，不能包含 `..` 或路径分隔符。冻结产物和
`run.json` 必须是实际存在的本地文件，不能编造引用。

## 状态、取消与恢复

- 任务状态：`queued` / `running` / `completed` / `blocked` / `failed` / `cancelled`。
- 只有 `completed` 依赖能解锁下游；`blocked` / `failed` / `cancelled` 会把下游标为 `blocked`，
  不会挂起。
- `cancel` 会立即取消尚未开始的任务；运行中的任务只会终止本 CLI 自己创建的子进程树，
  等待退出后才释放重型槽位。超时（`TIMEOUT`）与取消（`CANCELLED`）是不同状态。
- 崩溃后遗留的 `running` 任务会被标记为中断失败，**不会自动重试**。若子进程 PID 仍存活或无法确认，
  任务会保持 `blocked`，`resume` 拒绝执行；CLI 不会结束未知 PID，需人工核对进程。
- `resume` 只接受 `failed` / `blocked` / `cancelled` 且已有已知 `session_id` 的任务；
  已完成任务拒绝，未知 session 拒绝（不会使用 `--continue`）。恢复会保留历史 attempts，
  并用原 session 执行 `--resume`。
- 因依赖未完成而阻塞、从未运行过的任务没有 session，不能用 `resume`；请由 Codex 新建运行。
- 上游结果变化时拒绝静默复用，必须新建运行。
- 同一个 `runId` 重复 `run` 会幂等返回已有状态；同一 `runId` 改定义会拒绝。
- 整个 team root 只有一个协调器锁：另一个 run 正在执行时，新的 `run`/`resume` 立即返回
  `TEAM_BUSY`，不会自动等待；`status` 与 `cancel` 仍可使用。

## 清理

运行目录会持久增长。清理前核对目标归属、路径、进程与保留项；批量或不可逆删除先看默认预演清单，
再按当前权限边界执行（本仓库调用 Claude CLI 使用 `--permission-mode bypassPermissions`），
完成后核对实际剩余项。示例见 [references/cleanup.md](references/cleanup.md)。清理只针对
`.test-data/quant-team/<runId>` 和本次任务根的临时产物；证据日志在核对前保留。不得删除原始数据源、
正式包、用户业务库或其他任务产物。已拒绝的操作不能换执行者重试。

## 边界

本 CLI 不新增应用 UI、服务或 MCP 入口，不修改 `src/`、`packages/` 业务代码，也不接入交易接口。
角色输出只是研究证据，不是可信策略业绩或下单依据。
