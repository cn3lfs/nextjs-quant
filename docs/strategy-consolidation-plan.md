# 交易策略与服务端分域整理计划

日期：2026-09-21；重构执行更新：2026-09-22
范围：九方向代表目录及应用接入、`src/server` 按职责分域；原有回测摘要与清理历史保留
目标：保留每个大方向一个代表性策略，形成独立 package，并回收无法直接支撑结论的中间文件

## 1. 收口原则

1. “代表性”按方法方向和可解释性选取，不按收益挑最好的一档。
2. 原始方法表、源代码和受保护快照继续保留，package 只暴露代表策略目录。
3. 已完成、部分完成、未开始、数据覆盖缺口分开登记。
4. 零信号、样本不足、有效池为 0 都只记录为当前输入下的计算事实，不登记为策略无效。
5. `entryMaxWait=3/5/10` 是不同实验条件；不把三档成交数相加，也不把某一档登记为“最优”。
6. package 不依赖 `.codex-runs` 运行；回测路径和 hash 只作为证据索引，不把中间产物打包。

## 2. 代表策略边界

| 方向 | 唯一代表 | 结果状态 |
| --- | --- | --- |
| 双突破 | `SW01 / sw-double-prior20` | B3 完成归档，样本不足 |
| 技术指标共振 | `SW11-confluence-count / sw-confluence` | B3 完成归档，样本不足 |
| 量价 | `VP-vp-up-expanded-confirm / vp-up-expanded-confirm` | B3 完成归档，样本不足 |
| Wyckoff | `WY02 / wy-sos-daily` | B4 部分归档，当前无事件 |
| 缠论 | `CH03 / chan-third-native` | B4 部分归档，czsc 基线未独立验证 |
| 成长股 | `CA-B-N2 / canslim-high-98` | 已实现，未真实回测 |
| 价值 | `FA08` | 工程版本，S7 未开始 |
| 情绪 | `MS04` | 工程版本，S7 未开始 |
| 产业链 | `IC04` | 工程版本，S7 未开始 |

重复 preset ID 不作为独立 package 标识；入口采用稳定 package ID，并同时记录 source method ID 和 preset ID。

## 3. 清理策略

### 保留

- `packages/trading-strategies` 的目录、类型、测试和 README。
- `docs/strategy-results-consolidated-2026-09-21.md` 的结果登记。
- `docs/trading-skills-method-map.json`、源代码、测试和受保护的 source snapshots。
- B3/B3-w5/B3-w10 的 `records.json`、`summary.json`，用于保留批次级结果摘要。
- 每个已执行代表策略的 raw 文件：B3 三个、B4 两个。
- S5 的 canonical/refreeze 快照；它是数据研究输入，不是回测中间产物。

### 删除

- B3/B3-w5/B3-w10 的全量 raw 和日线数据集缓存，只保留代表 raw 与批次 summary/records。
- B4 的非代表 raw、shard/ledger、smoke/staging 归档和数据集缓存。
- B5 的全量五分钟 raw 与分钟数据集；只保留已有批次 summary/records，因为 B5 不是 package 代表策略的单独目录。
- 已标记 stale、失败、重复运行的回测目录。

删除前检查：无回测进程正在写入目标；逐路径计算字节数；删除后重新计算并将实际结果登记。恢复依赖 Git/系统回收站之外的备份时，报告明确写“未建立独立备份”。

## 4. 验收

- package：独立 `test`、`typecheck`、`build` 通过；测试确认每个 family 只有一个代表且未回测项没有 evidence。
- 文档：只保留关键文档在 `docs` 根目录；新增报告不生成中转指针。
- 清理：删除范围内无目标文件残留；保留代表 raw 可逐个 `JSON.parse`；受保护路径无差异。
- Git：本轮不自动提交、不推送；若后续授权提交，package、文档和清理登记作为同一可审查变更提交。

## 5. 后续重构阶段（2026-09-22）

本轮接续已有 package，不重新创建目录，不重新执行已登记的清理。当前交付先明确以下阶段；阶段完成以实际检查为准，历史通过记录不代替本轮验证。

### 5.1 实施前代码核对（基线）

- `packages/trading-strategies/src/catalog.ts` 已有 9 个代表、6 个 preset 引用、5 份历史证据；价值、情绪、产业链仅登记 method ID。
- 现有字段为 `representativeMethodId` / `representativePreset`，语义已区分；指标共振 notes 中的 `sourceMethodIds` 不存在，需要纠正。
- `StrategyRepresentative` 目前允许 readiness 与 evidence 任意组合；运行测试只检查当前常量，类型还不能阻止后续误登记。
- `hasOneRepresentativePerFamily` 只检查 family 不重复，不能单独证明九个方向齐全；当前测试额外检查长度，但未核对确切 family 集合。
- 根 `package.json` 尚未依赖 `trading-strategies`；根测试分类器只枚举 `tests/`，独立 package 的测试必须显式运行。当前独立包完成不等于应用已经接入。
- 本次未复核历史 raw/hash 或清理字节数；这些仍是 [2026-09-21 结果登记](strategy-results-consolidated-2026-09-21.md) 的历史记录。

### 5.2 职责与标识

| 层 | 负责 | 不承担 |
| --- | --- | --- |
| 独立 package | 九方向代表、稳定 ID、method/preset 引用、历史证据元数据 | 文件读取、数据库、指标计算、DLL、撮合 |
| 方法表与既有实现 | 全量方法来源、实现状态、参数预设和执行算法 | 以代表目录替代全部研究方法 |
| 工作台适配层 | 将代表条目解析到已有研究入口，明确无法执行的原因 | 把 method ID 当 preset ID 传入执行器 |
| 结果登记 | 历史批次事实、缺口、清理记录和验证说明 | 从零信号或样本不足推出策略优劣 |

`id` 是 package 代表标识；`methodId` 表示研究方法；`presetId` 表示具体参数预设。一个 preset 可能被多个方法引用，因此不得仅按 preset 推断方法归属。没有 preset 的条目保留缺失，不复制 method ID 补齐。CANSLIM 代表仍只表示 98% 高点入口，不扩称完整 CANSLIM。

### 5.3 分阶段交付

| 阶段 | 具体变更 | 验收与停止点 |
| --- | --- | --- |
| C1 目录契约 | 将公开引用字段统一为 `methodId` / 可选 `presetId`；同步包内测试和 README；修正文案；用联合类型约束未回测条目无 evidence、已观察条目有匹配 readiness 的 evidence；精确核对九方向 | 独立 package test/typecheck/build；验证合法目录和错误组合拒绝，保留全部证据数值与 hash；到此不接执行器 |
| C2 来源对应 | 在根 `tests/` 增加目录与 method-map 的只读一致性检查；按方法核对 preset 归属及实现路径；覆盖缺方法、错误归属、无 preset 三种边界 | package 检查、根 typecheck 与 `pnpm test`；不读取 ignored raw，不下载数据，不导入会启动服务的模块 |
| C3 应用只读接入 | 核实研究入口后添加 workspace 依赖和构建顺序；代表目录仅作研究导航与状态展示，执行仍委托原实现；无 preset 不显示可直接执行的动作 | 相关 UI/路由测试、根 typecheck/test/build；检查九方向、缺数据说明和未回测标记，按环境完成浏览器交互验证 |
| C4 收尾 | 清除本轮接入后确已重复的代表目录或文案，补充交付状态 | 对照调用点和 diff，无悬空引用；不删除全量方法、算法、测试、source snapshots 或剩余 raw |

C1 的字段统一是 package 0.1.0 接口变更，实施前再次搜索消费者。当前仓库没有应用接入，不为未发现的外部消费者预建双字段兼容层；发现消费者则在同阶段同步修改。证据类型收紧必须保留 B4 的 raw-only 与未完整批次语义，不能要求它具备 B3 分区统计。

C2 核对“方法存在与 preset 归属”，不能把 method-map 的工程版本状态解释成方法已通过真实历史验证。应用接入位置与 UI 具体方案在 C3 前核实；不提前承诺整套研究页面仅剩九个入口，也不触及用户维护的 `src/server/mcp.ts` 及其 UI 文案。

### 5.4 验证和交付纪律

- 每阶段登记实际运行的命令、退出状态与测试数；失败单列原因，修复后再进入下一阶段。
- C1 至少运行 `pnpm --filter trading-strategies test`、`typecheck`、`build`；代码子任务同时按仓库要求执行根 `pnpm test` 和相关 typecheck，不把独立包测试等同于全仓验证。
- 可能打开应用或数据库的检查先设置独立 `QUANT_DATA_DIR`，记录临时目录清理方式；不连接默认生产库。
- 应用接入时核对 package 的 dist 在干净构建中先生成；涉及 runtime 则重建 worker，桌面交付才执行 `pnpm desktop:prepare`。本计划不授权打包、提交、推送或发布。
- 纯计划更新只检查内容、链接与 diff。不新建中转指针、结果镜像或一次性验证档案库。
- 本轮不启动 B2/B4 补跑、S7 真实回测或新的产物删除；数据源替换和复权口径分歧继续单独裁定。

### 5.5 当前进度

2026-09-22：用户随后明确授权“执行 plan”。C1—C4 已完成：契约与来源检查、研究页面接入和最终验收均已交付；实际阶段记录见 §8。

## 6. `src/server` 按职责整理（2026-09-22 追加）

用户追加范围：服务端代码也纳入本次重构计划，按策略、数据源、回测等职责分门别类，避免继续堆在一个目录。**用户已授权执行 C/S 两组计划；按批次验证推进，不提交、推送或打包。**

### 6.1 实施前现状（基线）

- `src/server` 根目录现有 308 个文件，仅有 `api/`、`db/`、`data/` 三个直接子目录；`data/` 当前存放 `exchange-delisted.json`，不是已有的数据源适配层。
- `research-run.ts` 同时编排多个方法方向；`market-data.ts` 同时涉及行情、财务查询与研究证据。此类文件先明确职责边界，不能凭 `research-` / `market-` 前缀整体搬家后就宣称分层完成。
- `canslim-finance.ts` 是策略所需财务事实转换，`hithink-*` 是供应商相关适配；“使用财务数据”不意味着都归数据源目录。`backtest-source.ts` 负责回测快照选择与一致性核对，属于回测输入编排，底层读取仍委托数据源。
- `scripts/build-runtime.mjs` 显式引用多个 `src/server/*worker.ts`、`workflow-runner.ts`、`westock-preload.ts` 入口。只改 TypeScript import 会遗漏构建接线。
- `mcp.ts` 直接引用根目录 `connection-pool.ts`、`mcp-session.ts`、`mcp-health.ts`、`vault.ts`。当前禁止修改 `mcp.ts`，这些路径也先保留，不能靠搬迁依赖迫使修改受保护文件。

### 6.2 目标目录与归属规则

以下为目标职责及候选归属，不是未经核对的批量移动清单。实施 S0 时逐文件确认；只创建有实际模块承接的目录，不预建空目录或每文件一层目录。

| 目标目录 | 职责与现有候选 | 边界 |
| --- | --- | --- |
| `strategies/` | 策略服务、方法输入组装及解释；按实际规模分 `breakout/`、`canslim/`、`wyckoff/`、`chan/`、`value/`、`sentiment/`、`industry-chain/` 等 | 九方向代表不要求机械创建九个目录；服务端所有已实现方法继续保留；纯计算仍复用 `src/lib` |
| `data-sources/` | 按供应商分 `tdx/`、`tstdx/`、`westock/`、`eastmoney/`、`hithink/` 等；承接适配器、协议与源数据读取 | 供应商事实转换归这里，策略专用打分/解释归策略层；通达信与 Blocks 始终只读 |
| `market/` | 来源无关的证券身份、生命周期、证券池、日历及行情统一访问；候选 `securities`、`security-*`、`market-pool-*`、周期聚合 | 复用 data-sources；研究证据和回测调度不进入此层 |
| `backtest/` | 回测快照、执行编排、组合、结果、walk-forward；候选 `backtest-*`、`signal-backtest*`、`research-run`、`research-portfolio`、`research-outcomes`、`walk-forward*` | 不复制 `src/lib` 的撮合与统计；策略专属输入准备归 strategies，共享快照冻结按责任归 backtest 或 research |
| `research/` | 研究生命周期、样本治理、证据、历史与使用审计；候选 `research-governance`、`research-history`、`research-usage`、`research-protection` | 与回测计算分开；`research-*` 不一律归此处，混合 store/服务逐个核实 |
| `screening/` | RPS、公式筛选、筛选缓存与结果；候选 `rps-*`、`formula-screen*`、`screen-*` | 负责筛选流程，不承接供应商协议或持仓回测 |
| `monitoring/` | 盘中监控、信号台账与运行编排；候选 `monitor-*`、`intraday-*`、`signal-ledger-*` | `intraday-data` 等供应商读取部分需核对后划出；台账观察不等同成交事实 |
| `portfolio/` | 持仓、手工成交、账户复盘、现金/红利对账与执行质量；候选 `trade-*`、`delivery-*`、`dividend-*`、`execution-quality-service` | 实际账户与假设回测分开；模拟交易单列子域，保持显式操作限制 |
| `news/` | 新闻采集后的候选、主题、复盘和调度；候选 `cls-*`、`news-*` | 通用供应商访问归 data-sources；情绪/产业链策略逻辑归 strategies |
| `charts/` | 图表历史、在线补齐、视图存储；候选 `chart-*`、`online-chart-data`、`preferred-online-chart` | 通用周期聚合归 market，图表逻辑不得复制指标算法 |
| `jobs/` | 通用任务记录、租约与工作流调度；候选 `jobs`、`task-history`、`workflow-*` | 策略/回测/RPS 专用 worker 跟随所属业务域，不集中成另一个 worker 大目录 |
| `infra/` | 运行环境、并发控制、LLM/通知等明确命名的基础设施子模块 | 不创建 `common/`、`utils/` 接收难分类业务；受保护 MCP 依赖暂不迁移 |
| `api/`、`db/`、`data/` | 保留既有路由、共享持久化底座与静态资产职责 | 业务 store 随业务域，schema/migrations 继续在 db；本次不修改数据库结构 |

根目录最终仅保留必要组合入口和明确的受保护路径例外；每个保留文件都要有理由。`quant.ts`、`research.ts`、`market-data.ts` 等聚合模块先核对导出与消费者，不能简单改名或换目录来掩盖混合职责。

依赖目标：API/任务入口 → 业务服务（策略、回测、研究等）→ market/data-sources 与共享基础设施。底层数据源不反向依赖策略或回测编排；发现现有反向引用先登记，通过移动最小共享职责或显式传参解除，不新增万能服务容器。`packages/trading-strategies` 保持纯目录和元数据，不反向 import `src/server`。

### 6.3 分批迁移与 C 阶段衔接

| 阶段 | 工作 | 验收与停止点 |
| --- | --- | --- |
| S0 清点与路径表 | 对当时全部 server 文件记录旧路径、目标路径、职责、消费者和保留理由；核对静态/动态 import、文件路径字符串、worker、测试、文档及方法表路径；识别跨域循环 | 每个文件有归属；混合职责及受保护依赖明确；在本计划维护分组映射，不新建中转文档 |
| S1 数据层 | 先按独立供应商逐批迁入 data-sources，再整理来源无关 market；`market-data.ts` 先拆出已确认的数据访问职责 | 每批行为和返回结构一致，源路径只读，缺失/时点/复权口径不变；不切换数据源 |
| S2 策略层 | 按双突破、CANSLIM、威科夫、缠论及其他实际方向逐批迁入 strategies；仅为解除混合职责作必要拆分 | 方法/preset 与执行映射不变；复用 lib 和 DLL；方法表实现路径、测试与文档同步 |
| S3 回测与研究层 | 分开 backtest 与 research；迁移执行器、结果存储和治理模块，核对 worker 与 runtime 构建入口 | 同输入固定用例结果、hash 语义、取消/进度/错误传播和历史读取保持；不重跑真实回测作为搬迁验收 |
| S4 其他业务域 | 逐批整理 screening、monitoring、portfolio、news、charts、jobs 和 infra | 每域单独检查，保持账户/研究、信号/成交及通知边界；不把剩余文件一股脑塞进 infra |
| S5 收尾 | 核对根目录保留名单，清除本轮不再使用的旧入口，检查反向依赖与悬空路径 | 无双份实现、无未说明的根目录业务文件；不以目录数量或减少文件数代替正确性验收 |

建议顺序：C1 → C2 → S0 → S1 → S2 → S3 → S4 → C3 → C4/S5。先稳定契约与服务端路径，再做应用目录接入，减少重复改 import。每个 S 阶段可按供应商或业务域拆成更小交付，不做一次性全仓搬迁；代码实施授权后每批验收通过再继续。

### 6.4 搬迁与验收约束

1. 优先保留文件名和导出签名，先迁路径再处理必要职责拆分；不同时更换算法、参数、状态值、存储格式或数据来源。不建立永久根目录 re-export 镜像，过渡入口必须说明消费者与移除条件。
2. 同批更新所有实际消费者：应用、脚本、测试、动态加载、runtime entryPoints、资源相对路径、方法表的实现/测试路径和有效文档。来源锁与受保护快照不是路径修复目标，不改写历史证据。
3. 每批运行相关 Vitest、`pnpm typecheck` 与 `pnpm test`；有意义的应用交付运行 `pnpm build`，worker 迁移必须验证重建及受控启动。桌面交付再运行 `pnpm desktop:prepare`，不自动打包或替换 release。
4. 变更前留存相关固定输入基线，变更后比较结构与数值；结果不应因文件路径进入哈希而改变时需显式核对，真实来源版本证据则如实记录。结构护栏更新需补精确断言，不删除测试绕过失败。
5. 根入口/别名编译通过不足以证明 runtime 正常；额外检查 worker 产物名称、加载位置、DLL 路径、JSON 静态资产与 Next 服务端边界。编写相关代码前阅读本地 Next 指南。
6. 检查和启动均使用隔离 `QUANT_DATA_DIR`；外部消息、交易、付费取数不属于重构验收。产物清理仅限本轮创建的隔离临时目录，记录创建者、清理时机及失败处理。
7. `src/server/mcp.ts` 及其 UI 文案不修改；其直接依赖现有路径暂保留为显式例外。其他域可继续整理，不为目录整齐越过用户维护边界。

### 6.5 当前状态

S0—S5 已完成，原 308 个根文件迁移 302 个，根保留 6 个有明确理由的文件。各阶段类型与全量测试通过，worker 已重建并验证，最终应用验收与收尾见 §8。

## 7. S0 逐文件迁移映射（执行基线）

覆盖原根目录 308 个文件；现有 api/db/data 保留。旧文件名均相对原 `src/server/`，消费者数量为迁移前源码字面量引用清点（含测试/脚本），不是运行调用次数。每行目标目录即职责归属，默认保留文件名；`market-data.ts` 的证据组装部分改名为 `gather-evidence.ts`。新增拆分模块另列于表后。静态清点不能证明动态路径完整，后续以类型、构建和测试联合核验。

### `src/lib/strategy-facts/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `canslim-earnings.ts` | 3 | 迁移；同批更新消费者 |
| `canslim-finance.ts` | 3 | 迁移；同批更新消费者 |
| `canslim-float.ts` | 2 | 迁移；同批更新消费者 |
| `canslim-institutions.ts` | 3 | 迁移；同批更新消费者 |
| `canslim-sector-rank.ts` | 2 | 迁移；同批更新消费者 |
| `sepa-finance.ts` | 2 | 迁移；同批更新消费者 |

### `src/server/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `connection-pool.ts` | 4 | 保留：用户维护 MCP 及直接依赖 |
| `mcp-health.ts` | 4 | 保留：用户维护 MCP 及直接依赖 |
| `mcp-session.ts` | 2 | 保留：用户维护 MCP 及直接依赖 |
| `mcp.ts` | 6 | 保留：用户维护 MCP 及直接依赖 |
| `runtime.ts` | 7 | 保留：应用组合入口 |
| `vault.ts` | 10 | 保留：用户维护 MCP 及直接依赖 |

### `src/server/backtest/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `backtest-actions.ts` | 17 | 迁移；同批更新消费者 |
| `backtest-source.ts` | 2 | 迁移；同批更新消费者 |
| `bonus-adjusted-signals.ts` | 5 | 迁移；同批更新消费者 |
| `cash-adjusted-signals.ts` | 3 | 迁移；同批更新消费者 |
| `cash-dividend-job.ts` | 2 | 迁移；同批更新消费者 |
| `cash-dividend-plan.ts` | 3 | 迁移；同批更新消费者 |
| `cash-dividend-window.ts` | 2 | 迁移；同批更新消费者 |
| `dividend-ledger.ts` | 3 | 迁移；同批更新消费者 |
| `dividend-reconciliation.ts` | 7 | 迁移；同批更新消费者 |
| `quant.ts` | 21 | 迁移；同批更新消费者 |
| `research-adjustment-coverage.ts` | 1 | 迁移；同批更新消费者 |
| `research-client.ts` | 1 | 迁移；同批更新消费者 |
| `research-dataset.ts` | 51 | 迁移；同批更新消费者 |
| `research-json.ts` | 3 | 迁移；同批更新消费者 |
| `research-outcomes.ts` | 2 | 迁移；同批更新消费者 |
| `research-portfolio.ts` | 75 | 迁移；同批更新消费者 |
| `research-run.ts` | 47 | 迁移；同批更新消费者 |
| `research-store.ts` | 25 | 迁移；同批更新消费者 |
| `research-worker.ts` | 1 | 迁移；同批更新消费者 |
| `signal-backtest-benchmark.ts` | 1 | 迁移；同批更新消费者 |
| `signal-backtest.ts` | 2 | 迁移；同批更新消费者 |
| `walk-forward-explanation.ts` | 2 | 迁移；同批更新消费者 |
| `walk-forward-job.ts` | 2 | 迁移；同批更新消费者 |
| `walk-forward.ts` | 6 | 迁移；同批更新消费者 |

### `src/server/charts/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `chart-bars.ts` | 4 | 迁移；同批更新消费者 |
| `chart-view-store.ts` | 3 | 迁移；同批更新消费者 |
| `online-chart-data.ts` | 2 | 迁移；同批更新消费者 |

### `src/server/data-sources/cls/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `cls-news.ts` | 9 | 迁移；同批更新消费者 |

### `src/server/data-sources/eastmoney/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `eastmoney-adapter.ts` | 4 | 迁移；同批更新消费者 |
| `eastmoney-bars.ts` | 2 | 迁移；同批更新消费者 |

### `src/server/data-sources/gf/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `gf-calendar.ts` | 5 | 迁移；同批更新消费者 |
| `gf-windmill.ts` | 3 | 迁移；同批更新消费者 |

### `src/server/data-sources/hithink/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `hithink-business.ts` | 5 | 迁移；同批更新消费者 |
| `hithink-capital-events.ts` | 4 | 迁移；同批更新消费者 |
| `hithink-columns.ts` | 11 | 迁移；同批更新消费者 |
| `hithink-context.ts` | 28 | 迁移；同批更新消费者 |
| `hithink-dividends.ts` | 7 | 迁移；同批更新消费者 |
| `hithink-finance.ts` | 12 | 迁移；同批更新消费者 |
| `hithink-float.ts` | 3 | 迁移；同批更新消费者 |
| `hithink-forecast.ts` | 4 | 迁移；同批更新消费者 |
| `hithink-income-scope.ts` | 4 | 迁移；同批更新消费者 |
| `hithink-institutions.ts` | 2 | 迁移；同批更新消费者 |
| `hithink-macro.ts` | 4 | 迁移；同批更新消费者 |
| `hithink-ownership.ts` | 4 | 迁移；同批更新消费者 |
| `hithink-rs.ts` | 5 | 迁移；同批更新消费者 |
| `hithink-sector-rank.ts` | 2 | 迁移；同批更新消费者 |
| `hithink-solvency.ts` | 4 | 迁移；同批更新消费者 |

### `src/server/data-sources/mx/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `mx-data.ts` | 3 | 迁移；同批更新消费者 |

### `src/server/data-sources/sse/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `sse-margin.ts` | 3 | 迁移；同批更新消费者 |

### `src/server/data-sources/tdx/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `tail-cache-codec.ts` | 2 | 迁移；同批更新消费者 |
| `tdx-benchmark.ts` | 3 | 迁移；同批更新消费者 |
| `tdx-code-changes.ts` | 3 | 迁移；同批更新消费者 |
| `tdx-daily-cache.ts` | 13 | 迁移；同批更新消费者 |
| `tdx-daily-increment.ts` | 2 | 迁移；同批更新消费者 |
| `tdx-daily-overlay.ts` | 6 | 迁移；同批更新消费者 |
| `tdx-data-baseline.ts` | 1 | 迁移；同批更新消费者 |
| `tdx-financial-reports.ts` | 2 | 迁移；同批更新消费者 |
| `tdx-full-day-cache.ts` | 9 | 迁移；同批更新消费者 |
| `tdx-full-day-import.ts` | 3 | 迁移；同批更新消费者 |
| `tdx-gbbq-key.ts` | 1 | 迁移；同批更新消费者 |
| `tdx-gbbq.ts` | 17 | 迁移；同批更新消费者 |
| `tdx-increment-download.ts` | 2 | 迁移；同批更新消费者 |
| `tdx-increment-job.ts` | 4 | 迁移；同批更新消费者 |
| `tdx-increment-refresh.ts` | 3 | 迁移；同批更新消费者 |
| `tdx-local-blocks.ts` | 5 | 迁移；同批更新消费者 |
| `tdx-local-names.ts` | 2 | 迁移；同批更新消费者 |
| `tdx-mcp-disabled.ts` | 9 | 迁移；同批更新消费者 |
| `tdx-quotes.ts` | 12 | 迁移；同批更新消费者 |
| `tdx-wire.ts` | 13 | 迁移；同批更新消费者 |
| `tdx.ts` | 72 | 迁移；同批更新消费者 |
| `vipdoc-adapter.ts` | 3 | 迁移；同批更新消费者 |

### `src/server/data-sources/tencent/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `tencent-identity.ts` | 2 | 迁移；同批更新消费者 |
| `tencent-sector-prices.ts` | 3 | 迁移；同批更新消费者 |

### `src/server/data-sources/tstdx/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `tstdx-adapter.ts` | 3 | 迁移；同批更新消费者 |

### `src/server/data-sources/westock/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `westock-adapter.ts` | 6 | 迁移；同批更新消费者 |
| `westock-bars.ts` | 2 | 迁移；同批更新消费者 |
| `westock-data.ts` | 5 | 迁移；同批更新消费者 |
| `westock-preload.ts` | 1 | 迁移；同批更新消费者 |
| `westock-unadjusted.ts` | 2 | 迁移；同批更新消费者 |

### `src/server/infra/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `access.ts` | 2 | 迁移；同批更新消费者 |
| `delivery-authorization.ts` | 1 | 迁移；同批更新消费者 |
| `evidence.ts` | 36 | 迁移；同批更新消费者 |
| `keyed-slots.ts` | 2 | 迁移；同批更新消费者 |
| `lease.ts` | 4 | 迁移；同批更新消费者 |
| `local-llm.ts` | 6 | 迁移；同批更新消费者 |
| `notification-policy-store.ts` | 5 | 迁移；同批更新消费者 |
| `notifications.ts` | 7 | 迁移；同批更新消费者 |
| `priority-slots.ts` | 4 | 迁移；同批更新消费者 |
| `settings.ts` | 52 | 迁移；同批更新消费者 |
| `shared-read.ts` | 31 | 迁移；同批更新消费者 |

### `src/server/jobs/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `close-increment-workflow.ts` | 2 | 迁移；同批更新消费者 |
| `close-workflow-followups.ts` | 2 | 迁移；同批更新消费者 |
| `job-summaries.ts` | 2 | 迁移；同批更新消费者 |
| `jobs.ts` | 26 | 迁移；同批更新消费者 |
| `task-history.ts` | 7 | 迁移；同批更新消费者 |
| `worker.ts` | 3 | 迁移；同批更新消费者 |
| `workflow-lease.ts` | 5 | 迁移；同批更新消费者 |
| `workflow-quotes.ts` | 2 | 迁移；同批更新消费者 |
| `workflow-runner.ts` | 1 | 迁移；同批更新消费者 |
| `workflow-scheduler.ts` | 3 | 迁移；同批更新消费者 |

### `src/server/market/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `chart-aggregation.ts` | 3 | 迁移；同批更新消费者 |
| `chart-history.ts` | 6 | 迁移；同批更新消费者 |
| `chart-online-delta.ts` | 2 | 迁移；同批更新消费者 |
| `data-health.ts` | 29 | 迁移；同批更新消费者 |
| `exchange-security-names.ts` | 4 | 迁移；同批更新消费者 |
| `free-chart-sources.ts` | 7 | 迁移；同批更新消费者 |
| `hourly-bars.ts` | 4 | 迁移；同批更新消费者 |
| `index-directory.ts` | 2 | 迁移；同批更新消费者 |
| `industry-blocks.ts` | 7 | 迁移；同批更新消费者 |
| `local-daily-snapshot.ts` | 8 | 迁移；同批更新消费者 |
| `market-pool-files.ts` | 13 | 迁移；同批更新消费者 |
| `market-pool-service.ts` | 2 | 迁移；同批更新消费者 |
| `monthly-bars.ts` | 2 | 迁移；同批更新消费者 |
| `pool-context.ts` | 3 | 迁移；同批更新消费者 |
| `preferred-online-chart.ts` | 4 | 迁移；同批更新消费者 |
| `sector-price-metrics.ts` | 4 | 迁移；同批更新消费者 |
| `securities.ts` | 17 | 迁移；同批更新消费者 |
| `security-identity.ts` | 2 | 迁移；同批更新消费者 |
| `security-lifecycle.ts` | 5 | 迁移；同批更新消费者 |
| `security-search.ts` | 2 | 迁移；同批更新消费者 |
| `security-trading-status.ts` | 6 | 迁移；同批更新消费者 |
| `weekly-bars.ts` | 4 | 迁移；同批更新消费者 |

### `src/server/monitoring/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `intraday-client.ts` | 2 | 迁移；同批更新消费者 |
| `intraday-data.ts` | 3 | 迁移；同批更新消费者 |
| `intraday-job.ts` | 3 | 迁移；同批更新消费者 |
| `intraday-service.ts` | 5 | 迁移；同批更新消费者 |
| `intraday-store.ts` | 8 | 迁移；同批更新消费者 |
| `intraday-strategy.ts` | 4 | 迁移；同批更新消费者 |
| `intraday-worker.ts` | 2 | 迁移；同批更新消费者 |
| `monitor-calendar.ts` | 7 | 迁移；同批更新消费者 |
| `monitor-run.ts` | 1 | 迁移；同批更新消费者 |
| `monitor-strategy.ts` | 2 | 迁移；同批更新消费者 |
| `signal-ledger-client.ts` | 3 | 迁移；同批更新消费者 |
| `signal-ledger-engine.ts` | 5 | 迁移；同批更新消费者 |
| `signal-ledger-job.ts` | 3 | 迁移；同批更新消费者 |
| `signal-ledger-store.ts` | 12 | 迁移；同批更新消费者 |
| `signal-ledger-worker.ts` | 2 | 迁移；同批更新消费者 |

### `src/server/news/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `cls-candidates.ts` | 2 | 迁移；同批更新消费者 |
| `cls-news-workflow.ts` | 2 | 迁移；同批更新消费者 |
| `cls-outcomes.ts` | 3 | 迁移；同批更新消费者 |
| `cls-report-files.ts` | 8 | 迁移；同批更新消费者 |
| `cls-report-parser.ts` | 8 | 迁移；同批更新消费者 |
| `cls-review-scheduler.ts` | 7 | 迁移；同批更新消费者 |
| `cls-review-service.ts` | 4 | 迁移；同批更新消费者 |
| `cls-review-store.ts` | 10 | 迁移；同批更新消费者 |
| `cls-sample.ts` | 6 | 迁移；同批更新消费者 |
| `cls-verification.ts` | 5 | 迁移；同批更新消费者 |
| `news-analysis.ts` | 14 | 迁移；同批更新消费者 |
| `news-budget.ts` | 4 | 迁移；同批更新消费者 |
| `news-day.ts` | 2 | 迁移；同批更新消费者 |
| `news-scheduler.ts` | 3 | 迁移；同批更新消费者 |
| `news-sector-history.ts` | 3 | 迁移；同批更新消费者 |
| `news-sector.ts` | 4 | 迁移；同批更新消费者 |
| `news-themes.ts` | 6 | 迁移；同批更新消费者 |
| `theme-price-explanation.ts` | 2 | 迁移；同批更新消费者 |
| `theme-prices.ts` | 5 | 迁移；同批更新消费者 |

### `src/server/portfolio/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `delivery-import-service.ts` | 9 | 迁移；同批更新消费者 |
| `delivery-store.ts` | 11 | 迁移；同批更新消费者 |
| `discipline-service.ts` | 3 | 迁移；同批更新消费者 |
| `discipline-source.ts` | 3 | 迁移；同批更新消费者 |
| `discipline-worker.ts` | 1 | 迁移；同批更新消费者 |
| `execution-quality-service.ts` | 2 | 迁移；同批更新消费者 |
| `holdings-correlation-service.ts` | 2 | 迁移；同批更新消费者 |
| `position-risk-service.ts` | 2 | 迁移；同批更新消费者 |
| `trade-ledger-service.ts` | 7 | 迁移；同批更新消费者 |
| `trade-ledger-store.ts` | 3 | 迁移；同批更新消费者 |
| `trade-review-market.ts` | 5 | 迁移；同批更新消费者 |
| `trade-review-service.ts` | 16 | 迁移；同批更新消费者 |

### `src/server/portfolio/mock/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `mock-trading-service.ts` | 4 | 迁移；同批更新消费者 |
| `mock-trading.ts` | 4 | 迁移；同批更新消费者 |

### `src/server/research/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `a500-research.ts` | 3 | 迁移；同批更新消费者 |
| `index-context.ts` | 2 | 迁移；同批更新消费者 |
| `industry-news-evidence.ts` | 3 | 迁移；同批更新消费者 |
| `market-data.ts` | 9 | 证据组装迁入 gather-evidence.ts；行情访问拆出 |
| `price-rs.ts` | 6 | 迁移；同批更新消费者 |
| `quick-research.ts` | 3 | 迁移；同批更新消费者 |
| `report-history.ts` | 2 | 迁移；同批更新消费者 |
| `report-security.ts` | 3 | 迁移；同批更新消费者 |
| `research-governance.ts` | 8 | 迁移；同批更新消费者 |
| `research-history.ts` | 2 | 迁移；同批更新消费者 |
| `research-method.ts` | 70 | 迁移；同批更新消费者 |
| `research-skills.ts` | 13 | 迁移；同批更新消费者 |
| `research-supermind-store.ts` | 2 | 迁移；同批更新消费者 |
| `research-usage.ts` | 12 | 迁移；同批更新消费者 |
| `research.ts` | 28 | 迁移；同批更新消费者 |
| `rs-alignment.ts` | 1 | 迁移；同批更新消费者 |
| `rs-export.ts` | 3 | 迁移；同批更新消费者 |
| `rs-membership.ts` | 2 | 迁移；同批更新消费者 |
| `universe-audit.ts` | 2 | 迁移；同批更新消费者 |

### `src/server/research/performance/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `period-performance-service.ts` | 5 | 迁移；同批更新消费者 |
| `rolling-performance-service.ts` | 2 | 迁移；同批更新消费者 |
| `strategy-admission-service.ts` | 5 | 迁移；同批更新消费者 |
| `three-segment-sample.ts` | 2 | 迁移；同批更新消费者 |

### `src/server/screening/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `formula-screen-service.ts` | 3 | 迁移；同批更新消费者 |
| `formula-screening.ts` | 3 | 迁移；同批更新消费者 |
| `industry-rps-query.ts` | 3 | 迁移；同批更新消费者 |
| `metrics-cache.ts` | 2 | 迁移；同批更新消费者 |
| `online-screen.ts` | 2 | 迁移；同批更新消费者 |
| `rps-block-source.ts` | 4 | 迁移；同批更新消费者 |
| `rps-client.ts` | 4 | 迁移；同批更新消费者 |
| `rps-engine.ts` | 9 | 迁移；同批更新消费者 |
| `rps-job.ts` | 10 | 迁移；同批更新消费者 |
| `rps-observation-job.ts` | 4 | 迁移；同批更新消费者 |
| `rps-observation.ts` | 11 | 迁移；同批更新消费者 |
| `rps-store.ts` | 27 | 迁移；同批更新消费者 |
| `rps-worker.ts` | 2 | 迁移；同批更新消费者 |
| `screen-cache.ts` | 3 | 迁移；同批更新消费者 |
| `screen-results.ts` | 4 | 迁移；同批更新消费者 |
| `screen-reviews.ts` | 2 | 迁移；同批更新消费者 |
| `screen-wire.ts` | 8 | 迁移；同批更新消费者 |
| `screening.ts` | 21 | 迁移；同批更新消费者 |
| `snapshot-serializer.ts` | 3 | 迁移；同批更新消费者 |

### `src/server/strategies/breakout/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `breakout-batch.ts` | 3 | 迁移；同批更新消费者 |
| `breakout.ts` | 36 | 迁移；同批更新消费者 |

### `src/server/strategies/canslim/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `canslim-as-of-dossier.ts` | 5 | 迁移；同批更新消费者 |
| `canslim-bottom.ts` | 2 | 迁移；同批更新消费者 |
| `canslim-buyback.ts` | 1 | 迁移；同批更新消费者 |
| `canslim-cup.ts` | 6 | 迁移；同批更新消费者 |
| `canslim-dossier.ts` | 6 | 迁移；同批更新消费者 |
| `canslim-entry.ts` | 10 | 迁移；同批更新消费者 |
| `canslim-finance-bundle.ts` | 2 | 迁移；同批更新消费者 |
| `canslim-flat-base.ts` | 7 | 迁移；同批更新消费者 |
| `canslim-follow-through.ts` | 3 | 迁移；同批更新消费者 |
| `canslim-holder-list.ts` | 1 | 迁移；同批更新消费者 |
| `canslim-market-data.ts` | 2 | 迁移；同批更新消费者 |
| `canslim-market.ts` | 4 | 迁移；同批更新消费者 |
| `canslim-method.ts` | 3 | 迁移；同批更新消费者 |
| `canslim-new-high.ts` | 3 | 迁移；同批更新消费者 |
| `canslim-prompt-evidence.ts` | 2 | 迁移；同批更新消费者 |
| `canslim-report-schema.ts` | 3 | 迁移；同批更新消费者 |
| `canslim-report.ts` | 3 | 迁移；同批更新消费者 |
| `canslim-rs.ts` | 2 | 迁移；同批更新消费者 |
| `canslim-saucer.ts` | 5 | 迁移；同批更新消费者 |
| `canslim-scorecard.ts` | 3 | 迁移；同批更新消费者 |
| `canslim-technical.ts` | 2 | 迁移；同批更新消费者 |
| `canslim-volume.ts` | 2 | 迁移；同批更新消费者 |
| `research-canslim-bear.ts` | 1 | 迁移；同批更新消费者 |
| `research-canslim-cup.ts` | 5 | 迁移；同批更新消费者 |
| `research-canslim-failure.ts` | 1 | 迁移；同批更新消费者 |
| `research-canslim-flat.ts` | 5 | 迁移；同批更新消费者 |
| `research-canslim-high.ts` | 3 | 迁移；同批更新消费者 |
| `research-canslim-hold.ts` | 1 | 迁移；同批更新消费者 |
| `research-canslim-market-combination.ts` | 3 | 迁移；同批更新消费者 |
| `research-canslim-market-score.ts` | 7 | 迁移；同批更新消费者 |
| `research-canslim-priority.ts` | 10 | 迁移；同批更新消费者 |
| `research-canslim-saucer.ts` | 5 | 迁移；同批更新消费者 |
| `research-canslim-volume-score.ts` | 3 | 迁移；同批更新消费者 |
| `research-canslim-volume-tier.ts` | 3 | 迁移；同批更新消费者 |
| `research-canslim-volume-wait.ts` | 1 | 迁移；同批更新消费者 |
| `research-canslim-weekly.ts` | 3 | 迁移；同批更新消费者 |
| `research-growth-factors.ts` | 11 | 迁移；同批更新消费者 |
| `research-growth-intraday.ts` | 6 | 迁移；同批更新消费者 |
| `research-sepa.ts` | 4 | 迁移；同批更新消费者 |
| `sepa-stage-support.ts` | 2 | 迁移；同批更新消费者 |
| `sepa-trend.ts` | 3 | 迁移；同批更新消费者 |
| `vcp.ts` | 6 | 迁移；同批更新消费者 |

### `src/server/strategies/chan/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `chan-method.ts` | 8 | 迁移；同批更新消费者 |
| `chan-report-schema.ts` | 3 | 迁移；同批更新消费者 |
| `chan-report.ts` | 3 | 迁移；同批更新消费者 |
| `czsc-input.ts` | 4 | 迁移；同批更新消费者 |
| `czsc-movements.ts` | 2 | 迁移；同批更新消费者 |
| `czsc-research-structures.ts` | 3 | 迁移；同批更新消费者 |
| `czsc-signal-analysis.ts` | 2 | 迁移；同批更新消费者 |
| `czsc-structures.ts` | 5 | 迁移；同批更新消费者 |
| `czsc-worker.ts` | 3 | 迁移；同批更新消费者 |
| `czsc.ts` | 32 | 迁移；同批更新消费者 |
| `research-chan-monthly.ts` | 3 | 迁移；同批更新消费者 |
| `research-chan-movements.ts` | 2 | 迁移；同批更新消费者 |
| `research-chan-zhongyin.ts` | 2 | 迁移；同批更新消费者 |

### `src/server/strategies/sentiment/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `market-sentiment.ts` | 1 | 迁移；同批更新消费者 |
| `tmt-cache.ts` | 3 | 迁移；同批更新消费者 |
| `tmt-crowding.ts` | 4 | 迁移；同批更新消费者 |
| `tmt-margin-update.ts` | 2 | 迁移；同批更新消费者 |

### `src/server/strategies/shared/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `research-protection.ts` | 2 | 迁移；同批更新消费者 |
| `research-rule-series.ts` | 13 | 迁移；同批更新消费者 |
| `research-signals.ts` | 48 | 迁移；同批更新消费者 |
| `research-structure-rs.ts` | 2 | 迁移；同批更新消费者 |
| `research-structure-weekly.ts` | 5 | 迁移；同批更新消费者 |

### `src/server/strategies/value/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `annual-cash-flow.ts` | 2 | 迁移；同批更新消费者 |
| `financial-growth.ts` | 3 | 迁移；同批更新消费者 |
| `financial-quality.ts` | 7 | 迁移；同批更新消费者 |
| `fundamental-dossier.ts` | 4 | 迁移；同批更新消费者 |
| `fundamental-prompt.ts` | 2 | 迁移；同批更新消费者 |
| `fundamental-report.ts` | 3 | 迁移；同批更新消费者 |
| `revenue-reconciliation.ts` | 3 | 迁移；同批更新消费者 |
| `valuation-method.ts` | 6 | 迁移；同批更新消费者 |
| `valuation-scenario.ts` | 4 | 迁移；同批更新消费者 |

### `src/server/strategies/wyckoff/`

| 原文件 | 字面量消费者数 | 处理 |
| --- | --- | --- |
| `research-wyckoff-hourly.ts` | 2 | 迁移；同批更新消费者 |
| `wyckoff-frames.ts` | 7 | 迁移；同批更新消费者 |
| `wyckoff-job.ts` | 2 | 迁移；同批更新消费者 |
| `wyckoff-market.ts` | 3 | 迁移；同批更新消费者 |
| `wyckoff-method.ts` | 5 | 迁移；同批更新消费者 |
| `wyckoff-prompt-frames.ts` | 2 | 迁移；同批更新消费者 |
| `wyckoff-relative-strength.ts` | 4 | 迁移；同批更新消费者 |
| `wyckoff-report-schema.ts` | 2 | 迁移；同批更新消费者 |
| `wyckoff-report.ts` | 4 | 迁移；同批更新消费者 |

### 清点发现与拆分

- 六个被问财适配器与策略共同使用的纯事实转换模块移入 `src/lib/strategy-facts/`，解除供应商层对策略服务的反向引用；不复制计算。
- `market-data.ts` 拆成 `data-sources/tdx/mcp-market-data.ts` 行情访问和 `research/gather-evidence.ts` 研究证据组装。
- `quant.ts` 的筛选 metrics 移入 `src/lib/screening-metrics.ts`；`screening.ts` 的完成时点判断移入 `src/lib/completed-bars.ts`。两者均保持原函数内容与签名。
- `rpsHash` 移入 `infra/content-hash.ts`，供名单读取与 RPS 共用；`evidence.ts` 归 infra，避免供应商层加载研究服务。
- `research-growth-intraday` 仅以类型引用组合输出，GF windmill 仅以类型引用 SkillUse；保留类型引用，不为目录整齐复制类型。
- 迁移前静态本地 import 图发现 `research-usage` / `research-governance` 双向依赖，均保留在 research 域内。动态加载与 type-only 关系另由类型/构建核验，不将静态图宣称为所有运行依赖。

## 8. 实施与验证记录

| 阶段 | 当前事实 | 验证 |
| --- | --- | --- |
| C1/C2 | 已统一 methodId/presetId，收紧证据状态类型，增加缺方向/错误预设/缺实现路径反例 | package 2 文件/5 项通过，typecheck/build 通过；根 typecheck 通过；根测试 463 文件/11,517 项通过、27 跳过，563.61 秒 |
| S0 | 原 308 个根文件已逐项映射，记录 1,980 条源码/测试/脚本字面量消费者引用 | 根保留 runtime 与五个 MCP 保护文件；移交前复核所有路径 |
| S1 | 已迁移 81 个文件并拆出共享职责 | 类型检查通过；1,472 个本地静态引用无缺失；80 个迁移模块主体一致，另一个仅调整 type import 路径；全量 11,517 项通过、27 跳过，523.91 秒 |
| S2 | 已迁移 84 个策略模块，完整方法与参数预设保留 | 类型检查通过；迁移模块主体一致；695 方法审计 errors=[]、reconciliation changes=[]；全量 11,517 项通过、27 跳过，526.72 秒 |
| S3 | 已迁移 47 个回测/研究模块 | 类型检查通过；全量 11,517 项通过、27 跳过，533.97 秒；runtime 重建后 6 文件/13 项 worker 专项通过 |
| S4 | 已迁移剩余 90 个文件，根目录保留 6 个文件；腾讯板块取数归入腾讯适配层 | 类型检查、4 项目录护栏、runtime 重建通过；全量 464 文件/11,522 项通过、27 跳过，522.08 秒 |
| C3 | 研究页新增九方向代表目录，六个已有预设仅填入原表单，三个 method-only 条目无选择按钮；根构建与测试纳入 workspace package | UI 专项 3 项、根 typecheck、package typecheck、应用 build/runtime、desktop:prepare 通过；最终根测试 465 文件/11,525 项通过、27 跳过，553.40 秒；随后 package 2 文件/5 项通过 |
| C4/S5 | 无旧根转发入口或第二份代表目录，受保护路径保留；架构、接续与决策文档已更新 | 静态引用、变更格式、方法审计、453 个本地文档链接和 git diff --check 通过；全仓格式历史问题如下单列 |

C1 修改前后九代表 evidence 序列 SHA-256 均为 `cd92b0bb092d6b246c4c671310cd1f13621f5fd34f1ec0e8b749073d02c718ba`，仅证明登记元数据未改，不表示重验历史 raw。

本轮隔离检查目录为 `.test-data/strategy-refactor-20260922/`，由本轮创建。测试与服务已退出；删除该精确目录的操作被自动审批检查拒绝（`blocked by policy`），未绕过限制，故暂留 589 个文件、179,379,242 字节，清理待后续处理。日志与迁移脚本为临时物，长期结果仅登记在本计划，不建立新档案库。不访问默认生产库，不提交、推送或打包。

### 最终交互与静态核验

- 隔离生产服务使用 `127.0.0.1:43127` 与本轮 app 数据目录；关闭自动分析并指向空行情目录，未连接默认生产库。通过 Chrome DevTools 展开九方向目录并逐一点击六个预设，原研究选择器全部正确变化；数据库复核 research-task/research-result 均为 0。空行情目录引起既有图表缺本地 day 文件提示，属本次隔离输入缺口，不作行情功能通过依据。
- 390px 下页面与九卡片无横向溢出；4 个未回测、2 个 B4 批次未完整状态和 3 个无预设原因可见。控制台 error/warn 均为 0；截图接口 `Page.captureScreenshot` 超时，未反复重试，不登记截图视觉验收通过。已停止本轮服务，验证标签页回到空白。
- 297 个迁移模块去除 import 后主体与迁移前一致；另 5 个仅涉及内联类型路径或已说明职责拆分，8 个抽取声明逐项一致；1,472 个静态本地引用无缺失。method audit：695 方法、22 implemented / 673 variant、errors=[]、reconciliation changes=[]。
- 本轮 751 个变更代码文件格式通过。全仓 `pnpm format:check` 退出 1，仅 `src/lib/research-execution.ts`、`research-position-book.ts`、`research-pyramid.ts` 三个未改动文件存在历史格式问题；逐个核对与 HEAD 一致且 HEAD 本身未通过格式检查，未混入无关格式修改。
- `mcp.ts` SHA-256 保持 `84298d84a2d5b33e43d0cc8ac7a9d011dc535ec6d368c60c5640e30cb10560b0`，其 UI、数据库 schema/migrations 与来源锁无差异。依赖安装初次遇到本机离线缓存不全；补齐 workspace 锁定引用后 `pnpm install --frozen-lockfile --offline --ignore-scripts` 通过，未新增外部依赖。

2026-09-22 后续授权：用户明确要求本地 commit，本次重构与验收文档纳入同一提交；不推送、不打包，隔离临时目录不纳入 Git。

## 9. 共享纯策略核心层（2026-09-22）

用户追加要求：交易策略运行实现不能因为独立 package 而继续依赖 `src/lib` 的纯工具，也不能把数据库、文件系统、环境变量、Next.js、数据源或 DLL 一并抽进 package。执行结果如下：

- 新增 `packages/trading-strategy-core`，只承载无环境副作用的 K 线基础类型、完成 K 线截止判定和 Big.js 金额/费率/数量运算。
- `src/lib/domain.ts`、`src/lib/completed-bars.ts`、`src/lib/money.ts` 保留应用兼容导出，但实现已移到核心包；策略服务对应调用点直接依赖 `trading-strategy-core`。
- `packages/trading-strategies` 继续只负责九方向代表目录和证据元数据，不与核心包合并；完整运行编排仍在 `src/server/strategies`。
- 纯指标算法已迁入核心包；研究规格、数据库和 DLL 相关模块未整块迁移，它们仍含应用边界或研究状态，后续按同一纯度规则逐模块抽取，不能仅按文件名批量搬迁。

本次验证：核心包独立 typecheck/build/test 通过（2 项）；代表目录 package 的 test/typecheck/build 通过（5 项）；根 `pnpm typecheck` 通过；根受影响回归 `tests/screening.test.ts` 与 `tests/indicators.test.ts` 通过（30 项）。
