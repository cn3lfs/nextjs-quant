# 观澜：半小时接手入口

观澜是自用的 Windows 本地量化工作台：读通达信行情、看 K 线与指标、算缠论和双突破、按订阅推送信号；信号台账、手工持仓和受限通达信公式服务这条主线。当前按 E0–E4 扩充浏览、RPS、选股与样本验证；现有规则正确性证据不能证明策略赚钱，旧回测不能用作正式策略业绩，不自动交易。

## 阅读顺序（约 30 分钟）

1. 本页（2 分钟）：知道现在处在哪、下一步是什么。
2. [roadmap.md](roadmap.md)（3 分钟）：看范围、架构决策、当前范围与升级规则。
3. [architecture.md](architecture.md)（7 分钟）：按数据流找到模块职责、真实入口和依赖。
4. [invariants.md](invariants.md)（8 分钟）：先读不可违反的语义及对应测试，尤其未来函数、除权、通知和数据库隔离。
5. [conventions.md](conventions.md)（5 分钟）：动手前读开发规范——风格、命名、UI 用法、测试与提交要求。
6. [next-plan.md](next-plan.md)（3 分钟）：看 E0–E4 的交付与验收，复用已有能力。
7. [operations.md](operations.md)（4 分钟）：选择验证层级，识别目录、构建顺序及常见故障。
8. [decisions.md](decisions.md)（按当前任务检索 3 分钟）：了解理由、失败试验和后续修正，不需要第一次逐行读完。

做具体修改前还必须读根 [AGENTS.md](../AGENTS.md)；它与当前用户授权决定执行边界。人工确认和历史证据从 [review/README.md](review/README.md) 进入。

## 当前状态（2026-09-11）

- **已交付**：M1–M5 的指标/图表/缠论/推送/双突破 A 层；N1 信号台账、N3 工作台收口、P2 分级、P1 账本、Q1 图表和 Q2a/Q2b 公式。
- **Q0 部分闭环**：买入 100 股成交已核实并在隔离本地账本对账；卖出被当日 T+1 可卖 0 拦住，完整往返尚未完成，不能重复买入。
- **E0–E4扩充**：规则修订、沪深/A500/行业概念浏览与六周期RPS、午尾盘预选、策略研究和财联社复盘已接入。日常操作见 [daily-workflow.md](daily-workflow.md)，阶段证据与数据边界见 [next-plan.md](next-plan.md)。
- **待确认**：通达信抽查、结构/图表/阈值/消息排版、真实渠道及 GPL 对外捆绑决定；普通用户盘中录入的当天交易日历证据来源仍待裁定。
- **交付边界**：现有核对材料不能证明用户已签收；本轮未更新打包exe或生产库。概念RPS新增迁移9，旧exe需另行授权重打包。程序能算不代表已有盈利证据，盘中行情覆盖、历史成分/交易条件及公司行动限制在使用说明中保留。

## docs/ 导航

| 文档/目录                                                                                      | 用途                                               |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [README.md](README.md)                                                                         | 接手入口与全目录导航                               |
| [roadmap.md](roadmap.md)                                                                       | 范围唯一事实源，含完成摘要而非旧验收任务           |
| [architecture.md](architecture.md)                                                             | 模块职责/入口/输入输出/依赖/不变量                 |
| [invariants.md](invariants.md)                                                                 | 持续有效约束与测试映射，含裁剪抢救的裁定           |
| [conventions.md](conventions.md)                                                               | 开发规范：风格、命名、UI、服务端、测试、注释、提交 |
| [next-plan.md](next-plan.md)                                                                   | E0–E4 扩充顺序与验收                               |
| [operations.md](operations.md)                                                                 | 开发、测试、构建、故障与目录维护                   |
| [decisions.md](decisions.md)                                                                   | 完整历史决策正文，旧结论按后续修订解释             |
| [archive-index.md](archive-index.md)                                                           | 中途计划、验收、审计和执行记录的日期归档索引       |
| [strategy-results-consolidated-2026-09-21.md](strategy-results-consolidated-2026-09-21.md) | 策略代表与已执行回测结果收口登记 |
| [strategy-consolidation-plan.md](strategy-consolidation-plan.md)                              | 策略独立包、server 分域重构与清理边界                       |
| [review/README.md](review/README.md)                                                           | 七份核对/实操文档和四组截图/证据的总索引           |
| [m4-message-samples.md](review/m4-message-samples.md)、[p2-message-samples.md](review/p2-message-samples.md) | 两个旧路径测试兼容副本；人工阅读使用 review 版     |
| [personal-quant-survey.md](personal-quant-survey.md)                                           | 外部调研：个人量化软件应有模块与本仓库差距对照     |

仓库外层还应知道：[根 README](../README.md) 保留启动、连接与全部免责声明；[THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md) 与 [vendor/czsc/README](../vendor/czsc/README.md) 说明依赖来源。未生成的 `strategy-scorecard.md` 是 N2 交付物，不是缺失文档。已删除 A–H、output、m2-review/n3-review 不再导航；现存中途记录统一见 [日期归档索引](archive-index.md)，不恢复已删除材料。

## 五分钟上手（依赖已预置）

```powershell
# 在仓库根打开 PowerShell；验证应用只能使用隔离目录
$env:QUANT_DATA_DIR = Join-Path $PWD '.test-data\first-look'
pnpm dev
```

打开 `http://127.0.0.1:3000` → “数据与连接”填写本机通达信目录 → “扫描本地数据” → 行情页选有覆盖的 A 股与周期。先检查数据日期；周/月缺日历、5 分钟文件过旧或缺失时明确不可用/留空属于边界，不自行补造数据。新机器先检查依赖与当前环境权限，新增依赖按任务需要说明用途与影响。

初次阅读无需配置通知或开启模拟盘。查看信号台账时先读“非策略业绩”和留空原因；接手开发按 operations 的分层验证。本次文档任务不需要实际启动服务、发送通知、交易或重新打包。

## 从任务接着做

先确认任务属于当前已授权范围 → 从 architecture 找入口与消费者 → 从 invariants 找保护测试 → 查 decisions 是否有被推翻的旧尝试 → 按 operations 验证。仅遇范围、架构、不可逆、许可问题升级；局部命名/边界不阻断交付。样本不足可展示明细与描述统计，不据此宣称策略有效。
