# 多 Agent 指挥官工作流（Multi-Agent Commander Fleet）

日期：2026-11-20

## 背景与目标

总结近期三期大型实战会话（`e02b5869` 全局重构、`f93e9ed0` 7 工作区 UI 重塑、`7aa90f52` THSDK 全量接入）的经验与卡点，将零散的跨 CLI 临时脚本升级为一套全局可复用、具备实时心跳、互斥文件校验、受保护文件守卫、安全重试与跨引擎 Fallback 的五角色工程协作工作流。

## 五角色模型分工

| 角色 | 引擎 ID（`fleet.mjs`） | 底层 CLI 与模型 | 定位与职责 |
| :--- | :--- | :--- | :--- |
| **指挥官 (Commander)** | Antigravity 主会话 | 高阶统筹会话 | 总览全局、调研拍板、锁契约与波次分工、审阅回执、终验交付 |
| **重装攻坚** | `codex-astra` | 本机 Codex CLI (`gpt-6.2-astra`) | 复杂架构重构、核心算法/回测引擎、Schema 迁移、FFI/Worker/并发、疑难排查 |
| **专职审校** | `codex-sol-review` / `codex-sol` | 本机 Codex CLI (`gpt-6.2-sol`) | 默认波次与提交前只读 Code Review（P0/P1/P2）、契约与不变量核查 |
| **高速日常主力 A** | `claude-deepseek` | 本机 Claude Code CLI（接入 DeepSeek 默认模型，`--permission-mode bypassPermissions`） | 前端页面/组件、tRPC 对接、样式精修、Playwright 验证脚本、快速缺陷修复 |
| **高思考强度主力 B & 调研** | `agy-hydrogen` | Antigravity CLI (`gemini-4-hydrogen-high` 默认，`high` 思考强度) | 与 `claude-deepseek` 组成双轨并行开发（独立模块、单测、文档/配置、大范围只读摸底），兼任 `claude-deepseek` 异常/限流时的跨引擎 Fallback |

## 与 `quant-team` 的职责边界

- **通用工程开发/重构/审查**：使用全局共享技能 `multi-agent-commander`（`C:\Users\jm\.agent-skills\skills\multi-agent-commander\`）配合本仓配置文件 [fleet.profile.json](../../.agents/fleet.profile.json)。
- **量化策略只读研究流程**：继续保留并使用本仓专用技能 [quant-team](../../.agents/skills/quant-team/SKILL.md)（`pnpm quant:team`），互不干扰。

## 本仓护栏与安全交接机制（`.agents/fleet.profile.json`）

- 运行产物与隔离目录统一落在 `.test-data/fleet/<runId>/`，自动注入隔离环境变量 `QUANT_DATA_DIR`；收尾用 `fleet clean --run <runId> --dry-run / --apply` 精确清理。
- `src/server/mcp.ts` 配置为 `protectedPaths`（其相关 UI 文案由任务归属与人工审阅把关），事前禁止写入任务声明归属，事后自动做 `git diff` 红线核验。
- 对本机 Claude Code CLI（`claude-deepseek`）强制剥离 `ANTHROPIC_MODEL`、拒绝 `--model`/`--effort` 覆写并直连 `claude.exe`，彻底避免 Windows `.ps1` 管道缓冲卡死。
- **确认终止后再交接（Safe Handoff）**：遇到瞬时网络断连、静默卡死（`STALLED`）或超时（`TIMEOUT`）触发重试或跨引擎 Fallback 时，调度器必先等待旧进程树彻底退出（Windows `taskkill /PID <pid> /T /F`）释放全部文件与隔离库句柄，再以按 `owns` 过滤后的部分改动清单作为交接上下文启动新尝试（或沿用已保存 `sessionId` 续跑），并在 `wave-summary.json` 中显式标注 `fallbackFrom` 与 `fallbackReason`。
