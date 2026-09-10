# 观澜：半小时接手入口

观澜是自用的 Windows 本地量化工作台：读通达信行情、看 K 线与指标、算缠论和双突破、按订阅推送信号；信号台账、手工持仓和受限通达信公式服务这条主线。它不是自建回测平台、全流派研究平台或实盘自动交易系统；现有规则正确性证据不能证明策略赚钱，旧回测不能用作正式策略业绩。

## 阅读顺序（约 30 分钟）

1. 本页（2 分钟）：知道现在处在哪、下一步是什么。
2. [roadmap.md](roadmap.md)（3 分钟）：看范围、架构决策、冻结清单与升级规则。
3. [architecture.md](architecture.md)（7 分钟）：按数据流找到模块职责、真实入口和依赖。
4. [invariants.md](invariants.md)（8 分钟）：先读不可违反的语义及对应测试，尤其未来函数、除权、通知和数据库隔离。
5. [conventions.md](conventions.md)（5 分钟）：动手前读开发规范——风格、命名、UI 用法、测试与提交要求。
5. [next-plan.md](next-plan.md)（3 分钟）：只看未开始的 N2/P3 前置与完整规格，别重做已完成阶段。
6. [operations.md](operations.md)（4 分钟）：选择验证层级，识别目录、构建顺序及常见故障。
7. [decisions.md](decisions.md)（按当前任务检索 3 分钟）：了解理由、失败试验和后续修正，不需要第一次逐行读完。

做具体修改前还必须读根 [AGENTS.md](../AGENTS.md)；它与当前用户授权决定执行边界。人工确认和历史证据从 [review/README.md](review/README.md) 进入。

## 当前状态（2026-09-10）

- **已交付**：M1–M5 的指标/图表/缠论/推送/双突破 A 层；N1 信号台账、N3 工作台收口、P2 分级、P1 账本、Q1 图表和 Q2a/Q2b 公式。
- **Q0 部分闭环**：买入 100 股成交已核实并在隔离本地账本对账；卖出被当日 T+1 可卖 0 拦住，完整往返尚未完成，不能重复买入。
- **下一步**：持续积累 N1 向前样本；样本约 20 个交易日后才考虑 P3，初步分布看起来有用时才启动 N2 聚宽双系统验证；两项均未开始。
- **待确认**：通达信抽查、结构/图表/阈值/消息排版、真实渠道及 GPL 对外捆绑决定；普通用户盘中录入的当天交易日历证据来源仍待裁定。
- **交付边界**：现有核对材料不能证明用户已签收；最新打包版是否已更新、本机当前库版本与样本量本次未核实。程序能算不代表已有盈利证据。

## docs/ 导航

| 文档/目录 | 用途 |
|---|---|
| [README.md](README.md) | 接手入口与全目录导航 |
| [roadmap.md](roadmap.md) | 范围唯一事实源，含完成摘要而非旧验收任务 |
| [architecture.md](architecture.md) | 模块职责/入口/输入输出/依赖/不变量 |
| [invariants.md](invariants.md) | 持续有效约束与测试映射，含裁剪抢救的裁定 |
| [conventions.md](conventions.md) | 开发规范：风格、命名、UI、服务端、测试、注释、提交 |
| [next-plan.md](next-plan.md) | 未开始的 N2、P3 及明确不做 |
| [operations.md](operations.md) | 开发、测试、构建、故障与目录维护 |
| [decisions.md](decisions.md) | 完整历史决策正文，旧结论按后续修订解释 |
| [review/README.md](review/README.md) | 七份核对/实操文档和四组截图/证据的总索引 |
| [m4-message-samples.md](m4-message-samples.md)、[p2-message-samples.md](p2-message-samples.md) | 两个旧路径测试兼容副本；人工阅读使用 review 版 |

仓库外层还应知道：[根 README](../README.md) 保留启动、连接与全部免责声明；[THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md) 与 [vendor/czsc/README](../vendor/czsc/README.md) 说明依赖来源。未生成的 `strategy-scorecard.md` 是 N2 交付物，不是缺失文档。已删除 A–H、output、m2-review/n3-review 不再导航，也不重建 archive。

## 五分钟上手（依赖已预置）

```powershell
# 在仓库根打开 PowerShell；验证应用只能使用隔离目录
$env:QUANT_DATA_DIR = Join-Path $PWD '.test-data\first-look'
pnpm dev
```

打开 `http://127.0.0.1:3000` → “数据与连接”填写本机通达信目录 → “扫描本地数据” → 行情页选有覆盖的 A 股与周期。先检查数据日期；周/月缺日历、5 分钟文件过旧或缺失时明确不可用/留空属于边界，不自行补造数据。新机器没有依赖时由管理者安装，执行者不得尝试 add/install。

初次阅读无需配置通知或开启模拟盘。查看信号台账时先读“非策略业绩”和留空原因；接手开发按 operations 的分层验证。本次文档任务不需要实际启动服务、发送通知、交易或重新打包。

## 从任务接着做

先确认任务属于未冻结且已授权范围 → 从 architecture 找入口与消费者 → 从 invariants 找保护测试 → 查 decisions 是否有被推翻的旧尝试 → 按 operations 验证。仅遇范围、架构、不可逆、许可问题升级；局部命名/边界不阻断交付。样本未成熟时不自行增加功能填空。
