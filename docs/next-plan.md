# 个人交易工作台扩充计划

## 本地分批提交（2026-09-29）

用户已授权将此前优化分批提交。代码与测试已按公共缓存、行情、选股、回测、工作台、信号监控、新闻复盘、交易对账及跨模块契约拆分为九批（`863a082` 至 `a6dff68`），本节及模块文档作为第十批收尾。各批存在共享路由、类型和组件依赖，验收针对完整提交序列，不宣称每个中间提交独立通过全套测试。

本轮未改业务代码，重新运行 typecheck 和 diff 检查通过；复核此前全量 11738 项及 package 7 项、build/runtime、desktop:prepare 的通过记录。下方“未提交”是各阶段交付时的历史状态，以本节为准。未推送、打包或发布。`scripts/_gen-ths.ts`、`scripts/_trbench.ts` 和 `server-wb.log` 保留在工作区，作为临时脚本及日志未纳入提交。受保护的 MCP 文件与文案未纳入差异；成交执行质量仍仅完成计划。

## 下一模块规划：成交执行质量（2026-09-29，仅计划）

按用户最新要求，下一份单模块 plan 聚焦 `/trade-review` 的执行质量：筛选与覆盖摘要 → 逐笔价格/单位/费用依据 → 分组下钻与批次返回 → 全账户反事实解释 → 同版本完整导出。已核对当前源码、近期提交、Claude 原计划，并在线调研 IBKR Arrival Price、QuantConnect LEAN 源码与 pyfolio 滑点分析。保留 U4/W11/W12 的 VWAP、倍率、缺失传播和反事实边界；不扩展模型或交易能力。

完整方案见[成交执行质量专项计划](C:/Users/jm/Documents/Codex/2026-09-29/nextjs-quant-execution-quality-optimization-plan.md)：E0 基线与契约 → E1 查询与追溯 → E2 阅读与恢复 → E3 综合验收，同时验收功能、性能、UX。执行质量仅规划，未修改其业务代码。现金模块随后已完成下方工程验收；继续保持一次只实施一个模块。

现金交付后按最新请求再次复核同一份计划，补充IBKR TCA精确筛选下钻与AG Grid键盘示例。明确复用replayInput来源hash/原始行号，持久成交ID用于刷新定位；手动刷新须真正更新服务端目标账户快照，不能只调用前端refetch。补齐同账户导出途中改筛选、TTL到期/外部变更重建峰值及隔离压力fixture验收。仍仅规划，实施从E0基线开始。

## 已完成模块：现金对账与差异追溯（2026-09-29，Q0—Q3工程验收完成）

用户要求继续制定一个模块的同类 plan。本轮限定 `/trade-review` 的现金核对：覆盖与差异摘要 → 日期/状态检索 → 来源及逐行证据 → 完整导出与返回定位，功能、性能、UX 同时验收。已核对当前源码、Claude 原计划，并在线查阅 Actual Budget 对账文档及固定版本 Reconcile.tsx、Portfolio Performance 文档。保留现有分精度比较、缺失/冲突和独立现金重放；不增加自动平账或改动 NAV。

完整方案见[现金专项计划](C:/Users/jm/Documents/Codex/2026-09-29/nextjs-quant-cash-reconciliation-optimization-plan.md)。摘要/日期筛选、分层证据、版本一致导出、批次返回和失败恢复已完成。最终全量11738项及package7项通过，27项既有跳过；typecheck/build/runtime/desktop:prepare通过。构建1_x6zbkvfdeGvU8260ZE0完成三宽度、迟到响应、真实外部改写/撤销、Blob失败恢复、万日期/千来源/两万行完整遍历及40万行导出。

同fixture首20日期响应1.52MB→3.36KB、暖HTTP P95约126ms→8ms、DOM20432→314；万日期筛选/翻页/返回P95约271/254/41ms。五进程冷账户最大2.499秒，筛选最大1.923秒保留，不能只以P95代表每次体验。受控隐藏及真实离页各60秒零模块读取、内存与四类负对照通过；原生最小化窗口未触发hidden的环境限制明确披露。两隔离库事实与配置恢复原hash，自有服务退出，既有修改和MCP保全。完整证据、失败轮次及合成样本限制见[交付说明](C:/Users/jm/Documents/Codex/2026-09-29/nextjs-quant-cash-reconciliation-delivery.md)及[实施记录](C:/Users/jm/Documents/Codex/2026-09-29/nextjs-quant-cash-reconciliation-progress.md)。未提交、推送、打包、通知或交易。

## 已完成模块：交割单导入与批次核对（2026-09-29，D0–D3工程验收完成）

三步导入、冻结身份与事务复验、真实收据、批次摘要分页、按需证据、完整导出和撤销影响核对已完成。保留原有幂等、冲突回滚、脱敏与记录所属批次规则。响应丢失/原文件删除、迟到预览、会话逐出/服务重启、外部撤销刷新、末页恢复和列表失败后的收据保留均有验证。

全量11726项及package7项通过；最终typecheck/build/runtime/desktop:prepare通过。性能构建 `oWWZO3EvnTaCOGqTMnjCX`：万批列表HTTP P95约192ms、万行预览562ms、确认入库1228ms；混合万行筛选/翻页/返回203/115/99ms。大证据完整导出、内存释放、五次冷服务、隐藏/离页零模块读取及负对照通过。末轮补10000批次完整遍历8项定向回归与确认框取消焦点修复，最终构建 `dWt7Nf8-vwn7irDemKibj` 的相关浏览器复验通过。完整数字与限制见[交付说明](C:/Users/jm/Documents/Codex/2026-09-29/nextjs-quant-delivery-import-delivery.md)，各轮故障和恢复见[进度记录](C:/Users/jm/Documents/Codex/2026-09-29/nextjs-quant-delivery-import-progress.md)，[原计划](C:/Users/jm/Documents/Codex/2026-09-29/nextjs-quant-delivery-import-optimization-plan.md)保留。

交割单交付时未提交、推送、打包、发送通知或交易。接续现金对账已完成Q0—Q3工程验收，详见上方交付记录；下一执行质量仅规划。

## 已完成模块：本地交易账本（2026-09-29，P0–P3工程验收完成）

按用户最新要求，下一份单模块计划限定为 `/trade-ledger`，覆盖持仓阅读、完整交易检索、原始依据、独立录入草稿与保存核对，同时制定性能和 UX 验收；不扩展 `/trade-review` 或新增交易能力。已核对当前源码、近期提交、Claude 原计划，并在线参考 Portfolio Performance 文档及 TransactionsViewer 源码、Ghostfolio 官方仓库。完整方案见[本地交易账本专项计划](C:/Users/jm/Documents/Codex/2026-09-29/nextjs-quant-trade-ledger-optimization-plan.md)：P0 基线 → P1 查询 → P2 功能与交互 → P3 性能与交付。

新页面、完整历史与证据、独立草稿/冻结提交/恢复、定向刷新已实现。全量11708项及package7项通过；最后摘要反馈调整后定向7文件37项、typecheck、build/runtime、desktop:prepare及八组最终生产浏览器通过。最终HTTP历史P95约144ms、持仓421ms，筛选/翻页/返回127/146/136ms，1MiB依据374ms；五轮冷服务历史首屏约1.79秒、完整持仓2.10秒。隐藏/离页零模块读取、完整导出、内存与四类负对照通过。45122条五张事实表记录恢复，配置及测试记录清理，自有3226/3227退出，既有工作/MCP保全。结果、测量范围和限制见[交付说明](C:/Users/jm/Documents/Codex/2026-09-29/nextjs-quant-trade-ledger-delivery.md)，过程见[实施记录](C:/Users/jm/Documents/Codex/2026-09-29/nextjs-quant-trade-ledger-progress.md)。未提交、推送、打包或真实模拟交易；下一交割单模块仅规划。

## 已完成模块：策略监控与通知投递（2026-09-29，S0–S3工程验收完成）

用户已授权按plan优化 `/signals`：独立订阅草稿与编辑、完整信号/投递历史、多渠道结果及人工重发追溯，同时验收功能、性能和 UX。方案见[专项计划](C:/Users/jm/Documents/Codex/2026-09-29/nextjs-quant-signals-optimization-plan.md)。S0基线、S1摘要/分页/详情及v12索引、S2页面与动作已实现，1000/10000/50000条完整遍历通过；草稿竞态、确认响应丢失后同requestId重试、完整导出、窄窗和错误恢复已获生产浏览器证据。审计追加修复后台监控默认只取200条的问题，1000个启用订阅均建基线且不补发。最终全量11698项及package7项通过；最后窄窗调整定向11项、typecheck、build/runtime、desktop:prepare及六份生产浏览器验证通过。HTTP列表P95约5–12ms、关联26ms，交互约125/146/110ms；正文296ms。隐藏/离页、完整导出和缓存释放通过，61003业务记录恢复，自有3225服务退出；既有改动及MCP保全。完整结果见[交付说明](C:/Users/jm/Documents/Codex/2026-09-29/nextjs-quant-signals-delivery.md)。详细数字及失败轮次见[实施记录](C:/Users/jm/Documents/Codex/2026-09-29/nextjs-quant-signals-progress.md)；未发送真实通知。

上一模块 `/cls-review` 已补齐最终构建复测、隔离数据恢复和自有服务退出证据，完成情况如下。`/signals`与本地交易账本均已完成；顶部交割单模块已开始 D0 基线核验。

## 已完成模块：财联社观点复盘（2026-09-29，C0–C3工程验收完成）

范围为 `/cls-review`：报告检索和完整阅读、报告绑定草稿与事实历史、样本资格与价格版本、可见性和按需查询。原选样、统计和调度口径保留。全量11676项及package7项、最终专项15项、typecheck/build/runtime/desktop:prepare通过；压力HTTP报告/事实/核对P95约138/134/107ms、汇总243ms；近2MiB原文打开888ms，完整导出10000事实。隐藏/离页、保存竞态、失败恢复、负对照和完整历史已有证据。隔离22000条CLS记录恢复，自有3224服务退出，既有改动及MCP保全。未提交、推送或打包，真实报告人工验收未声称完成。完整证据和限制见[交付说明](C:/Users/jm/Documents/Codex/2026-09-29/nextjs-quant-cls-review-delivery.md)，原[计划](C:/Users/jm/Documents/Codex/2026-09-29/nextjs-quant-cls-review-optimization-plan.md)保留。

## 已完成模块：新闻存档与分析（2026-09-29，N0–N3工程验收完成）

N0–N3完成：摘要/原文、完整历史、页面冻结身份、版本预检和阅读恢复已实现；React #418首屏时间差异已修复。全量11669项及package7项通过，末轮SQL/可见性改动再跑定向23文件74项、typecheck、build/runtime、desktop:prepare和生产浏览器。1万新闻全文HTTP P95约100–102ms，1000档案约60–63ms，浏览器筛选/翻页约105/99ms。四负对照、隐藏/离页/空闲60秒零读取、百万字符完整导出、1000结果分页和内存样本已记录。隔离数据恢复，自有服务关闭；未提交、推送或打包，不并行启动下一模块。完整结果和限制见Documents同目录 `nextjs-quant-news-delivery.md`。

用户最新要求继续制定下一个模块的同类 plan。已完成 `/news` 专项规划，覆盖检索与原文阅读、全历史分析档案、分析范围与冻结输入一致性、取消/续作反馈、证据导出、按需装载和可见性刷新。已查看当前源码、Claude 原计划及 Inoreader/FreshRSS 官方资料与源码；不扩展独立 `/cls-review`、采集器或模型算法。

完整计划：`C:/Users/jm/Documents/Codex/2026-09-28/nextjs-quant-news-optimization-plan.md`。N0 基线与契约 → N1 查询与完整历史 → N2 阅读与分析 UX → N3 性能与交付。用户已授权按plan实施；198项工作区基线保留，隔离fixture、SQL/HTTP与浏览器证据位于TEMP日志目录，正式过程记录位于Documents同目录。延用同一份计划，不另建重复规格；本轮只推进新闻模块，不扩展其他模块。

## 已完成模块：信号台账（2026-09-28，L0–L3工程验收完成）

用户最新要求对下一个模块制定同样的 plan。本轮只规划 `/signal-ledger`：完整历史检索、结果状态解释、任务与通知决策追溯、证据阅读导出，并同时覆盖性能和 UX。已核对当前源码、近期提交、Claude 原计划，并在线参考 TradingView 警报日志、MLflow 查询源码及 TanStack Query 焦点刷新文档。

完整计划：`C:/Users/jm/Documents/Codex/2026-09-28/nextjs-quant-signal-ledger-optimization-plan.md`。L0 基线与契约 → L1 历史与状态闭环 → L2 阅读与证据 UX → L3 性能与交付。实施前确认的最近100条/30日可达性限制、无条件整页轮询及全量装载路径已处理，前后测量见交付说明。保留向前观察、首次到期结果固定、V3 信息含量口径和零外发边界。

用户已授权按plan实施。UI专用摘要/列表/详情/分析读取、完整历史分页、取消准确反馈及按需证据已接入；相关回归和生产浏览器首轮通过。1万条列表HTTP P95约55–76ms，全样本分析约295ms，最终11663项及package7项通过，typecheck/build/runtime/desktop:prepare成功；生产浏览器完整交互、任务结束详情刷新、键盘与失败恢复通过。最终筛选/翻页P95约76/80ms，百万字符导出完整、隐藏与离页零读取、内存样本已记录。完整结果及限制见 Documents 同目录 `nextjs-quant-signal-ledger-delivery.md`，过程记录另见 progress。隔离数据已恢复，自有服务已关闭。

盘中预选收尾后已复核台账基线，计划中的取消四种结果、投递决策完整分页、日历不足时禁用快捷范围均已实现。全样本分析与列表筛选分开标示，原始证据不写入持久缓存；未提交、推送或打包。

## 上一模块：盘中预选（2026-09-28，I0–I3 工程验收完成）

用户已授权按 plan 实施，范围为 `/intraday` 的配置生效、午盘/尾盘执行、候选阅读、收盘核对和证据导出。功能、性能、UX 同时推进；其它模块不排期。

已完成参数草稿/生效分离、元数据分页与全范围统计、完整批次历史、按需证据与返回定位、可见性刷新，以及上一交易日RPS时点约束。全量11659项及package7项通过，最终typecheck/build/runtime/desktop:prepare通过；生产浏览器含121批次、保存竞态、完整导出、清理保护、三个宽度及隐藏/恢复检查通过。1万条HTTP全部/筛选/翻页P95约177/178/182ms，浏览器筛选/翻页约76/66ms。完整数字、失败轮次、验证范围见 Documents 同目录 `nextjs-quant-intraday-delivery.md`。

已核对源码、近期提交、现有工作区和 Claude 原计划，并联网调研 TradingView Screener、QuantConnect Scheduled Events 与 VeighNa EventEngine 源码。当前页统计、候选定义、草稿与实际配置、混合核对状态及历史定位问题已处理。SQL前后对照、真实HTTP、受控旧UI浏览器对照与4项负对照已记录；不把合成输入验证等同实源交易窗口表现。

完整计划：`C:/Users/jm/Documents/Codex/2026-09-28/nextjs-quant-intraday-optimization-plan.md`。I0基线与契约、I1功能闭环、I2交互与证据、I3性能与交付已完成。保留5分钟窗口、错过不回放、证据不可覆盖、数据不足与撤销区分、单宿主串行DLL约束。迁移v11增加两个覆盖索引，旧exe不能打开升级后的库；未迁移默认生产库，未提交、推送或打包。

## 已完成模块：研究档案（2026-09-28，A0–A3 工程验收完成）

用户先要求对下一个模块制定同样的 plan，随后授权按计划实施。本轮只优化研究档案 `/reports`：统一通用研究、CAN SLIM、缠论、威科夫四类报告的检索、完整历史分页、详情阅读与返回定位；估值和财务质量保留既有独立区域，不扩展其计算或生产流程。

已核对当前源码、历史测试、任务中心交付与 Claude 原计划，确认方法历史存在 `LIMIT 100` 可达性上限；通用报告已有摘要分页和证据导出，直接复用。调研 Zotero 官方检索说明、MLflow Tracking 与 SearchUtils 开源实现，采用明确搜索范围、稳定分页、版本与产物追溯；性能疑点先测量，不预报收益。

完整计划：`C:/Users/jm/Documents/Codex/2026-09-28/nextjs-quant-research-archive-optimization-plan.md`。A0 基线与契约、A1 检索与完整历史、A2 阅读与恢复 UX、A3 性能与交付已完成。全量11654项通过；最后查询/日期收口另跑9文件36项、typecheck、build、desktop:prepare及生产浏览器验收。1万条最终SQL筛选P95约76ms、真实HTTP约68ms；筛选/翻页交互约25/31ms，隐藏60秒零列表请求。完整证据保持导出，持久缓存不再携带大正文。完整结果、波动轮次与全仓库格式检查的范围外告警见同目录 `nextjs-quant-research-archive-delivery.md`。其它模块不排期，未提交、推送或打包。

## 已完成模块：任务中心（2026-09-28，J0–J3 工程验收完成）

用户先要求制定同样的 plan，随后授权实施。本轮只优化 `/tasks`：找到任务 → 判断状态与进度 → 处理失败或取消 → 查看实际结果；功能、性能与 UX 同时验收。数据与连接已完成上一轮交付，其它模块继续不排期。

已核对现有 UI、jobs/taskHistory/taskState/cancel API、SQL 投影、取消与重启恢复、相关测试；调研 Prefect 状态及源码、Dagster 任务列表/详情、TanStack Query 与 WAI-ARIA 官方说明。发现最近 80 条统计范围、摘要与列表刷新不一致、重新发起文案与实际入口不符等问题；上述问题已按本计划实现与验收，测量记录见交付说明。

完整计划：`C:/Users/jm/Documents/Codex/2026-09-28/nextjs-quant-task-center-optimization-plan.md`。阶段为 J0 基线与规格 → J1 状态与查询闭环 → J2 UX 与恢复路径 → J3 性能与综合验收。保留现有本机队列；不引入自动重试、暂停续跑或调度平台；仅提供来源页重新配置入口，不直接重放研究/外部任务。当前已完成基线、状态与查询闭环、交互恢复、性能对照及工程验收；结果与限制见 Documents 同目录 `nextjs-quant-task-center-delivery.md`。

## 上一模块：数据与连接（2026-09-28，功能、性能与 UX 验收完成）

用户最新要求：一次只对一个模块深入优化，功能、性能、UX 交互设计同时考虑，并结合网络调研学习竞品和开源项目。此前 O0–O6 多模块推进表取消；当时其它模块均未启动。当前接续范围见顶部唯一规划模块。

上一轮范围为 /settings 的数据与连接闭环：了解来源与可用性 → 配置 → 保存 → 只读诊断 → 恢复 → 验证生效。新闻/模型只处理必要的配置归属和状态呈现，其业务、通知和数字货币独立行为不扩展。

已查看 TradingView 官方数据来源说明、Grafana 诊断文档与 DataSourceWithBackend 源码、OpenBB Fetcher 源码与标准模型说明。采用来源/时点明确、分层诊断、摘要与详情分离和统一诊断输出；复用当前数据适配器与健康判断，不照搬外部架构。完整调研、来源链接及验收矩阵位于用户 Documents/Codex/2026-09-28/nextjs-quant-phase2-optimization-plan.md。

| 主线 | 设计与验收 |
| --- | --- |
| 功能 | 配置归属、保存生效、只读检查、数据时点、失败恢复、旧响应竞态。 |
| 性能 | 先测首屏/交互/请求/诊断基线，按证据优化，保留同环境前后对照。 |
| UX 交互设计 | 先任务流程与线框；信息层级、保存入口、表单分组、状态反馈、恢复动作、键盘与窄窗共同验收。 |

模块内顺序：基线与 UX 规格 → 配置闭环 → 诊断闭环 → 性能和交互细节 → 综合验收。三条主线均闭环后才交付本模块，不在中途切换其他模块。未知状态不得包装成健康，fixture 不冒充实源验证；保留既有改动和保护文件。提交、推送、打包仍需对应授权。

## 逐模块优化接续（2026-09-28）

用户授权接替 Claude，沿其 `iridescent-swinging-biscuit.md` 计划继续。此前已授权持续推进，故不再按旧计划逐模块停下等待；提交、推送、打包仍单独授权。本批按现有瓶颈收口，不将“极致优化”解释为无限扩展。

| 模块 | 本批范围与接续状态 |
| --- | --- |
| 行情与图表 | 保留 Claude 的生命周期拆分、键位、分时、画线编辑和叠加对比；复查相关回归。多图布局、跨周期画线不在本批。 |
| 工作台/总览 | 保留查询持久化节流、按页面轮询、总览行情条。 |
| 选股/RPS | 保留日线解码、预读和 RPS 批量发布；多核公式池仍待架构决策。 |
| 策略信号 | 保留 CZSC 按需返回表，维持原生单进程串行边界。 |
| 研究回测 | 保留收益率/回撤图、任务轮询及过拟合计算优化。 |
| 组合台账 | 接完计算索引和快照复用；缓存按数据库、账户、导入批次、设置隔离，60 秒到期，最多保留 4 个账户；失败不缓存。 |
| 新闻 | 关键词提交后查询，刷新避免旧条件重复请求；未提交的关键词不启动分析。 |
| 公共 UI | 共享表格增加键盘排序说明，稳定列适配结果；保留服务端排序分页和加载/失败语义。 |

模块维护说明与取舍分别见 `docs/modules/` 和 `decisions.md`。验收数字记录在本次交付说明；真实模型分析、通知、交易及打包未执行。旧 `vt-4a.tmp` 已不在工作区，后台退出码只代表日志筛选结束；本次用逐用例日志重新验证，不把旧记录视为全量测试通过。

## 模块重构整理（2026-09-23，用户已授权执行）

执行范围、边界和阶段验收见[模块重构计划](project-module-reorganization-plan.md)。R0—R6 已完成：建立[模块地图](modules/README.md)及 13 份模块文档；186 个 tRPC procedure 按领域拆入 10 个 router；纯规则移入 `src/lib` 领域目录；快照、选股和回测用例归各自服务端模块，`runtime.ts` 收为生命周期/定时调度入口；页面与组件按领域归位，测试按模块归档并加目录护栏。保留全部 procedure 名称、worker 输出名和原有测试发现数。保护中的 `src/server/mcp.ts` 未移动或修改。验证记录在交付说明，不写入长期阶段状态。

## 策略整理接续（2026-09-22）

九方向代表 package 与 2026-09-21 清理已有登记；当前新增 C1—C4 重构阶段，先收紧 method/preset 与证据契约，再核对来源并安排应用只读接入。具体范围、验收与状态见 [策略整理计划](strategy-consolidation-plan.md#5-后续重构阶段2026-09-22)；追加 [server 分域整理 S0—S5](strategy-consolidation-plan.md#6-srcserver-按职责整理2026-09-22-追加)，涵盖策略、数据源、回测及其他业务域。用户随后授权“执行 plan”；C1—C4 与 S0—S5 已完成，服务端分域与代表目录接入研究页均通过验收。根测试 11,525 项、package 5 项通过，typecheck/build/runtime 通过；浏览器六预设切换与 390px 布局通过，全仓格式仍有 3 个未改文件的历史问题，实际检查及限制见整理计划 §8。历史回测事实仍见 [结果登记](strategy-results-consolidated-2026-09-21.md)，不由目录整理升级证据等级。


## 归档

2026-09-17 及更早的阶段（C5/B 系列接续、每日工作流、E/U/V/W 系列里程碑、tstdx）已原样移到 [archive/next-plan-2026-09-17-and-earlier.md](archive/next-plan-2026-09-17-and-earlier.md)。
