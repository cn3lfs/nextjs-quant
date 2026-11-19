# 观澜：半小时接手入口

当前入口与模块目录见下方。常规记录从创建起落在 `docs/<模块>/YYYY-MM-DD-<主题>.md`，结项后留在原模块，不再设历史归档树或全局逐文件索引。

2026-11-07新增：[本地财务使用与交付](data-sources/2026-11-07-local-financial.md)、[tstdx本地数据接口](../packages/tstdx/docs/api/local.md)、[客户端静态核对](data-sources/tdx-client-static-analysis.md)。通达信源格式/字段/IO统一归 `tstdx`；业务计算和档案留在应用与共享计算核心。

当前方向与交付以 [roadmap](roadmap.md) 和 [next-plan](next-plan.md) 为准。历史交接与阶段记录保留用于复现： [2026-11-15 开发交接](project/2026-11-15-handoff.md)、[2026-11-14 开发交接](project/2026-11-14-handoff.md)、[2026-11-07 开发交接](project/2026-11-07-handoff.md)；它们是当时的证据，不是接手必经路径。

观澜是自用的 Windows 本地量化工作台：读通达信与在线行情、看 K 线与指标、算缠论和双突破、按订阅推送提醒；公式选股、RPS、策略研究/回测、手工持仓与交易复盘构成日常主线。七大语义工作区为今日交易、行情看盘、选股筛选、策略回测、持仓复盘、资讯研报、系统设置。现有规则正确性证据不能证明策略赚钱，旧回测不能用作正式策略业绩，不自动交易。

## 阅读顺序（约 30 分钟）

1. 本页（2 分钟）：知道现在处在哪、下一步是什么。
2. [roadmap.md](roadmap.md)（3 分钟）：看范围、架构决策、当前范围与升级规则。
3. [architecture.md](architecture.md)（7 分钟）：按数据流找到模块职责、真实入口和依赖。
4. [invariants.md](invariants.md)（8 分钟）：先读不可违反的语义及对应测试，尤其未来函数、除权、通知和数据库隔离。
5. [conventions.md](conventions.md)（5 分钟）：动手前读开发规范——风格、命名、UI 用法、测试与提交要求。
6. [next-plan.md](next-plan.md)（3 分钟）：看当前阶段、真实依赖与剩余验证，复用已有能力。
7. [operations.md](operations.md)（4 分钟）：选择验证层级，识别目录、构建顺序及常见故障。
8. [decisions.md](decisions.md)（按当前任务检索 3 分钟）：了解理由、失败试验和后续修正，不需要第一次逐行读完。

做具体修改前还必须读根 [AGENTS.md](../AGENTS.md)；它与当前用户授权决定执行边界。人工确认与历史核对材料已按模块归入对应目录，当前待办见 [market-chart/review-todo.md](market-chart/review-todo.md)。

通达信五分钟导入：命令、单位和修复边界见[操作手册](wdz-import.md)，正式补齐与各阶段修复见[2026-11-05交付记录](data-sources/2026-11-05-tdx-import.md)，最终问题清单状态和估算边界见[看图成交量交付](data-sources/2026-11-05-tdx-visual-volume.md)（2026-11-06整理）。

## 当前状态（2026-11-19）

- **界面**：七大语义工作区完成重构与全站降噪；两档密度、统一词汇源、风险距离与月度热力图等可视化已落地。
- **工程**：Schema v20（`workspace_preferences`），服务端按域拆分 router、交易所适配器与研究工作流；桌面托盘常驻与鉴权优雅关机。
- **数据与策略**：本地通达信 + tstdx/东方财富/westock/同花顺 THSDK 可选源；公式选股、问财自然语言选股、双突破、原生缠论、多周期 RPS 与策略研究/回测可用，见 [THSDK 交付记录](data-sources/2026-11-19-thsdk-delivery.md)。
- **交易与提醒**：真实/纸面/模拟分账、交割单导入、现金对账、执行质量与复盘；统一提醒默认 shadow，显式开启 live 且启用订阅才投递。
- **数据边界**：历史证券池、公司行动、财务首次披露与可成交证据仍不完整；程序能算不代表已有盈利证据，相关限制在各模块文档与 [invariants](invariants.md) 保留。
- **模块整理**：模块地图与责任说明从 [docs/modules](modules/README.md) 进入。

## docs/ 入口

| 文档                               | 用途                   |
| ---------------------------------- | ---------------------- |
| [README.md](README.md)             | 接手入口与模块目录     |
| [roadmap.md](roadmap.md)           | 范围唯一事实源         |
| [architecture.md](architecture.md) | 模块职责、入口与依赖   |
| [modules/](modules/README.md)      | 模块说明与维护边界     |
| [invariants.md](invariants.md)     | 持续有效约束与测试映射 |
| [conventions.md](conventions.md)   | 开发规范               |
| [next-plan.md](next-plan.md)       | 当前实施与验收         |
| [operations.md](operations.md)     | 开发、测试、构建与故障 |
| [decisions.md](decisions.md)       | 决策与历史理由         |

## 模块记录目录

常规记录从创建起落在 `docs/<模块>/YYYY-MM-DD-<主题>.md`，结项后留在原模块；跨模块事项放 `docs/project/`。同日同模块同主题用 `-plan`、`-delivery`、`-review` 等语义后缀区分，不使用全局流水号。

| 模块             | 说明                                                                | 记录目录                                           |
| ---------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| 工作台与路由     | [workbench](modules/workbench.md)                                   | [workbench/](workbench/)                           |
| 共享 UI          | [shared-ui](modules/shared-ui.md)                                   | [shared-ui/](shared-ui/)                           |
| 行情与图表       | [market-chart](modules/market-chart.md)                             | [market-chart/](market-chart/)                     |
| 选股与 RPS       | [screening-rps](modules/screening-rps.md)                           | [screening-rps/](screening-rps/)                   |
| 策略与信号       | [strategy-signals](modules/strategy-signals.md)                     | [strategy-signals/](strategy-signals/)             |
| 研究与回测       | [research-backtest](modules/research-backtest.md)                   | [research-backtest/](research-backtest/)           |
| 组合与交易账本   | [portfolio-ledger](modules/portfolio-ledger.md)                     | [portfolio-ledger/](portfolio-ledger/)             |
| 新闻与 CLS       | [news-cls](modules/news-cls.md)                                     | [news-cls/](news-cls/)                             |
| 数据源适配       | [data-sources](modules/data-sources.md)                             | [data-sources/](data-sources/)                     |
| 持久化与基础设施 | [persistence-infrastructure](modules/persistence-infrastructure.md) | —                                                  |
| API 与后台运行时 | [api-runtime](modules/api-runtime.md)                               | —                                                  |
| 桌面与构建交付   | [desktop-build](modules/desktop-build.md)                           | [desktop-build/](desktop-build/)                   |
| 工程工具与验证   | [engineering-validation](modules/engineering-validation.md)         | [engineering-validation/](engineering-validation/) |
| 跨模块事项       | [modules/](modules/README.md)                                       | [project/](project/)                               |

仍待用户确认的图表核对事项见 [market-chart/review-todo.md](market-chart/review-todo.md)。

仓库外层还应知道：[根 README](../README.md) 保留启动、连接与全部免责声明；[THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md) 与 [vendor/czsc/README](../vendor/czsc/README.md) 说明依赖来源。未生成的 `strategy-scorecard.md` 是 N2 交付物，不是缺失文档。历史记录已按业务模块归位；旧 `docs/archive`、`docs/archive-index.md` 和旧路径不再保留，根目录只放现行入口与模块目录。

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
