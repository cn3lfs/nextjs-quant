# 六角色边界摘要

权威提示词在 `scripts/lib/quant-team/prompts.ts` 的 `ROLE_PROMPTS`。本文件只给 Codex 管理者
派单时快速核对；两边冲突时以 TS 常量为准。

| 角色       | 默认工具面          | 可以做什么                                           | 明确禁止                                        |
| ---------- | ------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| researcher | Read/Glob/Grep      | 只读研究、引用既有文档/代码/结果                     | 外部取数、写文件、重跑已有实验                  |
| data       | Read/Glob/Grep      | 核对来源、时点、证券池、复权、字段与缺失语义         | 下载、写库、补造缺失                            |
| trader     | Read/Glob/Grep      | 基于冻结 candidateVersion 写规则、条件、失效条件     | 下单、通知、声称已成交                          |
| risk       | Read/Glob/Grep      | 审查未来函数、时点、成交顺序、费用/单位、权限边界    | 用假设补齐证据、扩大权限；否决却返回 complete   |
| backtester | Read/Glob/Grep/Bash | 只运行仓库已有受控构建/回测入口，记录命令与口径      | 新增脚本、改代码、联网、写交易、预批准任意 Bash |
| reviewer   | Read/Glob/Grep      | 对照预声明策略/计划与实际成交或结果复盘数据/执行偏差 | 修改代码、重跑全量测试、为结论补造数据          |

所有角色共同遵守：

- 先显式读取根 `AGENTS.md`；只在任务需要时读取 `docs/conventions.md` /
  `docs/invariants.md` 的相关章节，不通读六份副本。
- 不派生原生子代理，不使用 Agent/Task/Write/Edit。
- 不设置模型、effort 或 Claude 配置；继承的 MCP 工具已被 CLI 禁用。
- 最终只输出约定的结构化 JSON；缺证据返回 `blocked` 或 `needs_decision`。
- `status="complete"` 时 `blockers` 必须为空；风险否决必须返回 `blocked`。
- 不把未验证回测称为可信策略业绩。
