# Repository guidance

## 范围与决策

- 最新任务决定交付范围。修改前读 `docs/roadmap.md` 与 `docs/next-plan.md` 的当前状态；历史计划提供背景与证据，不自动成为当前命令或审批依据。
- 项目是个人沪深量化工作台：行情与原生缠论图表、多周期 RPS、公式选股、双突破、策略研究/回测和交易复盘；其他市场保持现有能力，按实际需求演进。
- 局部命名、签名、边界自行决定。付费数据、不可逆操作、外发、真实交易、生产库与正式包变更按实际副作用取得授权；未获授权不妨碍继续可隔离的工作。
- 历史验证先明确数据时点、交易规则和指标口径。未经验证的旧回测只作规则自检，不作为可信策略业绩。

## 实现与验证

- 优先职责清晰的最优结构，不为旧接口保留兼容层。清理前确认目标归属，保留原始数据源、现行功能和测试所需输入。
- Windows-first；前后端 TypeScript，Electron 负责宿主和 bundled Node 服务。工程约定见 `docs/conventions.md`，正确性约束见 `docs/invariants.md`。
- 先打通一条可用的端到端路径，再扩展变体；依赖数据或外部能力时，先用最小代表样本核实来源、可用时点和关键字段。局部缺口只阻断依赖它的结论和操作。
- 优先验证会导致错误决策、资金损失或数据损坏的风险：未来数据、成交顺序、费用与单位、缺失语义、重复执行。公式用独立手算和关键边界例；测试从名称与断言可看出能发现什么真实错误。
- 按改动风险选择验证层级：开发期跑受影响的定向检查，集成交付点集中执行完整门禁；复用仍匹配的检查与构建结果，扩大验证时说明失效证据或新增的具体风险。
- 失败先区分产品、测试预期、输入数据和工具环境；定位后只复验受影响部分，不重复重试，不为得到全绿而改断言或放宽研究准入。
- 功能可用、关键风险已覆盖且有有效证据即可结束；非阻断问题登记后续。工程正确性、研究有效性与自然运行观察分别验收；策略亏损或样本不足不触发工程返工。
- 不假定代理具备网络、GPU 或显示权限；优先复用现有依赖，新增依赖说明理由和影响。

## 数据、交易与凭证

- 通达信和外部 Blocks 目录只读；新解析器需要固定 fixture 与非法输入测试。
- 数据来源、时间、证券池、复权模式明确，研究快照可复现，缺失不能补造。
- 可能打开数据库或执行迁移的开发/验证先设置隔离 `QUANT_DATA_DIR`，不打开默认生产库；不删库或降低 `user_version` 绕过版本检查。
- 校验 LLM 结构、证据和版本；不执行生成代码，不自动下单。
- 未经授权不真实下单、不外发通知或数据；真实测试消息需明确请求和目的地。
- 凭证使用仓库外 Windows DPAPI，不输出 API key、webhook、token 或认证信息。

## 协作与提交

- 多 Agent 工程协作按五角色路由（当前会话模型作指挥官统筹、Codex `gpt-6.2-astra`（`high`）复杂攻坚、Codex `gpt-6.2-sol`（`high`）专职 Review、本机 Claude Code `claude-deepseek` 默认模型与 Codex `gpt-6.2-sol`（`high`）双轨日常并行，默认降级仅在 GPT 与 Claude 间切换，`agy-gemini` 仅显式指定时启用），规范与统一调度器见全局技能 `multi-agent-commander` 及本仓 `.agents/fleet.profile.json`；量化研究只读团队的约定继续见 `.agents/skills/quant-team/SKILL.md`。
- 本仓库调用 Claude CLI 一律使用默认模型与默认思考强度：不传 `--model`、`--effort` 或 fallback model，不设置 `ANTHROPIC_MODEL`，不覆盖模型、思考强度与认证配置；权限显式指定 `--permission-mode bypassPermissions`，不另加或替换其他权限参数。
- 派单写明文件归属、输入、验收和行为边界，复核深度按风险确定；协调保持简短，只报新结果或阻断。
- 开始前检查 git 状态，保留用户和其他任务的修改，不因无关 diff 回退、暂存或覆盖。撤销不明来源改动前核对修改时间、进程和归属。
- 提交、推送、发布各需对应授权；未授权提交不妨碍继续可隔离的工作。
- `src/server/mcp.ts` 及其 UI 文案由用户维护，未经明确交接不修改、不回退、不纳入提交。

## 文档与日志

- 常规记录落在 `docs/<模块>/YYYY-MM-DD-<主题>.md`，一次命名、长期留在原位；模块名沿用 [模块地图](docs/modules/README.md)，跨模块事项放 `docs/project/`。
- 同日同模块同主题用语义后缀（`-plan`、`-delivery`、`-review`）区分；结项不搬家、不按批次统一迁移。
- 本机运行日志用同一模块日期主题原则：`.codex-runs/<模块>/YYYY-MM-DD-<主题>.log`；不打印日志内容、不提交本机日志。
- 保留长期入口（README、roadmap、next-plan、architecture、conventions、invariants、operations、decisions）、机器读写契约和源快照。纯文档调整不跑全量构建；新增或迁移记录时检查模块归属、同名冲突和相对链接。

## 临时文件与收尾

- 创建临时文件前先复用已有能力；本任务脚本、日志与隔离数据集中在一个可识别的任务目录，不在仓库根或同级不断新建副本。
- 清理前核对绝对路径、目录联接、运行进程与保留项；只清理归属明确且已授权的任务产物，不动正式包、主工作区依赖、用户业务数据库、原始数据源、当前使用的输入快照、凭证或其他任务修改。
- 批量或不可逆删除可先给出默认预演、明确目标与保留项的清单；用户指定手动执行时照办。已拒绝的操作不能换执行者重试。
- 交付核对后清理本任务的一次性构建目录、检查脚本和中间产物；报告已清理项与确需保留项，未获删除授权或清理失败时说明具体目标和原因。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
